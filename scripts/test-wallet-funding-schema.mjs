import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// No host ports, shared database URLs or mounted files are used. The database
// lives only in a uniquely labelled, disposable container with networking off.
const container = `mb-wallet-funding-test-${randomUUID()}`;
const label = 'mindbliss.synthetic=wallet-funding-schema';
const database = 'mindbliss_curated_20261025';
const image = 'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
const role = 'mindbliss_auth_core_v1';
const personalAddress = `0x${'1'.repeat(40)}`;
const bobPersonalAddress = `0x${'2'.repeat(40)}`;
const adminAddress = `0x${'3'.repeat(40)}`;
const bobAdminAddress = `0x${'4'.repeat(40)}`;
const requestId = '11111111-1111-4111-8111-111111111111';
const bobId = '22222222-2222-4222-8222-222222222222';
const migration = readFileSync(new URL('../_meta/migration/93_wallet_funding_isolation.sql', import.meta.url), 'utf8');
const methodMigration = readFileSync(new URL('../_meta/migration/94_wallet_funding_payment_methods.sql', import.meta.url), 'utf8');
let probes = 0;

function docker(args, input) {
  return spawnSync('docker', args, { input, encoding: 'utf8', shell: false, maxBuffer: 2 * 1024 * 1024 });
}

function psql(sql, allowFailure = false) {
  const result = docker(['exec', '-i', container, 'psql', '-X', '-w', '-qAt', '-U', 'postgres', '-d', database,
    '-v', 'ON_ERROR_STOP=1'], sql);
  if (!allowFailure && result.status !== 0) throw new Error(`Synthetic SQL failed: ${result.stderr || result.error?.message}`);
  return result;
}

function parallelPsql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-w', '-qAt', '-U', 'postgres', '-d', database,
      '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(`SET ROLE ${role};${sql}`);
  });
}

function value(sql, asRole = true) {
  const result = psql(`${asRole ? `SET ROLE ${role};` : ''}${sql}`);
  return result.stdout.trim();
}

function equal(sql, expected, asRole = true) {
  assert.equal(value(sql, asRole), expected);
  probes++;
}

function rejects(sql, expected) {
  const result = psql(`SET ROLE ${role};${sql}`, true);
  assert.notEqual(result.status, 0, 'invalid synthetic request unexpectedly succeeded');
  assert.match(result.stderr, new RegExp(expected));
  probes++;
}

const personal = (subject = 'alice', address = personalAddress, amount = '100', id = requestId, country = 'CO') =>
  `SELECT * FROM payments.create_reown_funding_intent('${subject}','${address}','${country}',${amount},'${id}');`;
const admin = (subject = 'alice', address = adminAddress, amount = '100', id = requestId, provider = 'TRANSAK') =>
  `SELECT * FROM payments.create_meld_sandbox_funding_attempt('${subject}','${address}','CO',${amount},'${id}','${provider}','CREDIT_DEBIT_CARD');`;

