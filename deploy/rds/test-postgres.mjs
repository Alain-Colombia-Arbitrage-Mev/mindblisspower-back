import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (!args.includes('--synthetic-docker') || args.some(arg => !['--synthetic-docker', '--with-api-tests'].includes(arg))) {
  throw new Error('Requires --synthetic-docker [--with-api-tests]; external databases are never accepted');
}
const name = `mindbliss-rds-drill-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
let created = false;
function docker(args, input, expected = 0) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return result.stdout.trim();
}
function sql(database, input) {
  return docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', database,
    '-v', 'ON_ERROR_STOP=1', '-f', '-'], input);
}
const migration = await readFile(new URL('../../_meta/migration/05_postgresql.sql', import.meta.url), 'utf8');
const refresh = await readFile(new URL('../../_meta/migration/05_postgresql_refresh.sql', import.meta.url), 'utf8');
try {
  docker(['run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
    '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=mindbliss_qa',
    'mindbliss/rds-postgres-test:20261024']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const result = spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { encoding: 'utf8' });
    if (result.status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error(`Synthetic schema failed to initialize: ${docker(['logs', name])}`);
  assert.equal(sql('mindbliss_qa', "SELECT count(*) FROM pg_extension WHERE extname='timescaledb';"), '0');
  assert.equal(sql('mindbliss_qa', "SELECT extversion FROM pg_extension WHERE extname='ltree';"), '1.2');
  assert.equal(sql('mindbliss_qa', 'SELECT count(*) FROM mlm.person;'), '2');
  if (args.includes('--with-api-tests')) {
    // Share only this new DB's isolated network namespace; no published ports.
    const url = `postgres://postgres:${password}@127.0.0.1:5432/mindbliss_qa?sslmode=disable`;
    const output = docker(['run', '--rm', '--network', `container:${name}`,
      '-e', `DATABASE_URL=${url}`, '-e', `TEST_DATABASE_URL=${url}`, '-e', 'NODE_ENV=test',
      '-e', 'BETTER_AUTH_SECRET=synthetic-test-secret-not-for-production',
      'mindbliss/rds-api-test', 'sh', '-ec',
      'bun test src/server/reporting.test.ts src/server/alerts.persistence.test.ts src/server/plan-config.persistence.test.ts 2>&1']);
    assert.match(output, /4 pass/);
    assert.match(output, /0 fail/);
    assert.doesNotMatch(output, /\d+ skip/);
    assert.equal(sql('mindbliss_qa', 'SELECT count(*) FROM mlm.person;'), '2', 'API persistence fixtures must roll back');
    console.log(`PASS: all four API persistence tests ran against disposable PostgreSQL.\n${output}`);
  }
  // Full QA schema initialized on vanilla Postgres; now test populated migration separately.
  sql('postgres', 'CREATE DATABASE reporting_contract TEMPLATE template0;');
  sql('reporting_contract', `CREATE EXTENSION ltree; CREATE SCHEMA mlm; CREATE SCHEMA audit;
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,parent_id bigint,side text,unavailable boolean,path ltree);
    INSERT INTO mlm.affiliate VALUES(101,NULL,NULL,false,'n101'),(102,101,'L',true,'n101.n102'),
      (103,101,'R',false,'n101.n103'),(104,102,'R',false,'n101.n102.n104');
    CREATE TABLE mlm.wallet_movement(id bigint PRIMARY KEY,affiliate_id bigint,concept_id integer,amount numeric(20,8),posted_at timestamptz);
    INSERT INTO mlm.wallet_movement VALUES
      (1,102,11,100,'2026-10-01T00:30:00Z'),(2,102,11,-20,'2026-10-01T01:00:00Z'),
      (3,103,11,50,'2026-09-30T23:30:00Z');
    CREATE TABLE mlm.tree_event(id bigint PRIMARY KEY,kind text,occurred_at timestamptz,pv_delta_left numeric,pv_delta_right numeric);
    INSERT INTO mlm.tree_event VALUES(1,'enrollment','2026-10-01T00:30:00Z',0,0),
      (2,'pv_credit','2026-10-01T01:30:00Z',10,20);
    CREATE TABLE audit.activity_log(id bigint PRIMARY KEY,occurred_at timestamptz);
    INSERT INTO audit.activity_log VALUES(1,'2016-01-01T00:00:00Z');
    GRANT USAGE ON SCHEMA mlm TO app_read,app_write,app_admin;`);
  const fingerprint = `SELECT jsonb_build_object(
    'positions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM mlm.affiliate a),
    'ledger',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM mlm.wallet_movement w),
    'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM mlm.tree_event e),
    'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit.activity_log a),
    'tables',(SELECT jsonb_agg(jsonb_build_array(oid,relfilenode) ORDER BY oid) FROM pg_class
      WHERE oid IN ('mlm.affiliate'::regclass,'mlm.wallet_movement'::regclass,'mlm.tree_event'::regclass,'audit.activity_log'::regclass)));`;
  const before = sql('reporting_contract', fingerprint);
  sql('reporting_contract', migration);
  sql('reporting_contract', migration);
  assert.equal(sql('reporting_contract', fingerprint), before, 'migration changed financial rows, positions or table identities');
  assert.equal(sql('reporting_contract', "SELECT count(*) FROM pg_matviews WHERE schemaname='mlm' AND NOT ispopulated;"), '3');
  sql('reporting_contract', `SET TIME ZONE 'Pacific/Honolulu';\n${refresh}`);
  assert.equal(sql('reporting_contract', "SELECT count(*) FROM mlm.mv_earnings_monthly WHERE month='2026-10-01T00:00:00Z' AND net_amount=80;"), '1');
  assert.equal(sql('reporting_contract', 'SET ROLE app_read; SELECT sum(total) FROM mlm.mv_ledger_volume_daily;'), '130.00000000');
  assert.equal(sql('reporting_contract', "SELECT total_pv_volume FROM mlm.mv_network_growth_daily WHERE day='2026-10-01T00:00:00Z';"), '30');
  sql('reporting_contract', refresh); // Second refresh uses CONCURRENTLY.
  sql('reporting_contract', migration); // Reapplying must not empty populated reporting.
  assert.equal(sql('reporting_contract', "SELECT count(*) FROM pg_matviews WHERE schemaname='mlm' AND ispopulated;"), '3');
  assert.equal(sql('reporting_contract', fingerprint), before);
  console.log('PASS: full vanilla PG17 schema, populated/idempotent migration, UTC reports, read-role grants, initial/concurrent refresh, ledger and banned tree positions preserved.');
} finally {
  assert.match(name, /^mindbliss-rds-drill-[a-f0-9]{12}$/);
  if (created) docker(['rm', '-f', '-v', name]);
}
