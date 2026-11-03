// Isolated privileges rehearsal. Accepts no DSN/env or production credentials.
// node deploy/cloudflare/core/test/go-reader-policy.synthetic.mjs --synthetic-docker
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
assert.equal(process.argv.slice(2).join(' '),'--synthetic-docker');
const source=readFileSync(new URL('../go-reader-policy.example.sql',import.meta.url),'utf8');
const database='go_reader_policy_synthetic',name=`go-reader-policy-${randomBytes(6).toString('hex')}`;
const policy=source.replaceAll('REPLACE_WITH_CURATED_DATABASE',database);
const readModelsSource=readFileSync(new URL('../../../../_meta/migration/73_cloudflare_read_models.sql',import.meta.url),'utf8');
const readModels=readModelsSource.replaceAll('REPLACE_WITH_CURATED_DATABASE',database);
const roles=['engine','payments','withdrawals'].map(service=>`mindbliss_go_${service}_reader_v1`);
const manifest=[...source.matchAll(/\('(engine|payments|withdrawals)','([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)','([rv])',(true|false)\)/g)]
  .map(([,service,relation,kind,required])=>({service,relation,kind,required:required==='true'}));
assert.equal(manifest.filter(x=>x.service==='engine').length,3);
assert.equal(manifest.filter(x=>!x.required).length,2);
assert.doesNotMatch(source,/GRANT\s+(ALL|[^;]*ALL TABLES)|pg_read_all_data|pg_write_all_data|CREATE\s+ROLE[^;]+\sLOGIN\s/);
const docker=(args,input)=>spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:6*1024*1024,timeout:90_000});
function must(args,input){const r=docker(args,input);assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
function sql(input,error){const r=docker(['exec','-i',name,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],input);
  if(error){assert.notEqual(r.status,0);assert.match(r.stderr,error)}else assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
const as=(service,statement,error)=>sql(`BEGIN;SET LOCAL ROLE mindbliss_go_${service}_reader_v1;${statement};ROLLBACK;`,error);
const roleCount=()=>sql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'mindbliss_go_%_reader_v1'");
let created=false;const cases=[];
try{
  must(['run','-d','--pull=never','--name',name,'--network','none','--tmpfs','/var/lib/postgresql','-e','POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',`POSTGRES_DB=${database}`,'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888']);created=true;
  let ready=false;for(let i=0;i<60;i++){if(docker(['exec',name,'pg_isready','-U','postgres']).status===0){ready=true;break}await new Promise(r=>setTimeout(r,500))}assert.ok(ready);
  sql(`CREATE EXTENSION ltree;CREATE EXTENSION citext;CREATE EXTENSION unaccent;
    CREATE SCHEMA mlm;CREATE SCHEMA payments;CREATE SCHEMA recovery;CREATE SCHEMA audit;CREATE SCHEMA auth;CREATE SCHEMA identity;
    CREATE SCHEMA support;CREATE TABLE support.ticket(id bigint,payload text);
    CREATE ROLE synthetic_shared_old NOLOGIN;GRANT pg_read_all_data,pg_write_all_data TO synthetic_shared_old;
    CREATE ROLE synthetic_bun_reader NOLOGIN;CREATE ROLE synthetic_auth_writer NOLOGIN;
    CREATE TABLE auth.user(id text PRIMARY KEY,email text,email_verified boolean,name text,image text);
    CREATE TABLE auth.session(id text,token text);CREATE TABLE auth.account(id text,password text);
    CREATE TABLE auth.verification(id text,value text);CREATE TABLE auth.jwks(id text,private_key text);CREATE TABLE auth.rate_limit(id text,key text);
    CREATE TABLE identity.auth_binding(subject text,person_id bigint,provider text,link_method text,created_at timestamptz);
    CREATE TABLE identity.legacy_claim_grant(id text,token_hash text);
    CREATE TABLE identity.link_conflict(id bigint,reason text);
    CREATE TABLE identity.stripe_customer(id text,customer_id text);
    CREATE TABLE audit.activity_log(id bigint,after_data jsonb,before_data jsonb,entity_type text,action text,occurred_at timestamptz,actor_user_id text);
    CREATE TABLE mlm.person(id bigint PRIMARY KEY,public_id uuid NOT NULL DEFAULT gen_random_uuid(),user_id text,email citext,
      first_name text,last_name text,status text,blacklisted boolean,is_admin boolean,profile text,phone_number text);
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,person_id bigint,parent_id bigint,sponsor_id bigint,position text,path ltree,current_rank_id smallint);
    CREATE TABLE mlm.wallet(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,affiliate_id bigint,asset_id integer,balance numeric);
    CREATE TABLE mlm.wallet_movement(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,wallet_id bigint,affiliate_id bigint,concept_id bigint,amount numeric,posted_at timestamptz);
    CREATE TABLE mlm.concept(id bigint,kind text);
    CREATE TABLE mlm.asset(id integer,symbol text);
    CREATE TABLE mlm.rank(id smallint,name_es text,code text);
    CREATE TABLE payments.stripe_sale(id bigint,payment_intent_id text,livemode boolean,payment_status text,currency text,metadata jsonb,product_evidence jsonb,captured_minor bigint);
    CREATE TABLE recovery.stripe_sale_identity(id bigint,payment_intent_id text,person_id bigint,affiliate_id bigint,identity_verified boolean,catalog_verified boolean);
    CREATE TABLE recovery.package_catalog_snapshot(id bigint,source_package_id bigint,base_minor bigint,fee_minor bigint,currency text);
    CREATE TABLE recovery.operator_private(id bigint,payload text);
    CREATE FUNCTION mlm.norm_email(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT lower(btrim($1))$$;
    CREATE FUNCTION mlm.norm_phone10(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT right($1,10)$$;
    CREATE FUNCTION mlm.norm_name(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT lower(public.unaccent($1))$$;`);
  const existing=new Set(sql("SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('mlm','payments','recovery')").split('\n'));
  for(const item of manifest.filter(x=>x.required&&!['mlm.member_onboarding','mlm.bmp_account_link'].includes(x.relation)))if(!existing.has(item.relation)){
    sql(item.kind==='v'?`CREATE VIEW ${item.relation} AS SELECT id FROM mlm.affiliate`:`CREATE TABLE ${item.relation}(id bigint)`);existing.add(item.relation);
  }
  sql(`INSERT INTO auth.user VALUES('fixture-subject','fixture@example.test',true,'Fixture','not-needed');
    INSERT INTO auth.session VALUES('session-fixture','synthetic-private-token');INSERT INTO auth.jwks VALUES('jwks-fixture','synthetic-private-key');
    INSERT INTO identity.legacy_claim_grant VALUES('claim-fixture','synthetic-private-hash');
    INSERT INTO mlm.person(id,user_id,email,first_name,last_name,status,blacklisted,is_admin,profile) VALUES(1,'fixture-subject','fixture@example.test','Fixture','Member','active',false,false,'legacy');
    INSERT INTO identity.auth_binding VALUES('fixture-subject',1,'better_auth','approved_claim',now());
    INSERT INTO mlm.affiliate VALUES(1,1,NULL,NULL,NULL,'n1',3);INSERT INTO mlm.rank VALUES(3,'Synthetic','SYNTHETIC');
    INSERT INTO mlm.wallet(affiliate_id,asset_id,balance) VALUES(1,1,17);
    INSERT INTO mlm.wallet_movement(wallet_id,affiliate_id,concept_id,amount,posted_at) VALUES(1,1,1,17,now());
    INSERT INTO mlm.concept VALUES(1,'synthetic');INSERT INTO mlm.asset VALUES(1,'USD');
    INSERT INTO payments.stripe_sale VALUES(1,'pi_synthetic',true,'succeeded','usd','{"packmindbliss":"true"}','[{}]',1700);
    INSERT INTO recovery.stripe_sale_identity VALUES(1,'pi_synthetic',1,1,true,true);
    INSERT INTO audit.activity_log VALUES(1,'{"quantity":1}','{"private":true}','payments.operational_charge_adjustment','created',now(),'private-actor');`);
  const beforeReadModels=sql("SELECT md5((SELECT string_agg(to_jsonb(p)::text,'' ORDER BY id) FROM mlm.person p)||(SELECT string_agg(to_jsonb(a)::text,'' ORDER BY id) FROM mlm.affiliate a))");
  function noReadModels(){assert.equal(sql("SELECT to_regclass('mlm.member_onboarding') IS NULL AND to_regclass('mlm.bmp_account_link') IS NULL"),'t')}
  sql(readModelsSource,/explicit_database_review_required/);noReadModels();
  sql('ALTER TABLE identity.link_conflict RENAME TO synthetic_missing_identity');sql(readModels,/identity72_required/);noReadModels();sql('ALTER TABLE identity.synthetic_missing_identity RENAME TO link_conflict');
  sql('CREATE TABLE mlm.member_onboarding(person_id bigint)');sql(readModels,/existing_tables_require_review/);sql('DROP TABLE mlm.member_onboarding');noReadModels();
  sql("CREATE TYPE mlm.bmp_link_status AS ENUM('pending','approved','rejected')");sql(readModels,/bmp_enum_labels_require_review/);noReadModels();sql('DROP TYPE mlm.bmp_link_status');
  sql('ALTER DEFAULT PRIVILEGES IN SCHEMA mlm GRANT SELECT ON TABLES TO synthetic_shared_old');
  sql(readModels,/owner_default_data_grants_require_review/);noReadModels();sql('ALTER DEFAULT PRIVILEGES IN SCHEMA mlm REVOKE SELECT ON TABLES FROM synthetic_shared_old');
  sql("CREATE TYPE mlm.bmp_link_status AS ENUM('pending_admin','approved','rejected')");
  sql(readModels.replace(/COMMIT;\s*$/,'ROLLBACK;'));noReadModels();sql('DROP TYPE mlm.bmp_link_status');
  sql(readModels);sql(readModels,/existing_tables_require_review/);
  assert.equal(sql('SELECT (SELECT count(*) FROM mlm.member_onboarding)+(SELECT count(*) FROM mlm.bmp_account_link)'),'0');
  assert.equal(sql("SELECT md5((SELECT string_agg(to_jsonb(p)::text,'' ORDER BY id) FROM mlm.person p)||(SELECT string_agg(to_jsonb(a)::text,'' ORDER BY id) FROM mlm.affiliate a))"),beforeReadModels);
  assert.equal(sql("SELECT count(*) FROM pg_index WHERE indrelid='mlm.bmp_account_link'::regclass"),'6');
  cases.push('exact_migration73_two_empty_tables_target_identity_enum_defaults_replay_guards_existing_people_tree_unchanged');
  const oldRolesHash=sql("SELECT md5(string_agg(to_jsonb(r)::text,'' ORDER BY rolname)) FROM pg_roles r");
  const oldMembersHash=sql("SELECT md5(string_agg(to_jsonb(m)::text,'' ORDER BY roleid,member,grantor)) FROM pg_auth_members m");
  const treeHash=sql("SELECT md5(string_agg(to_jsonb(a)::text,'' ORDER BY id)) FROM mlm.affiliate a");
  function guarded(setup,error,cleanup){if(setup)sql(setup);sql(policy,error);if(cleanup)sql(cleanup);assert.equal(roleCount(),'0')}
  sql(source,/explicit_database_review_required/);
  guarded('CREATE ROLE mindbliss_go_engine_reader_v1 NOLOGIN',/fresh_role_names_required/,'DROP ROLE mindbliss_go_engine_reader_v1');
  guarded('ALTER TABLE mlm.bmp_account_link RENAME TO synthetic_missing_bmp',/required_relation_missing: mlm.bmp_account_link/,'ALTER TABLE mlm.synthetic_missing_bmp RENAME TO bmp_account_link');
  guarded('ALTER TABLE mlm.member_onboarding RENAME TO synthetic_missing_onboarding',/required_relation_missing: mlm.member_onboarding/,'ALTER TABLE mlm.synthetic_missing_onboarding RENAME TO member_onboarding');
  guarded('ALTER TABLE mlm.wallet RENAME TO synthetic_wallet;CREATE VIEW mlm.wallet AS SELECT * FROM mlm.synthetic_wallet',/relation_kind_requires_review/,
    'DROP VIEW mlm.wallet;ALTER TABLE mlm.synthetic_wallet RENAME TO wallet');
  guarded('ALTER FUNCTION mlm.norm_name(text) SECURITY DEFINER',/normalizer_invoker_immutable_sql_required/,'ALTER FUNCTION mlm.norm_name(text) SECURITY INVOKER');
  guarded('GRANT UPDATE(balance) ON mlm.wallet TO PUBLIC',/effective_data_write_access/,'REVOKE UPDATE(balance) ON mlm.wallet FROM PUBLIC');
  guarded('GRANT SELECT ON auth.session TO PUBLIC',/unreviewed_relation_read_access/,'REVOKE SELECT ON auth.session FROM PUBLIC');
  guarded('GRANT USAGE ON SEQUENCE mlm.wallet_id_seq TO PUBLIC',/effective_sequence_access/,'REVOKE USAGE ON SEQUENCE mlm.wallet_id_seq FROM PUBLIC');
  guarded('GRANT CREATE ON SCHEMA mlm TO PUBLIC',/public_create_requires_review/,'REVOKE CREATE ON SCHEMA mlm FROM PUBLIC');
  guarded(`GRANT CREATE ON DATABASE ${database} TO PUBLIC`,/public_create_requires_review/,`REVOKE CREATE ON DATABASE ${database} FROM PUBLIC`);
  guarded('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC',/public_future_data_defaults_require_review/,'ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC');
  guarded('CREATE FUNCTION public.synthetic_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$SELECT 1$$',/accessible_security_definer_requires_review/,'DROP FUNCTION public.synthetic_definer()');
  guarded('CREATE OR REPLACE VIEW recovery.v_stripe_funds_review AS SELECT length(token)::bigint AS id FROM auth.session',/report_view_private_identity_dependency/,
    'CREATE OR REPLACE VIEW recovery.v_stripe_funds_review AS SELECT id FROM mlm.affiliate');
  cases.push('explicit_target_fresh_groups_missing_core_relkind_normalizer_public_create_read_write_sequence_defaults_secdef_view_guards_atomic');
  // Optional charge/referral paths absent: review succeeds without creating any.
  sql(policy.replace(/COMMIT;\s*$/,'ROLLBACK;'));assert.equal(roleCount(),'0');
  assert.equal(sql("SELECT to_regclass('payments.operational_charge_adjustment') IS NULL AND to_regclass('payments.registration_referral') IS NULL"),'t');
  for(const item of manifest.filter(x=>!x.required))sql(`CREATE TABLE ${item.relation}(id bigint)`);
  sql(policy);sql(policy,/fresh_role_names_required/);assert.equal(roleCount(),'3');
  assert.equal(sql("SELECT md5(string_agg(to_jsonb(r)::text,'' ORDER BY rolname)) FROM pg_roles r WHERE rolname NOT LIKE 'mindbliss_go_%_reader_v1'"),oldRolesHash);
  assert.equal(sql("SELECT md5(string_agg(to_jsonb(m)::text,'' ORDER BY roleid,member,grantor)) FROM pg_auth_members m"),oldMembersHash);
  for(const item of manifest)as(item.service,`SELECT * FROM ${item.relation} LIMIT 0`);
  // Execute the actual Go SQL strings, not simplified permission-only queries.
  const ledgerSource=readFileSync(new URL('../../../../vp-engine/internal/ledger/service.go',import.meta.url),'utf8');
  const walletQuery=ledgerSource.slice(ledgerSource.indexOf('func (s *Service) GetWalletBalance')).match(/s\.db\.QueryRow\(ctx, `([\s\S]*?)`/)[1].replaceAll('$1','1');
  assert.match(as('engine',walletQuery),/1\|1\|1\|17/);
  const identitySource=readFileSync(new URL('../../../../vp-engine/internal/payments/identity_better_auth.go',import.meta.url),'utf8');
  const bindingQuery=identitySource.match(/v\.db\.QueryRow\(ctx, `([\s\S]*?)`/)[1].replaceAll('$1',"'fixture-subject'");
  for(const service of ['payments','withdrawals'])assert.match(as(service,bindingQuery),/^fixture@example\.test\|[0-9a-f-]{36}$/);
  const onboardingSource=readFileSync(new URL('../../../../vp-engine/internal/payments/onboarding.go',import.meta.url),'utf8');
  const onboardingQuery=onboardingSource.match(/s\.reader\(\)\.QueryRow\(ctx, `([\s\S]*?)`/)[1].replaceAll('$1',"'fixture@example.test'");
  assert.equal(as('payments',onboardingQuery),'');
  const bmpSource=readFileSync(new URL('../../../../vp-engine/internal/withdrawals/link.go',import.meta.url),'utf8');
  const bmpQuery=bmpSource.slice(bmpSource.indexOf('func (s *Store) ListPendingBMPLinks')).match(/s\.db\.Query\(ctx, `([\s\S]*?)`/)[1]
    .replaceAll('$1','25').replaceAll('$2','0');
  assert.equal(as('withdrawals',bmpQuery),'');
  assert.equal(as('payments',"SELECT sum(s.captured_minor) FROM payments.stripe_sale s JOIN recovery.stripe_sale_identity i USING(payment_intent_id) WHERE i.person_id=1 AND i.identity_verified AND s.livemode AND s.metadata->>'packmindbliss'='true'"),'1700');
  as('payments','SELECT after_data,entity_type,action,occurred_at FROM audit.activity_log');
  as('payments','SELECT before_data FROM audit.activity_log',/permission denied/);
  as('payments','SELECT name FROM auth.user',/permission denied/);as('payments','SELECT link_method FROM identity.auth_binding',/permission denied/);
  as('engine','SELECT email FROM mlm.person',/permission denied/);as('engine','SELECT id FROM auth.user',/permission denied/);
  as('withdrawals','SELECT * FROM payments.stripe_sale',/permission denied/);as('payments','SELECT * FROM recovery.operator_private',/permission denied/);
  for(const service of ['engine','payments','withdrawals']){
    for(const statement of ['UPDATE mlm.wallet SET balance=0','UPDATE mlm.person SET is_admin=true',
      'INSERT INTO mlm.withdrawal_request DEFAULT VALUES','INSERT INTO payments.purchase_intent DEFAULT VALUES',
      "UPDATE auth.user SET email_verified=true","INSERT INTO identity.legacy_claim_grant DEFAULT VALUES",
      "INSERT INTO identity.auth_binding DEFAULT VALUES","SELECT nextval('mlm.wallet_id_seq')",
      'SELECT token FROM auth.session','SELECT private_key FROM auth.jwks','SELECT token_hash FROM identity.legacy_claim_grant',
      'SELECT * FROM support.ticket'])as(service,statement,/permission denied/);
  }
  sql('CREATE TABLE mlm.synthetic_future_private(id bigint)');for(const service of ['engine','payments','withdrawals'])as(service,'SELECT * FROM mlm.synthetic_future_private',/permission denied/);
  assert.equal(sql("SELECT md5(string_agg(to_jsonb(a)::text,'' ORDER BY id)) FROM mlm.affiliate a"),treeHash);
  assert.equal(sql('SELECT balance FROM mlm.wallet WHERE id=1'),'17');
  cases.push('actual_go_wallet_and_verified_identity_queries_and_stripe_evidence_reads');
  cases.push('three_service_compartments_no_dml_no_auth_secrets_no_claims_no_sequences_no_future_defaults_old_roles_untouched');
  console.log(JSON.stringify({postgres:'18.6',migration73Sha256:createHash('sha256').update(readModelsSource).digest('hex'),policySha256:createHash('sha256').update(source).digest('hex'),
    services:roles,manifestRelations:manifest.length,cases,realCredentials:0,remoteDatabaseCalls:0,realMessages:0,financialWrites:0}));
}finally{if(created)must(['rm','-f',name])}
