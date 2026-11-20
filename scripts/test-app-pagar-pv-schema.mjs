import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const container = 'mb-app-pagar-pv-' + randomUUID();
const database = 'mindbliss_curated_20261025';
const runtime = 'mindbliss_auth_core_v1';
const owner = 'pagar_pv_test_owner';
const observer = 'pagar_pv_test_observer';
const image = 'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
const psql = ['exec', '-i', container, 'psql', '-X', '-w', '-qAt', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'];
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', shell: false });
const as = (role, source) => (role ? 'SET ROLE ' + role + ';' : '') + source;
const literal = value => value === null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";

function query(source, role) {
  const result = docker(psql, as(role, source));
  if (result.status !== 0) throw Error(result.stderr || result.error?.message || 'isolated query failed');
  return result.stdout.trim();
}

function rejects(source, role, expected) {
  const result = docker(psql, as(role, source));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, expected);
}

function concurrent(source, role) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', psql, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', status => status === 0 ? resolve(stdout.trim()) : reject(Error(stderr)));
    child.stdin.end(as(role, source));
  });
}

function activate(id, subject, affiliate, pv, depth, idempotent = false) {
  return 'INSERT INTO payments.app_pagar_investment(payment_id,subject,affiliate_id,pv_delta,plan_snapshot,starts_at) VALUES(' +
    [id, subject, affiliate, pv, JSON.stringify({ depth_cap: depth }), '2026-11-20T12:00:00Z'].map(literal).join(',') + ')' +
    (idempotent ? ' ON CONFLICT(payment_id) DO NOTHING' : '') + ';';
}

function points(subject, session = subject + ':session') {
  return query("SELECT concat_ws('|',own_pv,left_pv,right_pv) FROM payments.read_app_pagar_points_v1(" +
    [subject, session].map(literal).join(',') + ');', runtime);
}

function ranks(subject, session = subject + ':session') {
  return query("SELECT concat_ws('|',rank_code,prize_usd_minor,status) FROM payments.read_app_pagar_rank_entitlements_v1(" +
    [subject, session].map(literal).join(',') + ');', runtime);
}

const source = `
CREATE ROLE ${runtime} NOLOGIN;
CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE ${observer} NOLOGIN;
CREATE SCHEMA payments;
CREATE SCHEMA identity;
CREATE SCHEMA mlm;
GRANT USAGE ON SCHEMA payments TO ${runtime},${owner},${observer};
CREATE TABLE payments.app_pagar_investment(
  payment_id uuid PRIMARY KEY, subject text NOT NULL, affiliate_id bigint,
  pv_delta numeric(24,0) NOT NULL, plan_snapshot jsonb NOT NULL, starts_at timestamptz NOT NULL
);
ALTER TABLE payments.app_pagar_investment OWNER TO ${owner};
CREATE TABLE payments.app_pagar_economic_hold(payment_id uuid PRIMARY KEY);
ALTER TABLE payments.app_pagar_economic_hold OWNER TO ${owner};
CREATE FUNCTION payments.reject_app_pagar_accounting_mutation() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN RAISE EXCEPTION 'app_pagar_accounting_immutable'; END $f$;
CREATE TABLE mlm.affiliate(
  id bigint PRIMARY KEY,person_id bigint NOT NULL UNIQUE,parent_id bigint REFERENCES mlm.affiliate(id),
  position text,status text NOT NULL,left_pv_lifetime bigint NOT NULL DEFAULT 100,
  right_pv_lifetime bigint NOT NULL DEFAULT 200,current_rank_id integer NOT NULL DEFAULT 2
);
CREATE TABLE mlm.affiliate_closure(
  ancestor_id bigint NOT NULL,descendant_id bigint NOT NULL,distance integer NOT NULL,
  PRIMARY KEY(ancestor_id,descendant_id)
);
CREATE TABLE mlm.rank(id smallint PRIMARY KEY,code text NOT NULL,required_points numeric NOT NULL,bonus_amount_usd numeric(14,2) NOT NULL);
INSERT INTO mlm.rank VALUES(1,'BRONZE',20,100.01),(2,'SILVER',25,200.09),(3,'GOLD',40,500.00);
INSERT INTO mlm.affiliate(id,person_id,parent_id,position,status) VALUES
  (1,101,NULL,NULL,'active'),(2,102,1,'L','active'),(3,103,2,'R','active'),
  (4,104,3,'L','active'),(5,105,3,'R','active'),
  (6,106,2,'L','pending'),(7,107,6,'R','active');
WITH RECURSIVE nodes(ancestor_id,descendant_id,distance) AS (
  SELECT id,id,0 FROM mlm.affiliate
  UNION ALL SELECT a.parent_id,n.descendant_id,n.distance+1 FROM nodes n JOIN mlm.affiliate a ON a.id=n.ancestor_id
    WHERE a.parent_id IS NOT NULL
)
INSERT INTO mlm.affiliate_closure SELECT * FROM nodes;
CREATE FUNCTION identity.administrative_wallet_person(p_subject text) RETURNS bigint
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $f$
  SELECT CASE p_subject WHEN 'root' THEN 101 WHEN 'g' THEN 102 WHEN 'p' THEN 103 WHEN 'alice' THEN 104
    WHEN 'bob' THEN 105 WHEN 'inactive' THEN 106 WHEN 'leaf' THEN 107 WHEN 'unplaced' THEN 108 END::bigint
$f$;
CREATE FUNCTION identity.require_administrative_native_session(p_subject text,p_session text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $f$
BEGIN
  IF identity.administrative_wallet_person(p_subject) IS NULL OR p_session IS DISTINCT FROM p_subject||':session' THEN
    RAISE EXCEPTION 'invalid session' USING ERRCODE='28000';
  END IF;
  RETURN clock_timestamp()+interval '1 hour';
END $f$;
REVOKE ALL ON FUNCTION identity.require_administrative_native_session(text,text),identity.administrative_wallet_person(text) FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${observer};
ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT EXECUTE ON FUNCTIONS TO ${observer};
`;
const started = docker(['run', '--detach', '--rm', '--pull', 'never', '--network', 'none', '--name', container,
  '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=' + database, image]);
