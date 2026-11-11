import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// No host ports, shared database URLs or mounted files are used. The database
// lives only in a uniquely labelled, disposable container with networking off.
const container = `mb-wallet-funding-test-${randomUUID()}`;
const label = 'mindbliss.synthetic=wallet-funding-schema';
const personalFlow = process.argv.length === 3 && process.argv[2] === '--personal-flow';
assert.ok(process.argv.length === 2 || personalFlow, 'Only the explicit --personal-flow test mode is supported');
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
const statusMigration = readFileSync(new URL('../_meta/migration/95_wallet_funding_status_reads.sql', import.meta.url), 'utf8');
const usd20Migration = readFileSync(new URL('../_meta/migration/96_personal_usd20_membership_catalog.sql', import.meta.url), 'utf8');
const mxnMigration = readFileSync(new URL('../_meta/migration/97_personal_mxn_spei_requests.sql', import.meta.url), 'utf8');
const companyMigration = readFileSync(new URL('../_meta/migration/98_personal_company_payments.sql', import.meta.url), 'utf8');
const ethereumMigration = readFileSync(new URL('../_meta/migration/99_personal_ethereum_only.sql', import.meta.url), 'utf8');
const multichainMigration = readFileSync(new URL('../_meta/migration/100_personal_multichain_payments.sql', import.meta.url), 'utf8');
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
    // The init-only temporary server has no TCP listener. Wait for the final
    // postmaster, not its transient Unix socket, without exposing a host port.
    if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', database]).status === 0) {
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
  const statusSnapshot = `SELECT jsonb_build_object('personal',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM payments.reown_funding_intent r),
    'sandbox',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM payments.meld_sandbox_funding_attempt r),
    'legacy',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM payments.meld_onramp_attempt r),
    'movements',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM mlm.wallet_movement r))::text;`;
  const statusBefore = value(statusSnapshot, false);
  psql(statusMigration);
  equal(statusSnapshot, statusBefore, false);
  equal(`SELECT has_function_privilege('${role}','payments.read_wallet_funding_status(text,text,uuid)','EXECUTE');`, 't', false);
  equal(`SELECT has_function_privilege('app_read','payments.read_wallet_funding_status(text,text,uuid)','EXECUTE');`, 'f', false);
  equal(`SELECT bool_and(p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]) FROM pg_proc p
    WHERE p.oid='payments.read_wallet_funding_status(text,text,uuid)'::regprocedure;`, 't', false);
  equal(`SELECT has_table_privilege('${role}','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('${role}','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE');`, 'f', false);
  const oldPersonalId = value(`SELECT id FROM payments.reown_funding_intent WHERE subject='alice' AND created_at<now()-interval '12 hours' ORDER BY created_at,id LIMIT 1;`, false);
  psql(`UPDATE auth."user" SET eligible=true WHERE id='alice';`);
  equal(`SELECT count(*) FROM payments.read_wallet_funding_history('alice','personal') WHERE id='${oldPersonalId}';`, '0');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_status('alice','personal','${oldPersonalId}');`, '1');
  equal(`SELECT wallet_address FROM payments.read_wallet_funding_status('alice','personal','${oldPersonalId}');`, personalAddress);
  // Status is the historical destination, even if a later operator changes a binding.
  psql(`UPDATE identity.wallet_binding SET address='0x${'7'.repeat(40)}' WHERE subject='alice';`);
  equal(`SELECT wallet_address FROM payments.read_wallet_funding_status('alice','personal','${oldPersonalId}');`, personalAddress);
  equal(`SELECT count(*) FROM payments.read_wallet_funding_status('bob','personal','${oldPersonalId}');`, '0');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_status('bob','administrative','${methodId}');`, '0');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_status('bob','personal','${randomUUID()}');`, '0');
  equal(`SELECT wallet_kind||'|'||environment||'|'||provider||'|'||status FROM payments.read_wallet_funding_status('bob','personal','${methodId}');`, 'personal|production|reown|initiated');
  equal(`SELECT wallet_kind||'|'||environment||'|'||provider||'|'||status FROM payments.read_wallet_funding_status('alice','administrative','${requestId}');`, 'administrative|sandbox|meld|session_created');
  rejects(`SELECT * FROM payments.read_wallet_funding_status('blocked','personal','${oldPersonalId}');`, 'wallet_funding_forbidden');
  rejects(`SELECT * FROM payments.read_wallet_funding_status('alice','both','${oldPersonalId}');`, 'wallet_funding_invalid_kind');
  rejects(`SELECT * FROM payments.read_wallet_funding_status('alice','personal',NULL);`, 'wallet_funding_invalid_reference');
  equal(`SELECT md5((SELECT json_agg(m ORDER BY id)::text FROM mlm.wallet_movement m)||
    (SELECT json_agg(a ORDER BY id)::text FROM payments.meld_onramp_attempt a));`, ledgerBefore, false);
  const duplicateStatusMigration = psql(statusMigration, true);
  assert.notEqual(duplicateStatusMigration.status, 0);
  assert.match(duplicateStatusMigration.stderr, /wallet_funding_status_requires_fresh_review/);
  probes++;

  // USD20 is a new SKU: all legacy catalog facts and payment evidence survive.
  psql(`CREATE TABLE mlm.package(id integer PRIMARY KEY,name text NOT NULL,amount_usd numeric(14,2) NOT NULL,
    pv integer NOT NULL,type text NOT NULL,is_active boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO mlm.package(id,name,amount_usd,pv,type,is_active) VALUES
      (1,'Pack 1',10,10,'11001',false),(2,'Pack 2',25,25,'11001',false),(3,'Pack 3',50,50,'11001',true),
      (4,'Pack 4',100,100,'11001',true),(5,'Pack 5',250,250,'11001',true),(6,'Pack 6',500,500,'11001',true);
    CREATE TABLE mlm.plan_config(id integer PRIMARY KEY,effective_from timestamptz NOT NULL,effective_to timestamptz,cd_lock_days integer NOT NULL);
    INSERT INTO mlm.plan_config VALUES(1,now()-interval '1 day',NULL,365);
    CREATE TABLE mlm.cd_roi_tier(id integer PRIMARY KEY,min_amount_usd numeric NOT NULL,max_amount_usd numeric,
      base_annual_rate numeric NOT NULL,qualified_annual_rate numeric NOT NULL,active boolean NOT NULL);
    INSERT INTO mlm.cd_roi_tier VALUES(1,0,501,0.25,0.30,true);`);
  const oldCatalog = value('SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM mlm.package p;',false);
  const priorRequests = value(statusSnapshot,false);
  const oldFunctionDigest = value(`SELECT md5(pg_get_functiondef('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)'::regprocedure));`,false);
  assert.equal(oldFunctionDigest,'c8a003ee5488b84030c69224c4cd2aa5'); probes++;
  const invalidMigration = (setup, restore, expected) => {
    psql(setup);
    const result=psql(usd20Migration,true);
    assert.notEqual(result.status,0,'changed catalog or compensation unexpectedly migrated');
    assert.match(result.stderr,new RegExp(expected)); probes++;
    equal(`SELECT md5(pg_get_functiondef('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)'::regprocedure));`,oldFunctionDigest,false);
    equal(`SELECT pg_get_constraintdef(oid) LIKE '%(50)::numeric%' FROM pg_constraint WHERE conrelid='payments.reown_funding_intent'::regclass AND conname='reown_funding_intent_requested_amount_check';`,'t',false);
    equal(statusSnapshot,priorRequests,false);
    psql(restore);
  };
  invalidMigration(`INSERT INTO mlm.package(id,name,amount_usd,pv,type,is_active) VALUES(17,'occupied',100,100,'11001',true);`,
    'DELETE FROM mlm.package WHERE id=17;','usd20_existing_catalog_requires_review');
  invalidMigration(`INSERT INTO mlm.package(id,name,amount_usd,pv,type,is_active) VALUES(18,'other20',20,20,'11001',true);`,
    'DELETE FROM mlm.package WHERE id=18;','usd20_existing_catalog_requires_review');
  invalidMigration('UPDATE mlm.package SET amount_usd=51 WHERE id=3;','UPDATE mlm.package SET amount_usd=50 WHERE id=3;','usd20_existing_catalog_requires_review');
  invalidMigration('UPDATE mlm.package SET is_active=false WHERE id=3;','UPDATE mlm.package SET is_active=true WHERE id=3;','usd20_existing_catalog_requires_review');
  invalidMigration('UPDATE mlm.plan_config SET cd_lock_days=30;','UPDATE mlm.plan_config SET cd_lock_days=365;','usd20_existing_compensation_requires_review');
  invalidMigration(`INSERT INTO mlm.plan_config VALUES(2,now()-interval '1 day',NULL,365);`,'DELETE FROM mlm.plan_config WHERE id=2;','usd20_existing_compensation_requires_review');
  invalidMigration('UPDATE mlm.cd_roi_tier SET min_amount_usd=21;','UPDATE mlm.cd_roi_tier SET min_amount_usd=0;','usd20_existing_compensation_requires_review');
  invalidMigration('UPDATE mlm.cd_roi_tier SET base_annual_rate=0.40;','UPDATE mlm.cd_roi_tier SET base_annual_rate=0.25;','usd20_existing_compensation_requires_review');
  invalidMigration('INSERT INTO mlm.cd_roi_tier VALUES(2,0,501,0.25,0.30,true);','DELETE FROM mlm.cd_roi_tier WHERE id=2;','usd20_existing_compensation_requires_review');
  invalidMigration(`GRANT EXECUTE ON FUNCTION payments.create_reown_funding_intent(text,text,text,numeric,uuid) TO PUBLIC;`,
    `REVOKE EXECUTE ON FUNCTION payments.create_reown_funding_intent(text,text,text,numeric,uuid) FROM PUBLIC;`,'personal_usd20_runtime_isolation_required');
  const compensationSql="SELECT jsonb_build_object('plans',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM mlm.plan_config p),'tiers',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM mlm.cd_roi_tier p))::text;";
  const compensationBefore=value(compensationSql,false);
  psql(usd20Migration);
  equal(statusSnapshot,priorRequests,false);
  equal('SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM mlm.package p WHERE id<>17;',oldCatalog,false);
  equal(compensationSql,compensationBefore,false);
  equal(`SELECT id||'|'||name||'|'||amount_usd||'|'||pv||'|'||type||'|'||is_active FROM mlm.package WHERE amount_usd=20;`,'17|Pack 20 USD|20.00|20|11001|true',false);
  equal(`SELECT has_function_privilege('${role}','payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)','EXECUTE') AND NOT has_function_privilege('${role}','payments.create_reown_funding_intent(text,text,text,numeric,uuid)','EXECUTE');`,'t',false);
  psql(`INSERT INTO auth."user" VALUES('usd20-member',true);
    INSERT INTO identity.wallet_binding VALUES('usd20-member','0x${'8'.repeat(40)}');
    INSERT INTO identity.administrative_wallet_pool(ordinal,address) VALUES(4,'0x${'9'.repeat(40)}');
    INSERT INTO identity.administrative_wallet_assignment VALUES('usd20-member',4);`);
  const personal20Id=randomUUID();
  const personal20=(amount='20',id=personal20Id,address=`0x${'8'.repeat(40)}`)=>`SELECT * FROM payments.create_reown_funding_intent('usd20-member','${address}','US',${amount},'${id}','CREDIT_DEBIT_CARD');`;
  const accepted20=value(personal20());
  assert.match(accepted20,new RegExp(`^${personal20Id}\\|`)); probes++;
  equal(personal20(),accepted20);
  rejects(personal20('19.99',randomUUID()),'wallet_funding_invalid_request');
  rejects(personal20('20.001',randomUUID()),'wallet_funding_invalid_request');
  rejects(personal20('25000.01',randomUUID()),'wallet_funding_invalid_request');
  rejects(personal20("'NaN'::numeric",randomUUID()),'wallet_funding_invalid_request');
  rejects(personal20('20',randomUUID(),`0x${'9'.repeat(40)}`),'wallet_funding_wallet_not_linked');
  rejects(personal20('21'),'wallet_funding_request_already_used');
  rejects(admin('usd20-member',`0x${'9'.repeat(40)}`,'20',randomUUID()),'wallet_funding_invalid_request');
  rejects(admin('usd20-member',`0x${'9'.repeat(40)}`,'49.99',randomUUID()),'wallet_funding_invalid_request');
  assert.match(value(admin('usd20-member',`0x${'9'.repeat(40)}`,'50',randomUUID())),/\|t\|initiated$/); probes++;
  equal(`SELECT requested_amount::text FROM payments.read_wallet_funding_status('usd20-member','personal','${personal20Id}');`,'20.00');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_status('bob','personal','${personal20Id}');`,'0');
  equal(`SELECT has_table_privilege('${role}','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('${role}','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE');`,'f',false);
  equal(`SELECT md5((SELECT json_agg(m ORDER BY id)::text FROM mlm.wallet_movement m)||(SELECT json_agg(a ORDER BY id)::text FROM payments.meld_onramp_attempt a));`,ledgerBefore,false);
  const repeated20=psql(usd20Migration,true);
  assert.notEqual(repeated20.status,0); assert.match(repeated20.stderr,/personal_usd20_requires_fresh_review/); probes++;


  const beforeMxn=value(statusSnapshot,false);
  const catalogBeforeMxn=value('SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM mlm.package p;',false);
  for(const [signature,modify] of [
    ['payments.read_wallet_funding_history(text,text)',source=>source.replace('LIMIT 20','LIMIT 19')],
    ['payments.read_wallet_funding_status(text,text,uuid)',source=>source.replace('IF p_reference IS NULL THEN','IF p_reference IS NULL OR false THEN')],
  ]){
    const original=value(`SELECT pg_get_functiondef('${signature}'::regprocedure);`,false);
    const changed=modify(original);assert.notEqual(changed,original);probes++;
    psql(changed);
    const rejected=psql(mxnMigration,true);assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/personal_mxn_requires_fresh_review/);probes++;
    equal(`SELECT to_regprocedure('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text,text)') IS NULL;`,'t',false);
    equal(statusSnapshot,beforeMxn,false);
    psql(original);
  }
  psql(mxnMigration);
  equal(statusSnapshot,beforeMxn,false);
  equal('SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM mlm.package p;',catalogBeforeMxn,false);
  const mxnId=randomUUID();
  const localIntent=(amount='10',id=mxnId,country='MX',method='SPEI',currency='MXN',address=`0x${'8'.repeat(40)}`,subject='usd20-member')=>
    `SELECT * FROM payments.create_reown_funding_intent('${subject}','${address}','${country}',${amount},'${id}','${method}','${currency}');`;
  const localResult=value(localIntent());
  assert.match(localResult,new RegExp(`^${mxnId}\\|`));probes++;
  equal(localIntent(),localResult);
  rejects(localIntent('10',randomUUID(),'US'),'wallet_funding_invalid_request');
  rejects(localIntent('10',randomUUID(),'MX','CREDIT_DEBIT_CARD'),'wallet_funding_invalid_request');
  rejects(localIntent('10',randomUUID(),'MX','SPEI','COP'),'wallet_funding_invalid_request');
  rejects(localIntent('0',randomUUID()),'wallet_funding_invalid_request');
  rejects(localIntent('-1',randomUUID()),'wallet_funding_invalid_request');
  rejects(localIntent('10.001',randomUUID()),'wallet_funding_invalid_request');
  rejects(localIntent('1000000000.01',randomUUID()),'wallet_funding_invalid_request');
  rejects(localIntent("'NaN'::numeric",randomUUID()),'wallet_funding_invalid_request');
  rejects(localIntent('10',randomUUID(),'MX','SPEI','USD'),'wallet_funding_invalid_request');
  rejects(localIntent('10',randomUUID(),'MX','SPEI','MXN',`0x${'9'.repeat(40)}`),'wallet_funding_wallet_not_linked');
  rejects(localIntent('10',randomUUID(),'MX','SPEI','MXN',`0x${'8'.repeat(40)}`,'blocked'),'wallet_funding_forbidden');
  rejects(localIntent('11'),'wallet_funding_request_already_used');
  const mxnSame20=randomUUID(); value(localIntent('20',mxnSame20));
  rejects(`SELECT * FROM payments.create_reown_funding_intent('usd20-member','0x${'8'.repeat(40)}','MX',20,'${mxnSame20}','SPEI');`,'wallet_funding_request_already_used');
  rejects(localIntent('20',personal20Id), 'wallet_funding_request_already_used');
  // A valid existing USD request still replays through the warm six-argument API.
  equal(personal20(),accepted20);
  equal(`SELECT requested_amount||'|'||source_currency||'|'||payment_method FROM payments.read_wallet_funding_status_v2('usd20-member','personal','${mxnId}');`,'10.00|MXN|SPEI');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_history('usd20-member','personal') WHERE id='${mxnId}';`,'0');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_status('usd20-member','personal','${mxnId}');`,'0');
  equal(`SELECT source_currency FROM payments.read_wallet_funding_status_v2('usd20-member','personal','${personal20Id}');`,'USD');
  equal(`SELECT source_currency||'|'||payment_method FROM payments.read_wallet_funding_history_v2('usd20-member','personal') WHERE id='${mxnId}';`,'MXN|SPEI');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_status_v2('bob','personal','${mxnId}');`,'0');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_status_v2('usd20-member','administrative','${mxnId}');`,'0');
  rejects(`SELECT * FROM payments.read_wallet_funding_status_v2('blocked','personal','${mxnId}');`,'wallet_funding_forbidden');
  rejects(`SELECT * FROM payments.read_wallet_funding_status_v2('usd20-member','both','${mxnId}');`,'wallet_funding_invalid_kind');
  equal(`SELECT bool_and(source_currency='USD' AND requested_amount>=50) FROM payments.read_wallet_funding_history_v2('usd20-member','administrative');`,'t');
  for(const signature of ['payments.create_reown_funding_intent(text,text,text,numeric,uuid,text,text)','payments.read_wallet_funding_history_v2(text,text)','payments.read_wallet_funding_status_v2(text,text,uuid)']){
    equal(`SELECT has_function_privilege('${role}','${signature}','EXECUTE') AND NOT has_function_privilege('app_read','${signature}','EXECUTE');`,'t',false);
    equal(`SELECT prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[] FROM pg_proc WHERE oid='${signature}'::regprocedure;`,'t',false);
  }
  equal(`SELECT has_table_privilege('${role}','payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('${role}','payments.meld_sandbox_funding_attempt','SELECT,INSERT,UPDATE,DELETE');`,'f',false);
  equal(`SELECT md5((SELECT json_agg(m ORDER BY id)::text FROM mlm.wallet_movement m)||(SELECT json_agg(a ORDER BY id)::text FROM payments.meld_onramp_attempt a));`,ledgerBefore,false);
  const mxnProfile=value(`SELECT json_build_object('writer6',md5(pg_get_functiondef('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text)'::regprocedure)),
    'writer7',md5(pg_get_functiondef('payments.create_reown_funding_intent(text,text,text,numeric,uuid,text,text)'::regprocedure)),
    'historyV2',md5(pg_get_functiondef('payments.read_wallet_funding_history_v2(text,text)'::regprocedure)),
    'statusV2',md5(pg_get_functiondef('payments.read_wallet_funding_status_v2(text,text,uuid)'::regprocedure)),
    'amountCheck',(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='payments.reown_funding_intent'::regclass AND conname='reown_funding_intent_requested_amount_check'))::text;`,false);
  const duplicateMxn=psql(mxnMigration,true);assert.notEqual(duplicateMxn.status,0);assert.match(duplicateMxn.stderr,/personal_mxn_requires_fresh_review/);probes++;

  // A company transfer is a separate receipt registry, never a funding/ledger
  // entry or an automatic membership allocation. All addresses/data are synthetic.
  const beforeCompany=value(statusSnapshot,false);
  const companyCatalog=value('SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM mlm.package p;',false);
  psql(`INSERT INTO auth."user" VALUES('company-owner',true),('company-other',true),('company-rate',true),('company-race',true),('company-race-a',true),('company-race-b',true),('company-abandon',true),('company-abandon-race',true);
    INSERT INTO identity.wallet_binding VALUES('company-owner','0x${'a'.repeat(40)}'),('company-other','0x${'b'.repeat(40)}'),
    ('company-rate','0x${'c'.repeat(40)}'),('company-race','0x${'d'.repeat(40)}'),('company-race-a','0x${'e'.repeat(40)}'),('company-race-b','0x${'f'.repeat(40)}'),
    ('company-abandon','0x${'12'.repeat(20)}'),('company-abandon-race','0x${'34'.repeat(20)}');
    ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT EXECUTE ON FUNCTIONS TO app_read;`);
  psql(companyMigration);
  equal(statusSnapshot,beforeCompany,false);
  equal('SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM mlm.package p;',companyCatalog,false);
  const companyId=randomUUID(),otherCompanyId=randomUUID();
  const companyHash=`0x${'a'.repeat(64)}`,otherHash=`0x${'b'.repeat(64)}`,blockHash=`0x${'c'.repeat(64)}`;
  const maxUint='115792089237316195423570985008687907853269984665640564039457584007913129639935';
  const companyPrepare=(amount='123456789',id=companyId,subject='company-owner',address=`0x${'a'.repeat(40)}`)=>
    `SELECT status FROM payments.prepare_personal_company_payment('${subject}','${address}',${amount===null?'NULL':`'${amount}'`},'${id}');`;
  const companySubmit=(id=companyId,hash=companyHash,subject='company-owner')=>
    `SELECT status FROM payments.submit_personal_company_payment('${subject}','${id}','${hash}');`;
  const companyVerify=(id=companyId,hash=companyHash,block='80000000',blockValue=blockHash,confirmations='12',subject='company-owner')=>
    `SELECT status FROM payments.verify_personal_company_payment('${subject}','${id}','${hash}',${block===null?'NULL':`'${block}'`},'${blockValue}',${confirmations});`;
  const companyReject=(id=companyId,hash=companyHash,reason='transaction_reverted',subject='company-owner')=>
    `SELECT status FROM payments.reject_personal_company_payment('${subject}','${id}','${hash}','${reason}');`;
  const companyAbandon=(id,subject='company-abandon')=>`SELECT abandoned_at IS NOT NULL FROM payments.abandon_personal_company_payment('${subject}','${id}');`;
  for(const bad of [null,'0','-1','01','1.0',' 1','1e6','NaN','Infinity','9'.repeat(79),'115792089237316195423570985008687907853269984665640564039457584007913129639936']) {
    rejects(companyPrepare(bad),'company_payment_invalid_request');
  }
  rejects(companyPrepare('1',randomUUID(),'blocked'),'company_payment_forbidden');
  rejects(companyPrepare('1',randomUUID(),'company-owner',`0x${'b'.repeat(40)}`),'company_payment_forbidden');
  equal(companyPrepare(),'prepared');
  equal(companyPrepare(),'prepared');
  equal(`SELECT amount_atomic||'|'||purpose||'|'||chain_id||'|'||token_address||'|'||token_decimals||'|'||recipient_address FROM payments.personal_company_payment WHERE id='${companyId}';`,
    '123456789|company_payment|137|0xc2132d05d31c914a87c6611c10748aeb04b58e8f|6|0x0a600b03ef5f8e7f3e182b83440c6d292033db0e',false);
  equal(`SELECT expires_at-created_at=interval '15 minutes' FROM payments.read_personal_company_payment('company-owner','${companyId}');`,'t');
  rejects(companyPrepare('123456790'),'company_payment_request_already_used');
  rejects(companyPrepare('123456789',companyId,'company-other',`0x${'b'.repeat(40)}`),'company_payment_request_already_used');
  rejects(companyPrepare('1',randomUUID()),'company_payment_pending_exists');
  equal(`SELECT count(*) FROM payments.read_personal_company_payment('company-other','${companyId}');`,'0');
  rejects(`SELECT * FROM payments.read_personal_company_payment('blocked','${companyId}');`,'company_payment_forbidden');
  rejects(`SELECT * FROM payments.read_personal_company_payment('company-owner',NULL);`,'company_payment_invalid_request');
  rejects(companyVerify(),'company_payment_confirmation_conflict');
  rejects(companySubmit(companyId,companyHash,'company-other'),'company_payment_not_found');
  rejects(companySubmit(companyId,'0xA'+ 'a'.repeat(63)),'company_payment_invalid_request');
  equal(companySubmit(),'submitted');
  equal(companySubmit(),'submitted');
  rejects(companySubmit(companyId,otherHash),'company_payment_request_already_used');
  rejects(companyPrepare('1',randomUUID()),'company_payment_pending_exists');
  for(const args of [[companyId,otherHash],[companyId,companyHash,'0'],[companyId,companyHash,'80000000',blockHash,'11'],
    [companyId,companyHash,'80000000',blockHash,'NULL'],[companyId,companyHash,null],
    [companyId,companyHash,'9223372036854775808'],[companyId,companyHash,'080000000'],[companyId,companyHash,'NaN']]) {
    rejects(companyVerify(...args),args[1]===otherHash?'company_payment_confirmation_conflict':'company_payment_verification_invalid');
  }
  equal(companyVerify(),'confirmed');
  equal(companyVerify(companyId,companyHash,'80000000',blockHash,'20'),'confirmed');
  equal(`SELECT confirmations FROM payments.read_personal_company_payment('company-owner','${companyId}');`,'12');
  equal(companyPrepare(),'confirmed');
  rejects(companyVerify(companyId,companyHash,'80000001'),'company_payment_confirmation_conflict');
  rejects(companyVerify(companyId,companyHash,'80000000',otherHash),'company_payment_confirmation_conflict');
  rejects(companyReject(),'company_payment_invalid_transition');
  equal(companyPrepare(maxUint,otherCompanyId,'company-other',`0x${'b'.repeat(40)}`),'prepared');
  rejects(companySubmit(otherCompanyId,companyHash,'company-other'),'company_payment_hash_reused');
  equal(companySubmit(otherCompanyId,otherHash,'company-other'),'submitted');
  rejects(companyReject(otherCompanyId,otherHash,'rpc_timeout','company-other'),'company_payment_invalid_request');
  equal(companyReject(otherCompanyId,otherHash,'transaction_reverted','company-other'),'failed');
  equal(companyReject(otherCompanyId,otherHash,'transaction_reverted','company-other'),'failed');
  rejects(companyReject(otherCompanyId,otherHash,'transaction_mismatch','company-other'),'company_payment_invalid_transition');
  rejects(companyVerify(otherCompanyId,otherHash,'80000000',blockHash,'12','company-other'),'company_payment_invalid_transition');
  equal(`SELECT amount_atomic FROM payments.read_personal_company_payment('company-other','${otherCompanyId}');`,maxUint);
  const immutable=(statement,pattern)=>{const result=psql(statement,true);assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(pattern));probes++;};
  immutable(`UPDATE payments.personal_company_payment SET amount_atomic='1' WHERE id='${companyId}';`,'company_payment_snapshot_immutable');
  immutable(`UPDATE payments.personal_company_payment SET recipient_address='0x${'1'.repeat(40)}' WHERE id='${companyId}';`,'company_payment_snapshot_immutable');
  immutable(`UPDATE payments.personal_company_payment SET transaction_hash='0x${'9'.repeat(64)}' WHERE id='${companyId}';`,'company_payment_snapshot_immutable');
  immutable(`UPDATE payments.personal_company_payment SET confirmations=20 WHERE id='${companyId}';`,'company_payment_invalid_transition');
  immutable(`DELETE FROM payments.personal_company_payment WHERE id='${companyId}';`,'company_payment_delete_forbidden');
  rejects('SELECT * FROM payments.personal_company_payment;','permission denied');
  equal(`SELECT has_table_privilege('app_read','payments.personal_company_payment','SELECT');`,'f',false);
  psql(`GRANT SELECT ON payments.personal_company_payment TO ${role};`);
  equal('SELECT count(*) FROM payments.personal_company_payment;','0');
  psql(`REVOKE SELECT ON payments.personal_company_payment FROM ${role};`);
  const expiredCompanyId=randomUUID(),expiredHash=`0x${'d'.repeat(64)}`;
  psql(`INSERT INTO payments.personal_company_payment(id,subject,wallet_address,amount_atomic,created_at,expires_at)
    VALUES('${expiredCompanyId}','company-owner','0x${'a'.repeat(40)}','1',now()-interval '16 minutes',now()-interval '1 minute');`);
  equal(companySubmit(expiredCompanyId,expiredHash),'submitted');
  equal(companyReject(expiredCompanyId,expiredHash,'transaction_mismatch'),'failed');
  for(let n=1;n<=5;n++){
    const id=randomUUID(),hash=`0x${String(n).padStart(64,'0')}`;
    equal(companyPrepare('1',id,'company-rate',`0x${'c'.repeat(40)}`),'prepared');
    equal(companySubmit(id,hash,'company-rate'),'submitted');
    equal(companyReject(id,hash,'transaction_reverted','company-rate'),'failed');
  }
  rejects(companyPrepare('1',randomUUID(),'company-rate',`0x${'c'.repeat(40)}`),'company_payment_rate_limited');
  const companyRace=await Promise.all([parallelPsql(companyPrepare('1',randomUUID(),'company-race',`0x${'d'.repeat(40)}`)),
    parallelPsql(companyPrepare('1',randomUUID(),'company-race',`0x${'d'.repeat(40)}`))]);
  assert.equal(companyRace.filter(item=>item.status===0).length,1);probes++;
  assert.match(companyRace.find(item=>item.status!==0).stderr,/company_payment_pending_exists/);probes++;
  const raceA=randomUUID(),raceB=randomUUID(),raceHash=`0x${'e'.repeat(64)}`;
  equal(companyPrepare('1',raceA,'company-race-a',`0x${'e'.repeat(40)}`),'prepared');
  equal(companyPrepare('1',raceB,'company-race-b',`0x${'f'.repeat(40)}`),'prepared');
  const hashRace=await Promise.all([parallelPsql(companySubmit(raceA,raceHash,'company-race-a')),parallelPsql(companySubmit(raceB,raceHash,'company-race-b'))]);
  assert.equal(hashRace.filter(item=>item.status===0).length,1);probes++;
  assert.match(hashRace.find(item=>item.status!==0).stderr,/company_payment_hash_reused/);probes++;
  psql(`INSERT INTO payments.personal_company_payment(id,subject,wallet_address,amount_atomic,status,transaction_hash,submitted_at,failed_at,failure_reason,created_at,expires_at)
    SELECT gen_random_uuid(),'company-other','0x${'b'.repeat(40)}','1','failed','0x'||lpad((100+g)::text,64,'0'),now()-g*interval '1 day',now()-g*interval '1 day',
      'transaction_reverted',now()-g*interval '1 day',now()-g*interval '1 day'+interval '15 minutes' FROM generate_series(1,21) g;`);
  equal(`SELECT count(*) FROM payments.read_personal_company_payment_history('company-other');`,'20');
  equal(`SELECT bool_and(wallet_address='0x${'b'.repeat(40)}') FROM payments.read_personal_company_payment_history('company-other');`,'t');
  rejects(`SELECT * FROM payments.read_personal_company_payment_history('blocked');`,'company_payment_forbidden');
  const abandonedId=randomUUID(),nextDraftId=randomUUID(),thirdDraftId=randomUUID(),lateHash=`0x${'8'.repeat(64)}`;
  equal(companyPrepare('10',abandonedId,'company-abandon',`0x${'12'.repeat(20)}`),'prepared');
  const unsignedSnapshot=value(`SELECT (to_jsonb(r)-'abandoned_at')::text FROM payments.personal_company_payment r WHERE id='${abandonedId}';`,false);
  rejects(companyAbandon(abandonedId,'company-other'),'company_payment_not_found');
  equal(companyAbandon(abandonedId),'t');
  const abandonedAt=value(`SELECT abandoned_at FROM payments.read_personal_company_payment('company-abandon','${abandonedId}');`);
  equal(companyAbandon(abandonedId),'t');
  equal(`SELECT abandoned_at FROM payments.read_personal_company_payment('company-abandon','${abandonedId}');`,abandonedAt);
  equal(`SELECT (to_jsonb(r)-'abandoned_at')::text FROM payments.personal_company_payment r WHERE id='${abandonedId}';`,unsignedSnapshot,false);
  equal(companyPrepare('10',abandonedId,'company-abandon',`0x${'12'.repeat(20)}`),'prepared');
  equal(`SELECT abandoned_at IS NOT NULL FROM payments.prepare_personal_company_payment('company-abandon','0x${'12'.repeat(20)}','10','${abandonedId}');`,'t');
  equal(companyPrepare('20',nextDraftId,'company-abandon',`0x${'12'.repeat(20)}`),'prepared');
  equal(companySubmit(abandonedId,lateHash,'company-abandon'),'submitted');
  equal(`SELECT abandoned_at FROM payments.read_personal_company_payment('company-abandon','${abandonedId}');`,abandonedAt);
  rejects(companyPrepare('30',thirdDraftId,'company-abandon',`0x${'12'.repeat(20)}`),'company_payment_pending_exists');
  rejects(companyAbandon(abandonedId),'company_payment_invalid_transition');
  equal(companyVerify(abandonedId,lateHash,'80000000',blockHash,'12','company-abandon'),'confirmed');
  equal(`SELECT abandoned_at FROM payments.read_personal_company_payment('company-abandon','${abandonedId}');`,abandonedAt);
  rejects(companyAbandon(abandonedId),'company_payment_invalid_transition');
  immutable(`UPDATE payments.personal_company_payment SET abandoned_at=NULL WHERE id='${abandonedId}';`,'company_payment_snapshot_immutable');
  equal(companyAbandon(nextDraftId),'t');
  equal(companyPrepare('30',thirdDraftId,'company-abandon',`0x${'12'.repeat(20)}`),'prepared');
  equal(`SELECT count(*) FROM payments.read_personal_company_payment_history('company-abandon') WHERE abandoned_at IS NOT NULL;`,'2');
  const abandonRaceId=randomUUID(),abandonRaceHash=`0x${'7'.repeat(64)}`;
  equal(companyPrepare('1',abandonRaceId,'company-abandon-race',`0x${'34'.repeat(20)}`),'prepared');
  const abandonRace=await Promise.all([parallelPsql(companyAbandon(abandonRaceId,'company-abandon-race')),
    parallelPsql(companySubmit(abandonRaceId,abandonRaceHash,'company-abandon-race'))]);
  assert.equal(abandonRace[1].status,0,'a concurrent abandon must never discard a real broadcast hash');probes++;
  if(abandonRace[0].status!==0)assert.match(abandonRace[0].stderr,/company_payment_invalid_transition/);probes++;
  equal(`SELECT status||'|'||transaction_hash||'|'||amount_atomic FROM payments.read_personal_company_payment('company-abandon-race','${abandonRaceId}');`,
    `submitted|${abandonRaceHash}|1`);
  for(const signature of ['payments.read_personal_company_payment(text,uuid)','payments.read_personal_company_payment_history(text)',
    'payments.prepare_personal_company_payment(text,text,text,uuid)','payments.submit_personal_company_payment(text,uuid,text)',
    'payments.verify_personal_company_payment(text,uuid,text,text,text,integer)','payments.reject_personal_company_payment(text,uuid,text,text)',
    'payments.abandon_personal_company_payment(text,uuid)']){
    equal(`SELECT has_function_privilege('${role}','${signature}','EXECUTE') AND NOT has_function_privilege('app_read','${signature}','EXECUTE');`,'t',false);
    equal(`SELECT prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[] FROM pg_proc WHERE oid='${signature}'::regprocedure;`,'t',false);
  }
  equal(`SELECT has_function_privilege('${role}','payments.assert_personal_company_payment_owner(text,text)','EXECUTE');`,'f',false);
  equal(statusSnapshot,beforeCompany,false);
  equal('SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM mlm.package p;',companyCatalog,false);
  const companyProfile=JSON.parse(value(`SELECT jsonb_object_agg(p.proname,md5(pg_get_functiondef(p.oid)) ORDER BY p.proname) FROM pg_proc p
    WHERE p.pronamespace='payments'::regnamespace AND p.proname LIKE '%personal_company_payment%';`,false));
  const duplicateCompany=psql(companyMigration,true);assert.notEqual(duplicateCompany.status,0);assert.match(duplicateCompany.stderr,/company_payment_fresh_prerequisites_required/);probes++;

  // Preserve pre-cutover snapshots exactly; Ethereum is a new request policy,
  // never a reinterpretation of a historical Polygon transaction or onramp.
  const ethereumAddress = `0x${'9a'.repeat(20)}`;
  const ethereumFundingAddress = `0x${'9b'.repeat(20)}`;
  const legacyAddress = `0x${'9c'.repeat(20)}`;
  psql(`INSERT INTO auth."user" VALUES('ethereum-company',true),('ethereum-funding',true),('ethereum-legacy',true);
    INSERT INTO identity.wallet_binding VALUES('ethereum-company','${ethereumAddress}'),('ethereum-funding','${ethereumFundingAddress}'),('ethereum-legacy','${legacyAddress}');`);
  const legacyDraft = randomUUID(), ethereumDraft = randomUUID();
  equal(companyPrepare('123000000',legacyDraft,'ethereum-legacy',legacyAddress),'prepared');
  const cutoverSnapshot=`SELECT md5((SELECT jsonb_agg(to_jsonb(r) ORDER BY id)::text FROM payments.personal_company_payment r)||
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id)::text FROM payments.reown_funding_intent r)||
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id)::text FROM payments.meld_sandbox_funding_attempt r));`;
  const beforeEthereum=value(cutoverSnapshot,false);
  const disabledGuard=psql(`BEGIN;ALTER TABLE payments.personal_company_payment DISABLE TRIGGER personal_company_payment_immutable;
    ${ethereumMigration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'')}`,true);
  assert.notEqual(disabledGuard.status,0);assert.match(disabledGuard.stderr,/personal_ethereum_runtime_isolation_required/);probes++;
  psql(ethereumMigration);
  equal(cutoverSnapshot,beforeEthereum,false);
  const ethereumPrepare=(amount='123000000',id=ethereumDraft,owner='ethereum-company',sender=ethereumAddress)=>
    `SELECT chain_id||'|'||token_address||'|'||amount_atomic||'|'||status FROM payments.prepare_personal_company_payment_v2('${owner}','${sender}','${amount}','${id}');`;
  const ethereumFunding=(amount='30',id=randomUUID(),country='US',currency='USD',method='CREDIT_DEBIT_CARD',owner='ethereum-funding',sender=ethereumFundingAddress)=>
    `SELECT id FROM payments.create_reown_funding_intent_v3('${owner}','${sender}','${country}',${amount},'${id}','${method}','${currency}');`;
  const ethereumToken='0xdac17f958d2ee523a2206206994597c13d831ec7';
  equal(ethereumPrepare(),`1|${ethereumToken}|123000000|prepared`);
  equal(ethereumPrepare(),`1|${ethereumToken}|123000000|prepared`);
  rejects(ethereumPrepare('124000000'),'company_payment_request_already_used');
  rejects(companyPrepare('1',randomUUID(),'ethereum-company',ethereumAddress),'company_payment_network_changed');
  rejects(ethereumPrepare('123000000',legacyDraft,'ethereum-legacy',legacyAddress),'company_payment_request_already_used');
  rejects(ethereumPrepare('123000000',randomUUID(),'ethereum-legacy',legacyAddress),'company_payment_pending_exists');
  equal(`SELECT chain_id FROM payments.read_personal_company_payment('ethereum-legacy','${legacyDraft}');`,'137');
  equal(`SELECT abandoned_at IS NOT NULL FROM payments.abandon_personal_company_payment('ethereum-legacy','${legacyDraft}');`,'t');
  equal(ethereumPrepare('1',randomUUID(),'ethereum-legacy',legacyAddress),`1|${ethereumToken}|1|prepared`);
  const lateLegacyHash=`0x${'9d'.repeat(32)}`;
  equal(companySubmit(legacyDraft,lateLegacyHash,'ethereum-legacy'),'submitted');
  equal(companyVerify(legacyDraft,lateLegacyHash,'80000001',blockHash,'12','ethereum-legacy'),'confirmed');
  equal(`SELECT chain_id||'|'||token_address||'|'||amount_atomic FROM payments.read_personal_company_payment('ethereum-legacy','${legacyDraft}');`,
    '137|0xc2132d05d31c914a87c6611c10748aeb04b58e8f|123000000');
  immutable(`UPDATE payments.personal_company_payment SET chain_id=1,token_address='${ethereumToken}' WHERE id='${legacyDraft}';`,'company_payment_snapshot_immutable');
  immutable(`UPDATE payments.personal_company_payment SET chain_id=137,token_address='0xc2132d05d31c914a87c6611c10748aeb04b58e8f' WHERE id='${ethereumDraft}';`,'company_payment_snapshot_immutable');
  const wrongPair=psql(`INSERT INTO payments.personal_company_payment(id,subject,wallet_address,amount_atomic,chain_id,token_address)
    VALUES(gen_random_uuid(),'ethereum-company','${ethereumAddress}','1',137,'${ethereumToken}');`,true);
  assert.notEqual(wrongPair.status,0);assert.match(wrongPair.stderr,/personal_company_payment_chain_asset_check/);probes++;
  const ethereumFundingId=randomUUID(), speiFundingId=randomUUID(), colombiaFundingId=randomUUID();
  equal(ethereumFunding('30',ethereumFundingId),ethereumFundingId);
  equal(ethereumFunding('30',ethereumFundingId),ethereumFundingId);
  equal(ethereumFunding('931',speiFundingId,'MX','MXN','SPEI'),speiFundingId);
  equal(ethereumFunding('30',colombiaFundingId,'CO'),colombiaFundingId);
  equal(`SELECT destination_currency FROM payments.read_wallet_funding_status_v3('ethereum-funding','personal','${ethereumFundingId}');`,'USDT');
  equal(`SELECT source_currency||'|'||payment_method||'|'||destination_currency FROM payments.read_wallet_funding_status_v3('ethereum-funding','personal','${speiFundingId}');`,'MXN|SPEI|USDT');
  equal(`SELECT destination_currency FROM payments.read_wallet_funding_status_v3('bob','personal','${bobId}');`,'USDT_POLYGON');
  equal(`SELECT destination_currency FROM payments.read_wallet_funding_status_v3('alice','administrative','${requestId}');`,'USDT_POLYGON');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_status_v2('ethereum-funding','personal','${ethereumFundingId}');`,'0');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_status('ethereum-funding','personal','${ethereumFundingId}');`,'0');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_history_v2('ethereum-funding','personal');`,'0');
  equal(`SELECT count(*) FROM payments.read_wallet_funding_history('ethereum-funding','personal');`,'0');
  equal(`SELECT bool_and(destination_currency='USDT') FROM payments.read_wallet_funding_history_v3('ethereum-funding','personal');`,'t');
  rejects(ethereumFunding('100',bobId,'CO','USD','CREDIT_DEBIT_CARD','bob',bobPersonalAddress),'wallet_funding_request_already_used');
  rejects(`SELECT * FROM payments.create_reown_funding_intent('ethereum-funding','${ethereumFundingAddress}','US',30,'${randomUUID()}','CREDIT_DEBIT_CARD','USD');`,'wallet_funding_network_changed');
  rejects(`SELECT * FROM payments.create_reown_funding_intent('ethereum-funding','${ethereumFundingAddress}','US',30,'${randomUUID()}','CREDIT_DEBIT_CARD');`,'wallet_funding_network_changed');
  for(const method of ['NETELLER','SKRILL']) rejects(ethereumFunding('30',randomUUID(),'CO','USD',method),'wallet_funding_invalid_request');
  for(const amount of ['29.99','15000.01',"'NaN'::numeric"]) rejects(ethereumFunding(amount),'wallet_funding_invalid_request');
  rejects(ethereumFunding('930.99',randomUUID(),'MX','MXN','SPEI'),'wallet_funding_invalid_request');
  rejects(ethereumFunding('931',randomUUID(),'CO','MXN','SPEI'),'wallet_funding_invalid_request');
  rejects(ethereumFunding('931',randomUUID(),'MX','MXN','CREDIT_DEBIT_CARD'),'wallet_funding_invalid_request');
  rejects(ethereumFunding('30',randomUUID(),'CO','COP'),'wallet_funding_invalid_request');
  rejects(ethereumFunding('30',randomUUID(),'ES'),'wallet_funding_invalid_request');
  rejects(ethereumFunding('30',randomUUID(),'US','USD','CREDIT_DEBIT_CARD','blocked',ethereumFundingAddress),'wallet_funding_forbidden');
  rejects(ethereumFunding('30',randomUUID(),'US','USD','CREDIT_DEBIT_CARD','bob',ethereumFundingAddress),'wallet_funding_wallet_not_linked');
  for(const signature of ['payments.prepare_personal_company_payment_v2(text,text,text,uuid)',
    'payments.create_reown_funding_intent_v3(text,text,text,numeric,uuid,text,text)',
    'payments.read_wallet_funding_history_v3(text,text)','payments.read_wallet_funding_status_v3(text,text,uuid)']){
    equal(`SELECT has_function_privilege('${role}','${signature}','EXECUTE') AND NOT has_function_privilege('app_read','${signature}','EXECUTE');`,'t',false);
    equal(`SELECT prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[] FROM pg_proc WHERE oid='${signature}'::regprocedure;`,'t',false);
  }
  const duplicateEthereum=psql(ethereumMigration,true);assert.notEqual(duplicateEthereum.status,0);
  assert.match(duplicateEthereum.stderr,/personal_ethereum_requires_fresh_review/);probes++;
  const ethereumProfile=JSON.parse(value(`SELECT jsonb_object_agg(p.proname,md5(pg_get_functiondef(p.oid)) ORDER BY p.proname)
    FROM pg_proc p WHERE p.pronamespace='payments'::regnamespace AND p.proname IN('prepare_personal_company_payment_v2',
     'create_reown_funding_intent_v3','read_wallet_funding_history_v3','read_wallet_funding_status_v3');`,false));

  // Multichain creation is additive: one explicit chain per immutable request.
  // Old Ethereum-only creation and every historical record retain their policy.
  const multiAddress=`0x${'ad'.repeat(20)}`,multiRateAddress=`0x${'ae'.repeat(20)}`,multiRaceAddress=`0x${'af'.repeat(20)}`;
  psql(`INSERT INTO auth."user" VALUES('multichain-owner',true),('multichain-rate',true),('multichain-race',true);
    INSERT INTO identity.wallet_binding VALUES('multichain-owner','${multiAddress}'),('multichain-rate','${multiRateAddress}'),('multichain-race','${multiRaceAddress}');`);
  const beforeMultichain=value(cutoverSnapshot,false);
  const priorFunctionSnapshot=`SELECT md5(jsonb_agg(jsonb_build_array(p.oid,pg_get_functiondef(p.oid),p.proacl::text) ORDER BY p.oid)::text)
    FROM pg_proc p WHERE p.pronamespace='payments'::regnamespace AND p.prokind='f' AND p.proname<>'prepare_personal_company_payment_v3';`;
  const priorFunctions=value(priorFunctionSnapshot,false);
  const multiPolicySnapshot=`SELECT md5(jsonb_agg(jsonb_build_array(c.oid,pg_get_constraintdef(c.oid),c.convalidated) ORDER BY c.oid)::text)
    FROM pg_constraint c WHERE c.conrelid IN('payments.personal_company_payment'::regclass,'payments.reown_funding_intent'::regclass,
    'payments.meld_sandbox_funding_attempt'::regclass);`;
  const priorConstraints=value(multiPolicySnapshot,false);
  psql(multichainMigration);
  equal(cutoverSnapshot,beforeMultichain,false);
  equal(priorFunctionSnapshot,priorFunctions,false);
  equal(multiPolicySnapshot,priorConstraints,false);
  const multiPrepare=(chain='1',amount='123456789',id=randomUUID(),owner='multichain-owner',sender=multiAddress)=>
    `SELECT chain_id||'|'||token_address||'|'||recipient_address||'|'||token_decimals||'|'||amount_atomic||'|'||status FROM payments.prepare_personal_company_payment_v3(
      '${owner}','${sender}',${amount===null?'NULL':`'${amount}'`},'${id}',${chain});`;
  const companyRecipient='0x0a600b03ef5f8e7f3e182b83440c6d292033db0e',polygonToken='0xc2132d05d31c914a87c6611c10748aeb04b58e8f';
  for(const chain of ['NULL','0','10','56','8453','42161']) rejects(multiPrepare(chain),'company_payment_invalid_request');
  for(const bad of [null,'0','-1','01','1.0',' 1','1e6','NaN','Infinity','9'.repeat(79),
    '115792089237316195423570985008687907853269984665640564039457584007913129639936']) rejects(multiPrepare('137',bad),'company_payment_invalid_request');
  rejects(multiPrepare('137','1',randomUUID(),'blocked',multiAddress),'company_payment_forbidden');
  rejects(multiPrepare('1','1',randomUUID(),'bob',multiAddress),'company_payment_forbidden');
  const multiEthId=randomUUID(),multiPolygonId=randomUUID();
  const multiExpected=(chain,token,amount,status='prepared')=>`${chain}|${token}|${companyRecipient}|6|${amount}|${status}`;
  equal(multiPrepare('1','123456789',multiEthId),multiExpected(1,ethereumToken,'123456789'));
  equal(multiPrepare('1','123456789',multiEthId),multiExpected(1,ethereumToken,'123456789'));
  rejects(multiPrepare('137','123456789',multiEthId),'company_payment_request_already_used');
  rejects(multiPrepare('1','123456788',multiEthId),'company_payment_request_already_used');
  rejects(multiPrepare('137','123456789',multiPolygonId),'company_payment_pending_exists');
  // This SQL probe namespace must not reserve the joined API fixtures' a1/a2
  // transaction hashes in the same disposable, globally unique receipt table.
  const multiEthHash=`0x${'91'.repeat(32)}`,multiPolygonHash=`0x${'92'.repeat(32)}`;
  equal(companySubmit(multiEthId,multiEthHash,'multichain-owner'),'submitted');
  rejects(multiPrepare('137','123456789',multiPolygonId),'company_payment_pending_exists');
  equal(companyVerify(multiEthId,multiEthHash,'80000002',blockHash,'12','multichain-owner'),'confirmed');
  const multiEthTerminal=value(`SELECT to_jsonb(p)::text FROM payments.personal_company_payment p WHERE id='${multiEthId}';`,false);
  equal(multiPrepare('1','123456789',multiEthId),multiExpected(1,ethereumToken,'123456789','confirmed'));
  equal(`SELECT to_jsonb(p)::text FROM payments.personal_company_payment p WHERE id='${multiEthId}';`,multiEthTerminal,false);
  equal(multiPrepare('137','28433366',multiPolygonId),multiExpected(137,polygonToken,'28433366'));
  equal(multiPrepare('137','28433366',multiPolygonId),multiExpected(137,polygonToken,'28433366'));
  rejects(multiPrepare('1','28433366',multiPolygonId),'company_payment_request_already_used');
  rejects(ethereumPrepare('28433366',multiPolygonId,'multichain-owner',multiAddress),'company_payment_request_already_used');
  rejects(companyPrepare('1',randomUUID(),'multichain-owner',multiAddress),'company_payment_network_changed');
  equal(companySubmit(multiPolygonId,multiPolygonHash,'multichain-owner'),'submitted');
  equal(companyVerify(multiPolygonId,multiPolygonHash,'80000003',blockHash,'12','multichain-owner'),'confirmed');
  const multiPolygonTerminal=value(`SELECT to_jsonb(p)::text FROM payments.personal_company_payment p WHERE id='${multiPolygonId}';`,false);
  equal(multiPrepare('137','28433366',multiPolygonId),multiExpected(137,polygonToken,'28433366','confirmed'));
  equal(`SELECT to_jsonb(p)::text FROM payments.personal_company_payment p WHERE id='${multiPolygonId}';`,multiPolygonTerminal,false);
  equal(`SELECT string_agg(chain_id::text,',' ORDER BY chain_id) FROM payments.read_personal_company_payment_history('multichain-owner');`,'1,137');
  immutable(`UPDATE payments.personal_company_payment SET chain_id=1,token_address='${ethereumToken}' WHERE id='${multiPolygonId}';`,'company_payment_snapshot_immutable');
  for(let index=0;index<5;index++) {
    const id=randomUUID(),chain=index%2?'137':'1',token=chain==='1'?ethereumToken:polygonToken;
    equal(multiPrepare(chain,'1',id,'multichain-rate',multiRateAddress),multiExpected(Number(chain),token,'1'));
    equal(`SELECT abandoned_at IS NOT NULL FROM payments.abandon_personal_company_payment('multichain-rate','${id}');`,'t');
  }
  rejects(multiPrepare('137','1',randomUUID(),'multichain-rate',multiRateAddress),'company_payment_rate_limited');
  const crossChainRace=await Promise.all(['1','137'].map(chain=>parallelPsql(multiPrepare(chain,'1',randomUUID(),'multichain-race',multiRaceAddress))));
  assert.equal(crossChainRace.filter(result=>result.status===0).length,1);
  assert.equal(crossChainRace.filter(result=>result.status!==0&&/company_payment_pending_exists/.test(result.stderr)).length,1);probes++;
  equal(`SELECT count(*) FROM payments.read_personal_company_payment_history('multichain-race');`,'1');
  const multiSignature='payments.prepare_personal_company_payment_v3(text,text,text,uuid,integer)';
  equal(`SELECT has_function_privilege('${role}','${multiSignature}','EXECUTE') AND NOT has_function_privilege('app_read','${multiSignature}','EXECUTE');`,'t',false);
  equal(`SELECT prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[] FROM pg_proc WHERE oid='${multiSignature}'::regprocedure;`,'t',false);
  equal(`SELECT has_table_privilege('${role}','payments.personal_company_payment','SELECT,INSERT,UPDATE,DELETE');`,'f',false);
  equal(priorFunctionSnapshot,priorFunctions,false);
  equal(multiPolicySnapshot,priorConstraints,false);
  const duplicateMultichain=psql(multichainMigration,true);assert.notEqual(duplicateMultichain.status,0);
  assert.match(duplicateMultichain.stderr,/personal_multichain_requires_fresh_review/);probes++;
  const multichainProfile=value(`SELECT md5(pg_get_functiondef('${multiSignature}'::regprocedure));`,false);

  if (personalFlow) {
    // Extend only this disposable fixture with the minimal registered-person
    // columns queried by the real API. No production DSN or host port exists.
    psql(`ALTER TABLE auth."user" ADD COLUMN email text,ADD COLUMN email_verified boolean NOT NULL DEFAULT true,ADD COLUMN name text;
      ALTER TABLE identity.wallet_binding ADD COLUMN chain_id integer NOT NULL DEFAULT 1,ADD COLUMN verified_at timestamptz NOT NULL DEFAULT now();
      CREATE TABLE identity.auth_binding(subject text PRIMARY KEY,provider text NOT NULL,person_id bigint NOT NULL);
      CREATE TABLE mlm.person(id bigint PRIMARY KEY,public_id bigint NOT NULL,email text,status text,blacklisted boolean,user_id text,is_admin boolean,
        phone_number text,first_name text,last_name text,birthday date);
      CREATE TABLE mlm.affiliate(person_id bigint,status text);
      CREATE TABLE mlm.blacklist(email_norm text,phone_last10 text,name_norm text,birthdate date);
      CREATE FUNCTION mlm.norm_email(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT lower(trim($1))';
      CREATE FUNCTION mlm.norm_phone10(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT right($1,10)';
      CREATE FUNCTION mlm.norm_name(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT lower(trim($1))';
      INSERT INTO auth."user"(id,eligible,email,email_verified,name) VALUES
        ('flow-card',true,'flow-card@example.invalid',true,'Synthetic Card'),('flow-spei',true,'flow-spei@example.invalid',true,'Synthetic SPEI');
      INSERT INTO identity.wallet_binding(subject,address) VALUES('flow-card','0x${'56'.repeat(20)}'),('flow-spei','0x${'78'.repeat(20)}');
      INSERT INTO identity.auth_binding VALUES('flow-card','better_auth',1001),('flow-spei','better_auth',1002);
      INSERT INTO mlm.person(id,public_id,email,status,blacklisted,user_id,is_admin,first_name,last_name) VALUES
        (1001,1001,'flow-card@example.invalid','active',false,'flow-card',false,'Synthetic','Card'),
        (1002,1002,'flow-spei@example.invalid','active',false,'flow-spei',false,'Synthetic','SPEI');
      CREATE ROLE personal_flow_fixture LOGIN INHERIT;
      GRANT ${role} TO personal_flow_fixture;
      GRANT USAGE ON SCHEMA auth,identity,mlm,payments TO personal_flow_fixture;
      GRANT SELECT ON auth."user",identity.wallet_binding,identity.auth_binding,mlm.person,mlm.affiliate,mlm.blacklist TO personal_flow_fixture;
      ALTER DATABASE ${database} SET mindbliss.personal_wallet_flow_fixture='isolated-v1';`);
    const isolatedSnapshot = `SELECT md5((SELECT jsonb_agg(m ORDER BY id)::text FROM mlm.wallet_movement m)||
      (SELECT jsonb_agg(a ORDER BY id)::text FROM payments.meld_onramp_attempt a)||
      (SELECT jsonb_agg(a ORDER BY id)::text FROM payments.meld_sandbox_funding_attempt a)||
      (SELECT jsonb_agg(p ORDER BY id)::text FROM mlm.package p));`;
    const beforeFlow = value(isolatedSnapshot, false);
    const source = fileURLToPath(new URL('../app/src', import.meta.url));
    const joined = docker(['run', '--rm', '--pull', 'never', '--network', `container:${container}`,
      '--mount', `type=bind,source=${source},target=/app/src,readonly`,
      '-e', 'PERSONAL_WALLET_FLOW_SYNTHETIC_DOCKER=1',
      '-e', `PERSONAL_WALLET_FLOW_DATABASE_URL=postgres://personal_flow_fixture@127.0.0.1:5432/${database}`,
      'mindbliss-company-payment-tests:20261111', 'bun', 'test', 'src/modules/payments/personal-wallet-flow.integration.test.ts']);
    if (joined.status !== 0) throw new Error(`Isolated joined flow failed: ${joined.stderr || joined.error?.message || 'test unavailable'}`);
    console.log(JSON.stringify({ personalWalletJoinedFlow: 'passed', scenarios: ['USD100-card-Ethereum', 'MXN931-SPEI-Ethereum', 'prefunded-Polygon-card-owner'],
      providerPurchases: 'mocked', tokenDeposits: 'mocked', database: 'real-disposable-postgres', realTransfers: 0,
      hostPorts: 0, externalNetwork: 'disabled', apiScenariosPassed: Number(joined.stderr.match(/(\d+) pass\b/)?.[1] || 0),
      apiAssertions: Number(joined.stderr.match(/(\d+) expect\(\) calls/)?.[1] || 0) }));
    equal(isolatedSnapshot, beforeFlow, false);
    equal(`SELECT count(*) FROM payments.personal_company_payment WHERE subject IN('flow-card','flow-spei') AND status='confirmed';`, '3', false);
    equal(`SELECT count(*) FROM payments.personal_company_payment WHERE subject IN('flow-card','flow-spei') AND status='confirmed' AND chain_id=1;`, '2', false);
    equal(`SELECT count(*) FROM payments.personal_company_payment WHERE subject IN('flow-card','flow-spei') AND status='confirmed' AND chain_id=137;`, '1', false);
    equal(`SELECT bool_and(status='initiated') FROM payments.reown_funding_intent WHERE subject IN('flow-card','flow-spei');`, 't', false);
    equal(`SELECT count(*) FROM payments.reown_funding_intent WHERE subject IN('flow-card','flow-spei');`, '2', false);
  }

  console.log(JSON.stringify({ walletFundingSchema: 'passed', probes, environment: 'disposable-postgres',
    externalNetwork: 'disabled', productionConnections: 0, ledgerUnchanged: true, companyProfile, ethereumProfile, multichainProfile, mxnProfile: JSON.parse(mxnProfile) }));
} catch (error) {
  // This harness contains synthetic data only; avoid dumping whole SQL fixtures.
  console.error(JSON.stringify({ walletFundingSchema: 'failed', message: error.message }));
  process.exitCode = 1;
} finally {
  const ownership = docker(['inspect', '--format', '{{ index .Config.Labels "mindbliss.synthetic" }}', container]);
  if (ownership.status === 0 && ownership.stdout.trim() === 'wallet-funding-schema'
    && /^mb-wallet-funding-test-[a-f0-9-]{36}$/.test(container)) docker(['rm', '--force', container]);
}
