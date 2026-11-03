// Explicit, entirely synthetic rehearsal of migration 88. This script never
// reads a host/cloud DSN, project .env, customer data or provider credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

if (process.argv.slice(2).join(' ') !== '--synthetic-docker') {
  throw new Error('Requires --synthetic-docker');
}

const image = 'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27';
const container = `runtime-schema-88-${randomBytes(8).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const environment = { ...process.env, POSTGRES_PASSWORD: password };
const databases = new Set(['postgres', 'runtime_schema_88', 'runtime_schema_rollback', 'runtime_schema_defaults']);
const role = 'mindbliss_go_payments_reader_v1';
const reader = 'synthetic_payments_reader';
const auth = 'synthetic_auth_reader';
const member = 'synthetic_member_reader';
const source = await readFile(new URL('../../_meta/migration/88_runtime_read_schema_repair.sql', import.meta.url), 'utf8');
assert.equal(source.split('REPLACE_WITH_CURATED_DATABASE').length, 2, 'one explicit database guard is required');
let started = false;
let assertions = 0;

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions++;
}

function run(args, input, expectedSuccess = true) {
  const result = spawnSync('docker', args, {
    env: environment, input, encoding: 'utf8', windowsHide: true,
    timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  const diagnostic = String(result.stderr || result.stdout || result.error?.code || 'SYNTHETIC_DOCKER_FAILED')
    .replaceAll(password, '[redacted]');
  if (expectedSuccess && result.status !== 0) throw new Error(diagnostic);
  if (!expectedSuccess) {
    assert.notEqual(result.status, 0, 'expected the isolated PostgreSQL command to reject the operation');
    assertions++;
    return diagnostic;
  }
  return result.stdout.trim();
}

function sql(database, query, username = 'postgres', expectedSuccess = true) {
  assert.ok(databases.has(database), 'only fixed synthetic databases are allowed');
  assert.ok(['postgres', reader, auth, member].includes(username), 'only fixed local fixture users are allowed');
  return run(['exec', '-i', container, 'psql', '-X', '-q', '-A', '-t', '-F', '|', '-P', 'null=NULL',
    '-v', 'ON_ERROR_STOP=1', '-U', username, '-d', database], query, expectedSuccess);
}

function migration(database) {
  assert.ok(databases.has(database) && database !== 'postgres');
  return source.replace('REPLACE_WITH_CURATED_DATABASE', database);
}

function fixture(database) {
  sql('postgres', `CREATE DATABASE ${database};`);
  sql(database, `
    CREATE SCHEMA mlm; CREATE SCHEMA auth; CREATE SCHEMA support; CREATE SCHEMA payments;
    REVOKE ALL ON SCHEMA mlm,auth,support,payments FROM PUBLIC;
    CREATE TABLE mlm.person(id bigint PRIMARY KEY,email text NOT NULL,first_name text,last_name text,
      phone_number text,status text,blacklisted boolean,updated_at timestamptz NOT NULL);
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,person_id bigint,parent_id bigint,position text,current_rank_id int);
    CREATE TABLE mlm.wallet_movement(id bigint PRIMARY KEY,affiliate_id bigint,amount numeric(20,8));
    CREATE TABLE payments.synthetic_sale(id bigint PRIMARY KEY,provider text,amount numeric(20,2));
    CREATE TABLE auth."user"(id text PRIMARY KEY,email text,email_verified boolean);
    INSERT INTO mlm.person VALUES
      (1,'original@example.invalid','Original','Member','+573001234567','active',false,'2026-09-01T00:00:00Z'),
      (2,'another@example.invalid','Another','Member',NULL,'pending',false,'2026-09-02T00:00:00Z');
    INSERT INTO mlm.affiliate VALUES(10,1,NULL,NULL,4),(11,2,10,'R',2);
    INSERT INTO mlm.wallet_movement VALUES(1,10,123.45678901),(2,11,-10.00000000);
    INSERT INTO payments.synthetic_sale VALUES(1,'stripe',100.00),(2,'nowpayments',50.00);
    INSERT INTO auth."user" VALUES('original-principal','original@example.invalid',false);
    GRANT USAGE ON SCHEMA mlm TO ${role},synthetic_auth_policy,synthetic_member_policy;
    GRANT SELECT ON mlm.person TO ${role};
    GRANT SELECT(id,email) ON mlm.person TO synthetic_auth_policy,synthetic_member_policy;
  `);
}

function existingState(database) {
  return sql(database, `SELECT jsonb_build_object(
    'person', (SELECT jsonb_agg(to_jsonb(p)-'country'-'payout_wallet_usdc' ORDER BY id) FROM mlm.person p),
    'person_oid', 'mlm.person'::regclass::oid,
    'person_filenode', (SELECT relfilenode FROM pg_class WHERE oid='mlm.person'::regclass),
    'person_acl', (SELECT relacl::text FROM pg_class WHERE oid='mlm.person'::regclass),
    'affiliate', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM mlm.affiliate a),
    'movements', (SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM mlm.wallet_movement w),
    'sales', (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM payments.synthetic_sale s),
    'auth', (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM auth."user" u)
  )::text;`);
}

function absent(database) {
  return sql(database, `SELECT to_regclass('support.news') IS NULL
    AND to_regclass('support.news_id_seq') IS NULL
    AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='mlm.person'::regclass
      AND attnum>0 AND NOT attisdropped AND attname IN ('country','payout_wallet_usdc'));`);
}

try {
  run(['run', '--pull=never', '--detach', '--name', container, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data', '--env', 'POSTGRES_PASSWORD', image]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'],
      { stdio: 'ignore', windowsHide: true, timeout: 5_000 });
    if (result.status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  equal(ready, true, 'isolated PostgreSQL must become ready');
  equal(sql('postgres', 'SHOW server_version_num;').startsWith('170011'), true);
  equal(run(['inspect', container, '--format', '{{.HostConfig.NetworkMode}}|{{len .HostConfig.PortBindings}}']), 'none|0');
  sql('postgres', `
    CREATE ROLE ${role} NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE synthetic_auth_policy NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE synthetic_member_policy NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ${reader} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ${auth} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ${member} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT ${role} TO ${reader}; GRANT synthetic_auth_policy TO ${auth}; GRANT synthetic_member_policy TO ${member};
  `);

  const database = 'runtime_schema_88';
  fixture(database);
  const before = existingState(database);
  equal(absent(database), 't');
  assert.match(sql(database, source, 'postgres', false), /runtime_read_schema_explicit_primary_review_required/);
  assertions++;
  equal(absent(database), 't', 'unmodified production placeholder must reject this fixture');
  sql(database, migration(database));
  equal(existingState(database), before, 'existing business/auth data, table storage and ACL must remain intact');
  equal(sql(database, 'SELECT count(*) FROM support.news;'), '0', 'migration must not publish invented content');
  equal(sql(database, 'SELECT count(*) FROM mlm.person WHERE country IS NULL AND payout_wallet_usdc IS NULL;'), '2');
  equal(sql(database, `SELECT count(*) FROM pg_attribute WHERE attrelid='mlm.person'::regclass
    AND attname IN ('country','payout_wallet_usdc') AND atttypid='text'::regtype AND NOT attnotnull AND NOT atthasdef;`), '2');
  equal(sql(database, `SELECT count(*) FROM pg_index WHERE indrelid='support.news'::regclass
    AND indisvalid AND indisready AND indpred IS NOT NULL;`), '1');
  equal(sql(database, `SELECT current_user || '|' || pg_has_role(current_user,'${role}','USAGE');`, reader), `${reader}|true`);
  // Execute the deployed profile/news SQL using a genuine inherited LOGIN, not SET ROLE.
  equal(sql(database, `PREPARE profile(text) AS SELECT first_name,last_name,phone_number,country,payout_wallet_usdc
    FROM mlm.person WHERE lower(email)=lower($1) LIMIT 1;
    EXECUTE profile('ORIGINAL@example.invalid');`, reader), 'Original|Member|+573001234567|NULL|NULL');
  equal(sql(database, `PREPARE news(int) AS SELECT id,title,body,to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSZ')
    FROM support.news WHERE published=true ORDER BY created_at DESC LIMIT $1; EXECUTE news(10);`, reader), '');
  sql(database, `INSERT INTO support.news(title,body,published,created_at) VALUES
    ('Visible','Official announcement',true,'2026-11-02T00:00:00Z'),
    ('Unpublished','Private draft',false,'2026-11-03T00:00:00Z');`);
  equal(sql(database, `PREPARE news(int) AS SELECT id,title,body,to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSZ')
    FROM support.news WHERE published=true ORDER BY created_at DESC LIMIT $1; EXECUTE news(10);`, reader),
    '1|Visible|Official announcement|2026-11-02T00:00:00Z');
  equal(sql(database, `SELECT has_schema_privilege(current_user,'support','USAGE')
    AND has_column_privilege(current_user,'support.news','title','SELECT')
    AND NOT has_table_privilege(current_user,'support.news','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
    AND NOT has_any_column_privilege(current_user,'support.news','INSERT,UPDATE')
    AND NOT has_sequence_privilege(current_user,'support.news_id_seq','USAGE,SELECT,UPDATE');`, reader), 't');
  for (const query of [
    "INSERT INTO support.news(title,body) VALUES('Forbidden','Forbidden');",
    "UPDATE support.news SET title='Forbidden' WHERE id=1;",
    'DELETE FROM support.news WHERE id=1;',
    'TRUNCATE support.news;',
    "SELECT nextval('support.news_id_seq');",
    "UPDATE mlm.person SET country='CO' WHERE id=1;",
  ]) {
    assert.match(sql(database, query, reader, false), /permission denied/);
    assertions++;
  }
  for (const username of [auth, member]) {
    equal(sql(database, `SELECT email FROM mlm.person WHERE id=1;`, username), 'original@example.invalid');
    // Inspect ACLs as owner: an unprivileged caller cannot even resolve an
    // object inside a schema it cannot use. Actual LOGIN denials follow below.
    equal(sql(database, `SELECT NOT has_schema_privilege('${username}','support','USAGE')
      AND NOT has_any_column_privilege('${username}','support.news','SELECT,INSERT,UPDATE,REFERENCES')
      AND NOT has_table_privilege('${username}','support.news','DELETE,TRUNCATE,TRIGGER')
      AND NOT has_sequence_privilege('${username}','support.news_id_seq','USAGE,SELECT,UPDATE')
      AND NOT has_column_privilege('${username}','mlm.person','country','SELECT,INSERT,UPDATE,REFERENCES')
      AND NOT has_column_privilege('${username}','mlm.person','payout_wallet_usdc','SELECT,INSERT,UPDATE,REFERENCES');`), 't');
    assert.match(sql(database, 'SELECT country,payout_wallet_usdc FROM mlm.person;', username, false), /permission denied/);
    assertions++;
    assert.match(sql(database, 'SELECT title FROM support.news;', username, false), /permission denied/);
    assertions++;
  }
  const published = sql(database, 'SELECT jsonb_agg(to_jsonb(n) ORDER BY id)::text FROM support.news n;');
  assert.match(sql(database, migration(database), 'postgres', false), /runtime_read_schema_existing_objects_require_review/);
  assertions++;
  equal(existingState(database), before, 'reapplication must not alter existing data');
  equal(sql(database, 'SELECT jsonb_agg(to_jsonb(n) ORDER BY id)::text FROM support.news n;'), published,
    'reapplication must not clear or replace announcements');

  const rollback = 'runtime_schema_rollback';
  fixture(rollback);
  const rollbackBefore = existingState(rollback);
  const injectedFailure = migration(rollback).replace(/^COMMIT;\s*$/m, 'SELECT 1/0;\nCOMMIT;');
  assert.notEqual(injectedFailure, migration(rollback), 'failure injection must precede commit');
  assert.match(sql(rollback, injectedFailure, 'postgres', false), /division by zero/);
  assertions++;
  equal(absent(rollback), 't', 'failed transaction must roll back both new columns, table and sequence');
  equal(existingState(rollback), rollbackBefore);
  equal(sql(rollback, `SELECT NOT has_schema_privilege('${role}','support','USAGE');`), 't', 'ACL must roll back atomically');

  const defaults = 'runtime_schema_defaults';
  fixture(defaults);
  sql(defaults, `ALTER DEFAULT PRIVILEGES IN SCHEMA support GRANT SELECT ON TABLES TO synthetic_auth_policy;`);
  const defaultsBefore = existingState(defaults);
  assert.match(sql(defaults, migration(defaults), 'postgres', false), /runtime_read_schema_default_grants_require_review/);
  assertions++;
  equal(absent(defaults), 't', 'unknown default grants must abort before creating private objects');
  equal(existingState(defaults), defaultsBefore);
  equal(existingState(database), before, 'all tests must preserve original business and authentication rows');
  console.log(JSON.stringify({ migration: 88, syntheticPostgres: '17.11', assertions,
    realInheritedReader: true, profileAndPublishedNews: true, noRuntimeWrites: true,
    authAndOtherReaderIsolation: true, existingBusinessDataUnchanged: true, noTableRewrite: true,
    oneShotGuard: true, atomicRollback: true, unknownDefaultGrantsRejected: true,
    network: 'none', publishedPorts: 0, productionAccess: false, providerCalls: 0, messagesSent: 0 }));
} finally {
  if (started) run(['rm', '--force', container]);
}