if (started.status !== 0) throw Error(started.stderr || started.error?.message || 'failed to start isolated PostgreSQL');

try {
  for (let attempt = 0; ; attempt++) {
    if (docker(psql, 'SELECT 1;').status === 0) break;
    assert.ok(attempt < 60, 'isolated PostgreSQL failed to start');
    await delay(500);
  }

  query(source);
  query(await readFile(new URL('../_meta/migration/144_app_pagar_pv.sql', import.meta.url), 'utf8'));
  query(await readFile(new URL('../_meta/migration/145_app_pagar_rank_entitlement.sql', import.meta.url), 'utf8'));
  const fingerprint = 'SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY a.id)::text) FROM mlm.affiliate a;';
  const tree = query(fingerprint);
  const first = randomUUID(), second = randomUUID(), belowInactive = randomUUID(), unplaced = randomUUID(), zero = randomUUID();
  query(activate(first, 'alice', 4, 51, 2), owner);
  assert.equal(ranks('p'), '', 'global rank and global balances alone never create a prize');
  await Promise.all([concurrent(activate(second, 'bob', 5, 25, 3, true), owner),
    concurrent(activate(second, 'bob', 5, 25, 3, true), owner)]);
  query(activate(belowInactive, 'leaf', 7, 12, 2), owner);
  query(activate(unplaced, 'unplaced', null, 14, 2), owner);
  query(activate(zero, 'leaf', 7, 0, 2), owner);

  assert.equal(points('alice'), '51|0|0');
  assert.equal(points('bob'), '25|0|0');
  assert.equal(points('p'), '0|51|25');
  assert.equal(points('g'), '0|12|76');
  assert.equal(points('root'), '0|25|0');
  assert.equal(points('leaf'), '12|0|0');
  assert.equal(points('inactive'), '0|0|0');
  assert.equal(points('unplaced'), '14|0|0');
  assert.equal(ranks('p'), 'BRONZE|10001|pending_close\nSILVER|20009|pending_close');
  assert.equal(ranks('g'), '');
  assert.equal(ranks('root'), '');
  assert.equal(ranks('alice'), '');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_rank_entitlement;'), '2');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_pv_source;'), '5');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_pv_leg;'), '6');
  assert.equal(query(fingerprint), tree, 'global PV/rank/tree must remain unchanged');

  rejects("SELECT * FROM payments.read_app_pagar_points_v1('alice','bob:session');", runtime, /invalid session/);
  rejects("SELECT * FROM payments.read_app_pagar_rank_entitlements_v1('p','alice:session');", runtime, /invalid session/);
  rejects("SELECT * FROM payments.read_app_pagar_rank_entitlements_v1('p','p:session');", observer, /permission denied/);
  rejects("SELECT * FROM payments.read_app_pagar_points_v1('alice','alice:session');", observer, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_pv_source;', runtime, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_pv_leg;', observer, /permission denied/);
  rejects('SELECT * FROM payments.app_pagar_rank_entitlement;', runtime, /permission denied/);
  rejects(activate(randomUUID(), 'alice', 4, 99, 1), runtime, /permission denied/);
  rejects('UPDATE payments.app_pagar_pv_source SET pv_delta=100;', owner, /app_pagar_accounting_immutable/);
  rejects('TRUNCATE payments.app_pagar_pv_leg,payments.app_pagar_rank_entitlement;', owner, /app_pagar_accounting_immutable/);
  rejects('UPDATE payments.app_pagar_rank_entitlement SET prize_usd_minor=1;', owner, /app_pagar_accounting_immutable/);
  rejects(activate(randomUUID(), 'alice', 4, 99, 31), owner, /app_pagar_pv_invalid_depth/);
  rejects(activate(randomUUID(), 'inactive', 6, 99, 2), owner, /app_pagar_pv_invalid_tree/);

  query('DELETE FROM mlm.affiliate_closure WHERE ancestor_id=3 AND descendant_id=4;');
  const bogus = randomUUID();
  rejects(activate(bogus, 'alice', 4, 99, 2), owner, /app_pagar_pv_invalid_tree/);
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_investment WHERE payment_id=' + literal(bogus) + ';'), '0');
  assert.equal(points('alice'), '51|0|0');
  query('INSERT INTO payments.app_pagar_economic_hold(payment_id) VALUES(' + literal(first) + ');', owner);
  assert.equal(points('alice'), '0|0|0');
  assert.equal(points('p'), '0|0|25');
  assert.equal(points('g'), '0|12|25');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_pv_leg WHERE payment_id=' + literal(first) + ';'), '2');
  assert.equal(ranks('p'), 'BRONZE|10001|review\nSILVER|20009|review');
  query(activate(randomUUID(), 'bob', 5, 50, 3), owner);
  assert.equal(points('p'), '0|0|75');
  assert.equal(ranks('p'), 'BRONZE|10001|review\nSILVER|20009|review');
  assert.equal(query('SELECT count(*) FROM payments.app_pagar_rank_entitlement;'), '2');
  console.log('App Pagar PV and rank prizes passed (isolated PostgreSQL, depth, direction, replay, holds, exact USD and no global mutations).');
} finally {
  const inspected = docker(['inspect', '--format', '{{.Name}} {{.HostConfig.NetworkMode}}', container]);
  if (inspected.stdout.trim() === '/' + container + ' none') docker(['stop', '--time', '1', container]);
}
