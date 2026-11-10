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
const statusMigration = readFileSync(new URL('../_meta/migration/95_wallet_funding_status_reads.sql', import.meta.url), 'utf8');
const usd20Migration = readFileSync(new URL('../_meta/migration/96_personal_usd20_membership_catalog.sql', import.meta.url), 'utf8');
const mxnMigration = readFileSync(new URL('../_meta/migration/97_personal_mxn_spei_requests.sql', import.meta.url), 'utf8');
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

  console.log(JSON.stringify({ walletFundingSchema: 'passed', probes, environment: 'disposable-postgres',
    externalNetwork: 'disabled', productionConnections: 0, ledgerUnchanged: true, mxnProfile: JSON.parse(mxnProfile) }));
} catch (error) {
  // This harness contains synthetic data only; avoid dumping whole SQL fixtures.
  console.error(JSON.stringify({ walletFundingSchema: 'failed', message: error.message }));
  process.exitCode = 1;
} finally {
  const ownership = docker(['inspect', '--format', '{{ index .Config.Labels "mindbliss.synthetic" }}', container]);
  if (ownership.status === 0 && ownership.stdout.trim() === 'wallet-funding-schema'
    && /^mb-wallet-funding-test-[a-f0-9-]{36}$/.test(container)) docker(['rm', '--force', container]);
}