try {
  const started = docker(['run', '--detach', '--pull', 'never', '--name', container, '--label', label, '--network', 'none',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', `POSTGRES_DB=${database}`, image]);
  assert.equal(started.status, 0, 'disposable PostgreSQL could not start');
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (docker(['exec', container, 'pg_isready', '-U', 'postgres', '-d', database]).status === 0) {
      ready = true; break;
    }
    await delay(200);
  }
  assert.equal(ready, true, 'disposable PostgreSQL was not ready');
  psql(`CREATE ROLE ${role} NOLOGIN; CREATE ROLE app_read NOLOGIN;
    CREATE SCHEMA auth; CREATE SCHEMA identity; CREATE SCHEMA payments; CREATE SCHEMA mlm;
    ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT SELECT ON TABLES TO app_read;
    CREATE TABLE auth."user"(id text PRIMARY KEY,eligible boolean NOT NULL DEFAULT true);
    INSERT INTO auth."user" VALUES('alice',true),('bob',true),('blocked',false),('charlie',true);
    CREATE TABLE identity.wallet_binding(subject text PRIMARY KEY REFERENCES auth."user"(id),address text NOT NULL UNIQUE);
    INSERT INTO identity.wallet_binding VALUES('alice','${personalAddress}'),('bob','${bobPersonalAddress}'),('charlie','0x${'5'.repeat(40)}');
    CREATE TABLE identity.administrative_wallet_pool(ordinal smallint PRIMARY KEY,address text NOT NULL UNIQUE,status text NOT NULL DEFAULT 'available');
    INSERT INTO identity.administrative_wallet_pool(ordinal,address) VALUES(1,'${adminAddress}'),(2,'${bobAdminAddress}'),(3,'0x${'6'.repeat(40)}');
    CREATE TABLE identity.administrative_wallet_assignment(subject text PRIMARY KEY REFERENCES auth."user"(id),pool_ordinal smallint REFERENCES identity.administrative_wallet_pool(ordinal));
    INSERT INTO identity.administrative_wallet_assignment VALUES('alice',1),('bob',2),('charlie',3);
    CREATE FUNCTION identity.administrative_wallet_person(p_subject text) RETURNS bigint
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
      BEGIN IF NOT EXISTS(SELECT 1 FROM auth."user" u WHERE u.id=p_subject AND u.eligible) THEN
        RAISE EXCEPTION 'administrative_wallet_identity_unavailable' USING ERRCODE='28000'; END IF;
        RETURN 1; END $function$;
    REVOKE ALL ON FUNCTION identity.administrative_wallet_person(text) FROM PUBLIC;
    CREATE TABLE mlm.wallet_movement(id bigint PRIMARY KEY,amount numeric);
    CREATE TABLE payments.meld_onramp_attempt(id uuid PRIMARY KEY,commission_status text);
    INSERT INTO mlm.wallet_movement VALUES(1,123.45);
    INSERT INTO payments.meld_onramp_attempt VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','estimated');`);
  const ledgerBefore = value(`SELECT md5((SELECT json_agg(m ORDER BY id)::text FROM mlm.wallet_movement m)||
    (SELECT json_agg(a ORDER BY id)::text FROM payments.meld_onramp_attempt a));`, false);
  psql(migration);

  equal(`SELECT has_table_privilege('${role}','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('${role}','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE');`, 'f', false);
  equal(`SELECT bool_and(p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[])
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='payments' AND
    p.proname IN ('create_reown_funding_intent','create_meld_sandbox_funding_attempt','finish_meld_sandbox_funding_attempt','read_wallet_funding_history');`, 't', false);
  equal(`SELECT count(*) FROM information_schema.columns WHERE table_schema='payments'
    AND table_name IN ('reown_funding_intent','meld_sandbox_funding_attempt')
    AND (column_name LIKE '%commission%' OR column_name LIKE '%fee%' OR column_name LIKE '%token%' OR column_name LIKE '%url%');`, '0', false);
  rejects('SELECT * FROM payments.reown_funding_intent;', 'permission denied');
  rejects('SELECT * FROM payments.meld_sandbox_funding_attempt;', 'permission denied');

  const personalResult = value(personal());
  assert.match(personalResult, new RegExp(`^${requestId}\|`)); probes++;
  equal(personal(), personalResult);
  rejects(personal('alice', personalAddress, '101'), 'wallet_funding_request_already_used');
  rejects(personal('bob', bobPersonalAddress), 'wallet_funding_request_already_used');
  rejects(personal('alice', bobPersonalAddress, '100', randomUUID()), 'wallet_funding_wallet_not_linked');
  rejects(personal('alice', adminAddress, '100', randomUUID()), 'wallet_funding_wallet_not_linked');
  rejects(personal('blocked', personalAddress, '100', randomUUID()), 'wallet_funding_forbidden');
  rejects(personal('alice', personalAddress, '49', randomUUID()), 'wallet_funding_invalid_request');
  rejects(personal('alice', personalAddress, '50.001', randomUUID()), 'wallet_funding_invalid_request');
  rejects(personal('alice', personalAddress, "'NaN'::numeric", randomUUID()), 'wallet_funding_invalid_request');

  const adminCreated = value(admin());
  assert.match(adminCreated, new RegExp(`^${requestId}\|.*\|t\|initiated$`)); probes++;
  assert.match(value(admin()), new RegExp(`^${requestId}\|.*\|f\|initiated$`)); probes++;
  rejects(admin('alice', adminAddress, '101'), 'wallet_funding_request_already_used');
  rejects(admin('alice', adminAddress, '100', randomUUID(), 'TOPPER'), 'wallet_funding_invalid_request');
  rejects(admin('alice', adminAddress, '100', randomUUID(), 'SWAPPED'), 'wallet_funding_invalid_request');
  assert.match(value(admin('bob', bobAdminAddress, '100', randomUUID(), 'BANXA')), /\|t\|initiated$/); probes++;
  rejects(admin('alice', personalAddress, '100', randomUUID()), 'wallet_funding_wallet_not_assigned');
  rejects(admin('alice', bobAdminAddress, '100', randomUUID()), 'wallet_funding_wallet_not_assigned');
  rejects(admin('blocked', adminAddress, '100', randomUUID()), 'wallet_funding_forbidden');
  equal(`SELECT payments.finish_meld_sandbox_funding_attempt('bob','${requestId}','failed',NULL);`, 'f');
  equal(`SELECT payments.finish_meld_sandbox_funding_attempt('alice','${requestId}','session_created','synthetic-provider-session');`, 't');
  equal(`SELECT payments.finish_meld_sandbox_funding_attempt('alice','${requestId}','failed',NULL);`, 'f');
  rejects(`SELECT payments.finish_meld_sandbox_funding_attempt('alice','${requestId}','complete',NULL);`, 'wallet_funding_invalid_status');
  rejects(`SELECT payments.finish_meld_sandbox_funding_attempt('alice','${requestId}','failed',repeat('x',256));`, 'wallet_funding_invalid_status');
  rejects(`SELECT payments.finish_meld_sandbox_funding_attempt('alice','${requestId}','failed','https://sb.meldcrypto.com/?token=synthetic');`, 'wallet_funding_invalid_status');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_history('bob','personal');`, '0');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_history('bob','administrative');`, '1');
  equal(`SELECT wallet_address FROM payments.read_wallet_funding_history('bob','administrative');`, bobAdminAddress);
  equal(`SELECT wallet_kind||'|'||environment||'|'||provider||'|'||status FROM payments.read_wallet_funding_history('alice','personal');`, 'personal|production|reown|initiated');
  equal(`SELECT wallet_kind||'|'||environment||'|'||provider||'|'||status FROM payments.read_wallet_funding_history('alice','administrative');`, 'administrative|sandbox|meld|session_created');
  rejects(`SELECT * FROM payments.read_wallet_funding_history('alice','both');`, 'wallet_funding_invalid_kind');
  rejects(`SELECT * FROM payments.read_wallet_funding_history('blocked','personal');`, 'wallet_funding_forbidden');

  for (let index = 0; index < 9; index++) { value(personal('alice', personalAddress, '100', randomUUID())); value(admin('alice', adminAddress, '100', randomUUID())); }
  rejects(personal('alice', personalAddress, '100', randomUUID()), 'wallet_funding_rate_limited');
  rejects(admin('alice', adminAddress, '100', randomUUID()), 'wallet_funding_rate_limited');
  equal(personal(), personalResult);
  assert.match(value(admin()), /\|f\|session_created$/); probes++;
  // A full rate window for one member never blocks another member.
  assert.match(value(personal('bob', bobPersonalAddress, '100', bobId)), new RegExp(`^${bobId}\|`)); probes++;
  psql(`INSERT INTO payments.reown_funding_intent(id,subject,wallet_address,country_code,requested_amount,created_at)
    SELECT gen_random_uuid(),'alice','${personalAddress}','CO',50,now()-interval '1 day' FROM generate_series(1,25);
    INSERT INTO payments.meld_sandbox_funding_attempt(id,subject,wallet_address,country_code,requested_amount,service_provider,payment_method,created_at)
    SELECT gen_random_uuid(),'alice','${adminAddress}','CO',50,'TRANSAK','CREDIT_DEBIT_CARD',now()-interval '1 day' FROM generate_series(1,25);`);
  equal(`SELECT count(*) FROM payments.read_wallet_funding_history('alice','personal');`, '20');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_history('alice','administrative');`, '20');
  const concurrentId = randomUUID();
  const duplicateCreates = await Promise.all(Array.from({ length: 8 }, () => parallelPsql(admin('charlie', `0x${'6'.repeat(40)}`, '100', concurrentId))));
  assert.equal(duplicateCreates.filter(result => result.status === 0).length, 8);
  assert.equal(duplicateCreates.filter(result => /\|t\|initiated\s*$/.test(result.stdout)).length, 1);
  assert.equal(duplicateCreates.filter(result => /\|f\|initiated\s*$/.test(result.stdout)).length, 7);
  probes++;
  const concurrentRates = await Promise.all(Array.from({ length: 15 }, () => parallelPsql(personal('charlie', `0x${'5'.repeat(40)}`, '100', randomUUID()))));
  assert.equal(concurrentRates.filter(result => result.status === 0).length, 10);
  assert.equal(concurrentRates.filter(result => result.status !== 0 && /wallet_funding_rate_limited/.test(result.stderr)).length, 5);
  probes++;
  psql('GRANT USAGE ON SCHEMA payments TO app_read;');
  equal(`SET ROLE app_read; SELECT count(*) FROM payments.reown_funding_intent;`, '0', false);
  equal(`SET ROLE app_read; SELECT count(*) FROM payments.meld_sandbox_funding_attempt;`, '0', false);
  equal(`SELECT has_function_privilege('app_read','payments.create_reown_funding_intent(text,text,text,numeric,uuid)','EXECUTE')
    OR has_function_privilege('app_read','payments.create_meld_sandbox_funding_attempt(text,text,text,numeric,uuid,text,text)','EXECUTE');`, 'f', false);
  psql(`UPDATE auth."user" SET eligible=false WHERE id='alice';`);
  rejects(`SELECT * FROM payments.read_wallet_funding_history('alice','administrative');`, 'wallet_funding_forbidden');
  equal(`SELECT md5((SELECT json_agg(m ORDER BY id)::text FROM mlm.wallet_movement m)||
    (SELECT json_agg(a ORDER BY id)::text FROM payments.meld_onramp_attempt a));`, ledgerBefore, false);
  const duplicateMigration = psql(migration, true);
  assert.notEqual(duplicateMigration.status, 0);
  assert.match(duplicateMigration.stderr, /wallet_funding_requires_fresh_review/);
  probes++;
  const legacyPersonalRows = value('SELECT count(*) FROM payments.reown_funding_intent;', false);
  psql(methodMigration);
  equal('SELECT count(*) FROM payments.reown_funding_intent WHERE payment_method IS NULL;', legacyPersonalRows, false);
  equal(`SELECT has_function_privilege('${role}','payments.create_reown_funding_intent(text,text,text,numeric,uuid)','EXECUTE');`, 'f', false);
  equal(`SELECT has_function_privilege('${role}','payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)','EXECUTE');`, 't', false);
  rejects(personal('bob', bobPersonalAddress, '100', randomUUID()), 'permission denied');
  const methodId = randomUUID();
  const withMethod = (method = "'CREDIT_DEBIT_CARD'", address = bobPersonalAddress, id = methodId, subject = 'bob') =>
    `SELECT * FROM payments.create_reown_funding_intent('${subject}','${address}','CO',100,'${id}',${method});`;
  const withMethodResult = value(withMethod());
  assert.match(withMethodResult, new RegExp(`^${methodId}\\|`)); probes++;
  equal(withMethod(), withMethodResult);
  equal(`SELECT payment_method FROM payments.reown_funding_intent WHERE id='${methodId}';`, 'CREDIT_DEBIT_CARD', false);
  rejects(withMethod("'APPLE_PAY'"), 'wallet_funding_request_already_used');
  rejects(withMethod('NULL', bobPersonalAddress, randomUUID()), 'wallet_funding_invalid_request');
  rejects(withMethod("'invalid method'", bobPersonalAddress, randomUUID()), 'wallet_funding_invalid_request');
  rejects(withMethod("'CREDIT_DEBIT_CARD'", bobAdminAddress, randomUUID()), 'wallet_funding_wallet_not_linked');
  rejects(withMethod("'CREDIT_DEBIT_CARD'", personalAddress, randomUUID()), 'wallet_funding_wallet_not_linked');
  rejects(withMethod("'CREDIT_DEBIT_CARD'", bobPersonalAddress, randomUUID(), 'blocked'), 'wallet_funding_forbidden');
  equal(`SELECT md5((SELECT json_agg(m ORDER BY id)::text FROM mlm.wallet_movement m)||
    (SELECT json_agg(a ORDER BY id)::text FROM payments.meld_onramp_attempt a));`, ledgerBefore, false);
  rejects('SELECT * FROM payments.reown_funding_intent;', 'permission denied');
  equal(`SELECT has_function_privilege('app_read','payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)','EXECUTE');`, 'f', false);
  const duplicateMethodMigration = psql(methodMigration, true);
  assert.notEqual(duplicateMethodMigration.status, 0);
  assert.match(duplicateMethodMigration.stderr, /wallet_funding_method_requires_fresh_review/);
  probes++;
  console.log(JSON.stringify({ walletFundingSchema: 'passed', probes, environment: 'disposable-postgres',
    externalNetwork: 'disabled', productionConnections: 0, ledgerUnchanged: true }));
} catch (error) {
  // This harness contains synthetic data only; avoid dumping whole SQL fixtures.
  console.error(JSON.stringify({ walletFundingSchema: 'failed', message: error.message }));
  process.exitCode = 1;
} finally {
  const ownership = docker(['inspect', '--format', '{{ index .Config.Labels "mindbliss.synthetic" }}', container]);
  if (ownership.status === 0 && ownership.stdout.trim() === 'wallet-funding-schema'
    && /^mb-wallet-funding-test-[a-f0-9-]{36}$/.test(container)) docker(['rm', '--force', container]);
}
