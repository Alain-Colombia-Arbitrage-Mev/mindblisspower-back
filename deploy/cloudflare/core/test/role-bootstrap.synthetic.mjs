// Run explicitly: node test/role-bootstrap.synthetic.mjs --synthetic-docker
// Auth-only schema rehearsal WITHOUT full migration70; no cloud DSN/env accepted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes,createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
assert.equal(process.argv.slice(2).join(' '),'--synthetic-docker');
const database='role_bootstrap_synthetic',name=`role-bootstrap-${randomBytes(6).toString('hex')}`;
const reader='mindbliss_member_reader_bootstrap_v1',writer='mindbliss_auth_core_v1';
const source=readFileSync(new URL('../role-bootstrap.example.sql',import.meta.url),'utf8');
const policy=source.replaceAll('REPLACE_WITH_CURATED_DATABASE',database);
const migrationSource=readFileSync(new URL('../../../../_meta/migration/71_better_auth_core_only.sql',import.meta.url),'utf8');
const migration71Sha256=createHash('sha256').update(migrationSource).digest('hex');
const authDDL=migrationSource.replaceAll('REPLACE_WITH_CURATED_DATABASE',database);
const app=fileURLToPath(new URL('../../../../app',import.meta.url));
assert.ok(authDDL.includes('CREATE TABLE auth.session') && !/ALTER\s+TABLE\s+mlm\.|UPDATE\s+mlm\.|CREATE\s+SCHEMA\s+(?:IF NOT EXISTS\s+)?identity/i.test(authDDL));
const cases=[];
let created=false;
const docker=(args,input)=>spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:4*1024*1024,timeout:60_000});
function must(args,input){const r=docker(args,input);assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
function sql(input,fail){const r=docker(['exec','-i',name,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],input);
  if(fail){assert.notEqual(r.status,0);assert.match(r.stderr,fail)}else assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
const as=(role,query,fail)=>sql(`BEGIN; SET LOCAL ROLE ${role}; ${query}; ROLLBACK;`,fail);
function guarded(setup,error,cleanup){
  sql(setup);sql(policy.replaceAll(reader,'synthetic_guard_reader').replaceAll(writer,'synthetic_guard_writer'),error);
  assert.equal(sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('synthetic_guard_reader','synthetic_guard_writer')"),'0');sql(cleanup)
}
function migrationGuarded(setup,error,cleanup){
  sql(setup);sql(authDDL,error);
  assert.equal(sql("SELECT count(*) FROM pg_attribute WHERE attrelid='auth.user'::regclass AND attname IN ('image','phone_number','phone_number_verified') AND NOT attisdropped"),'0');
  assert.equal(sql("SELECT to_regclass('auth.jwks') IS NULL"),'t');
  sql(cleanup)
}
try{
  must(['run','-d','--pull=never','--name',name,'--network','none','--tmpfs','/var/lib/postgresql','-e','POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',`POSTGRES_DB=${database}`,'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888']);created=true;
  let ready=false;for(let i=0;i<60;i++){if(docker(['exec',name,'pg_isready','-U','postgres']).status===0){ready=true;break}await new Promise(r=>setTimeout(r,500))}assert.ok(ready);
  assert.match(sql('SHOW server_version'),/^18\./);sql(source,/explicit_database_review_required/);sql(policy,/existing_reader_relation_missing/);
  sql(migrationSource,/auth_core_explicit_database_review_required/);sql(authDDL,/auth_core_existing_user_required/);
  sql(`CREATE SCHEMA mlm;CREATE SCHEMA auth;CREATE SCHEMA payments;CREATE SCHEMA extension_private;
    CREATE EXTENSION unaccent WITH SCHEMA extension_private;
    CREATE ROLE synthetic_shared_old NOLOGIN;GRANT pg_read_all_data,pg_write_all_data TO synthetic_shared_old;
    CREATE TABLE auth.user(id text PRIMARY KEY,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,name text,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE mlm.person(id bigint PRIMARY KEY,email text,status text,user_id text REFERENCES auth.user(id) ON DELETE RESTRICT ON UPDATE NO ACTION);
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,person_id bigint REFERENCES mlm.person(id));
    CREATE TABLE mlm.affiliate_package(id bigint);CREATE TABLE mlm.blacklist(id bigint);CREATE TABLE mlm.package(id bigint);CREATE TABLE mlm.rank(id bigint);
    CREATE VIEW mlm.v_rank_progress AS SELECT id FROM mlm.affiliate;
    CREATE TABLE mlm.wallet_movement(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,amount numeric);
    CREATE TABLE mlm.concept(id bigint);CREATE TABLE mlm.bonus_run(id bigint);CREATE TABLE mlm.alert_event(id bigint);CREATE TABLE mlm.plan_config(id bigint);
    CREATE TABLE payments.purchase_intent(id uuid);
    CREATE FUNCTION mlm.norm_email(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT lower(btrim($1))$$;
    CREATE FUNCTION mlm.norm_phone10(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT right($1,10)$$;
    CREATE FUNCTION mlm.norm_name(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT lower(extension_private.unaccent($1))$$;
    CREATE FUNCTION mlm.synthetic_mutation() RETURNS numeric LANGUAGE sql AS $$UPDATE mlm.wallet_movement SET amount=0 RETURNING amount$$;
    INSERT INTO auth.user VALUES('synthetic-subject','synthetic@example.test',true,'Synthetic Member',now(),now());
    INSERT INTO mlm.person VALUES(1,'synthetic@example.test','active','synthetic-subject');INSERT INTO mlm.affiliate VALUES(7,1);
    INSERT INTO mlm.wallet_movement(amount) VALUES(17);`);
  const fingerprint=sql("SELECT md5(string_agg(row_to_json(t)::text,'')) FROM mlm.person t");
  const treeFingerprint=sql("SELECT md5(string_agg(row_to_json(t)::text,'')) FROM mlm.affiliate t");
  sql(policy,/existing_reader_relation_missing/);
  migrationGuarded('ALTER TABLE auth.user ADD COLUMN unexpected_extra text',/auth_core_existing_user_shape_requires_review/,'ALTER TABLE auth.user DROP COLUMN unexpected_extra');
  migrationGuarded('ALTER TABLE auth.user ALTER COLUMN email_verified TYPE text USING email_verified::text',/auth_core_existing_user_shape_requires_review/,
    'ALTER TABLE auth.user ALTER COLUMN email_verified TYPE boolean USING email_verified::boolean');
  migrationGuarded('CREATE TABLE auth.session(id text)',/auth_core_existing_table_requires_review/,'DROP TABLE auth.session');
  migrationGuarded("CREATE TABLE mlm.synthetic_cascade(subject text REFERENCES auth.user(id) ON DELETE CASCADE)",/auth_core_business_cascade_requires_review/,'DROP TABLE mlm.synthetic_cascade');
  migrationGuarded("CREATE TABLE mlm.synthetic_setnull(subject text REFERENCES auth.user(id) ON UPDATE SET NULL)",/auth_core_business_cascade_requires_review/,'DROP TABLE mlm.synthetic_setnull');
  migrationGuarded('CREATE FUNCTION auth.synthetic_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; CREATE TRIGGER synthetic_user_trigger BEFORE UPDATE ON auth.user FOR EACH ROW EXECUTE FUNCTION auth.synthetic_trigger()',
    /auth_core_existing_user_trigger_requires_review/,'DROP TRIGGER synthetic_user_trigger ON auth.user;DROP FUNCTION auth.synthetic_trigger()');
  migrationGuarded('CREATE RULE synthetic_auth_delete_rule AS ON DELETE TO auth.user DO INSTEAD NOTHING',
    /auth_core_existing_user_rules_or_kind_require_review/,'DROP RULE synthetic_auth_delete_rule ON auth.user');
  cases.push('migration71_target_shape_existing_tables_indirect_writes_guards_rollback');
  sql(authDDL);sql(authDDL,/auth_core_existing_(?:user_shape|plugin_columns)_requires_review/);
  sql(policy);sql(policy,/new_names_required/);cases.push('explicit_target_auth_only_schema_and_fresh_groups');
  assert.equal(sql(`SELECT bool_and(NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    FROM pg_roles WHERE rolname IN ('${reader}','${writer}')`),'t');
  assert.equal(sql(`SELECT count(*) FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('${reader}','${writer}'))`),'0');
  assert.equal(sql("SELECT pg_has_role('synthetic_shared_old','pg_read_all_data','MEMBER') AND pg_has_role('synthetic_shared_old','pg_write_all_data','MEMBER')"),'t');
  as(reader,'SELECT id,email,email_verified,name FROM auth.user;SELECT * FROM mlm.person;SELECT * FROM mlm.v_rank_progress');
  assert.equal(as(reader,"SELECT mlm.norm_name('ÁRBOL')"),'arbol');
  as(reader,'SELECT * FROM auth.user',/permission denied/);as(reader,'SELECT created_at FROM auth.user',/permission denied/);
  for(const table of ['session','account','verification','jwks','rate_limit'])as(reader,`SELECT * FROM auth.${table}`,/permission denied/);
  for(const statement of ['UPDATE mlm.wallet_movement SET amount=0','DELETE FROM mlm.person','TRUNCATE mlm.affiliate',
    "INSERT INTO auth.user(id,email,email_verified) VALUES('denied','denied@example.test',true)",'SELECT mlm.synthetic_mutation()'])as(reader,statement,/permission denied/);
  cases.push('reader_explicit_business_and_auth_projection_without_write_or_auth_extras');
  for(const statement of ['SELECT * FROM mlm.person','SELECT * FROM payments.purchase_intent',
    'UPDATE mlm.wallet_movement SET amount=0','DELETE FROM mlm.person','CREATE TABLE public.denied(id integer)'])as(writer,statement,/permission denied/);
  assert.equal(sql(`SELECT has_database_privilege('${writer}',current_database(),'CONNECT') AND NOT has_schema_privilege('${writer}','mlm','USAGE')`),'t');
  as(writer,`INSERT INTO auth.user(id,email,email_verified,name) VALUES('auth-core-fixture','auth-core@example.test',false,'Synthetic Core');
    UPDATE auth.user SET name='Synthetic Updated' WHERE id='auth-core-fixture';
    INSERT INTO auth.session(id,user_id,expires_at,token) VALUES('session-fixture','auth-core-fixture',now()+interval '1 hour','opaque-session-fixture');
    UPDATE auth.session SET updated_at=now() WHERE id='session-fixture';
    INSERT INTO auth.account(id,user_id,account_id,provider_id) VALUES('account-fixture','auth-core-fixture','synthetic-account','credential');
    UPDATE auth.account SET updated_at=now() WHERE id='account-fixture';
    INSERT INTO auth.verification(id,identifier,value,expires_at) VALUES('verification-fixture','synthetic-identifier','opaque-hmac-fixture',now()+interval '5 minutes');
    UPDATE auth.verification SET updated_at=now() WHERE id='verification-fixture';
    INSERT INTO auth.jwks(id,public_key,private_key,created_at) VALUES('key-fixture','opaque-public-fixture','opaque-encrypted-fixture',now());
    UPDATE auth.jwks SET expires_at=now() WHERE id='key-fixture';
    INSERT INTO auth.rate_limit(id,key,count,last_request) VALUES('limit-fixture','opaque-budget-key',1,1);
    UPDATE auth.rate_limit SET count=2 WHERE id='limit-fixture';
    SELECT id FROM auth.user;SELECT id FROM auth.session;SELECT id FROM auth.account;SELECT id FROM auth.verification;SELECT id FROM auth.jwks;SELECT id FROM auth.rate_limit;
    DELETE FROM auth.rate_limit WHERE id='limit-fixture';DELETE FROM auth.jwks WHERE id='key-fixture';DELETE FROM auth.verification WHERE id='verification-fixture';
    DELETE FROM auth.account WHERE id='account-fixture';DELETE FROM auth.session WHERE id='session-fixture';DELETE FROM auth.user WHERE id='auth-core-fixture'`);
  cases.push('auth_core_crud_exactly_six_auth_tables_no_business_or_ddl');
  // Actual installed Better Auth/Drizzle handlers and restricted login. The
  // business identity policy below is EXPLICITLY STUBBED: this proves core auth
  // schema/permissions, NOT that real MLM provisioning is ready without 70.
  sql(`CREATE ROLE synthetic_core_login LOGIN INHERIT IN ROLE ${writer};CREATE ROLE synthetic_member_login LOGIN INHERIT IN ROLE ${reader}`);
  const integration=String.raw`
    import assert from 'node:assert/strict';
    import postgres from 'postgres';import {drizzle} from 'drizzle-orm/postgres-js';
    import {betterAuth} from 'better-auth';import {drizzleAdapter} from 'better-auth/adapters/drizzle';
    import {createLocalJWKSet,jwtVerify} from 'jose';
    import * as schema from './src/db/schema/auth.ts';
    import {createAuthOptions} from './src/auth/options.ts';
    import {createAuthDelivery} from './src/auth/delivery.ts';
    import {schema as installedJwtSchema} from './node_modules/better-auth/dist/plugins/jwt/schema.mjs';
    assert.equal((await Bun.file('./node_modules/better-auth/package.json').json()).version,'1.6.22');
    assert.deepEqual(Object.keys(installedJwtSchema.jwks.fields).sort(),['createdAt','expiresAt','privateKey','publicKey']);
    const connection=postgres('postgres://synthetic_core_login@127.0.0.1:5432/role_bootstrap_synthetic',{max:2,prepare:false});
    const read=postgres('postgres://synthetic_member_login@127.0.0.1:5432/role_bootstrap_synthetic',{max:1,prepare:false});
    const database=drizzle(connection),messages=[],provisioned=[],bindings=[];
    const env={BETTER_AUTH_SECRET:'synthetic-core-auth-secret-at-least-32-characters',BETTER_AUTH_URL:'https://auth.example.test',
      BETTER_AUTH_TRUSTED_ORIGINS:'https://portal.example.test',BETTER_AUTH_EMAIL_OTP_ENABLED:'true',BETTER_AUTH_PHONE_OTP_ENABLED:'false',
      BETTER_AUTH_JWT_ENABLED:'true',BETTER_AUTH_JWT_ISSUER:'https://auth.example.test',BETTER_AUTH_JWT_AUDIENCE:'synthetic-core-members',
      CLOUDFLARE_ACCOUNT_ID:'00000000000000000000000000000001',CLOUDFLARE_EMAIL_API_TOKEN:'synthetic-core-provider-token',AUTH_EMAIL_FROM:'codes@example.test'};
    const identityStub={provision:async id=>{provisioned.push(id);return{status:'existing'}},binding:async id=>{bindings.push(id);return{status:'existing',
      email:'synthetic@example.test',publicId:'00000000-0000-4000-8000-000000000071'}}};
    const delivery=createAuthDelivery(env,async(_url,request)=>{const body=JSON.parse(request.body);messages.push(body);
      return Response.json({success:true,errors:[],result:{delivered:[],queued:body.to,permanent_bounces:[]}})});
    const auth=betterAuth(createAuthOptions(env,drizzleAdapter(database,{provider:'pg',schema,usePlural:false}),identityStub,delivery));
    const request=(path,body,cookie)=>auth.handler(new Request(env.BETTER_AUTH_URL+'/api/auth'+path,{method:body===undefined?'GET':'POST',
      headers:{origin:'https://portal.example.test','content-type':'application/json','x-forwarded-for':'192.0.2.71',...(cookie?{cookie}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})}));
    try{
      assert.equal((await request('/email-otp/send-verification-otp',{email:'synthetic@example.test',type:'sign-in'})).status,200);
      assert.equal(messages.length,1);const otp=messages[0].text.match(/\b(\d{6})\b/)[1];
      const stored=(await connection.unsafe('SELECT value FROM auth.verification WHERE identifier LIKE '+"'sign-in-otp-%'"))[0].value;
      assert.match(stored,/^[a-f0-9]{64}:0$/);assert.ok(!stored.includes(otp));
      const verified=await request('/sign-in/email-otp',{email:'synthetic@example.test',otp});assert.equal(verified.status,200);
      assert.equal((await verified.clone().json()).user.id,'synthetic-subject');assert.equal(verified.headers.has('set-auth-jwt'),false);
      const cookie=verified.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
      assert.ok(verified.headers.getSetCookie().some(c=>c.includes('HttpOnly')&&c.includes('Secure')));
      assert.equal((await request('/sign-in/email-otp',{email:'synthetic@example.test',otp})).status,400);
      assert.equal((await(await request('/get-session',undefined,cookie)).json()).user.id,'synthetic-subject');
      const tokenResponse=await request('/token',undefined,cookie);assert.equal(tokenResponse.status,200);const{token}=await tokenResponse.json();
      const publicJwks=await(await request('/jwks')).json();assert.equal(publicJwks.keys.length,1);assert.ok(!JSON.stringify(publicJwks).includes('privateKey'));
      const result=await jwtVerify(token,createLocalJWKSet(publicJwks),{issuer:env.BETTER_AUTH_JWT_ISSUER,audience:env.BETTER_AUTH_JWT_AUDIENCE});
      assert.equal(result.protectedHeader.alg,'RS256');assert.equal(result.payload.sub,'synthetic-subject');
      assert.equal(result.payload.person_public_id,'00000000-0000-4000-8000-000000000071');assert.equal(result.payload.exp-result.payload.iat,300);
      const keys=await connection.unsafe('SELECT private_key FROM auth.jwks');assert.equal(keys.length,1);assert.ok(!keys[0].private_key.includes('"d":'));
      assert.deepEqual((await connection.unsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='auth' AND table_name='jwks' ORDER BY column_name")).map(r=>r.column_name),['created_at','expires_at','id','private_key','public_key']);
      assert.deepEqual(provisioned,['synthetic-subject']);assert.deepEqual(bindings,['synthetic-subject']);
      assert.equal((await request('/sign-out',{},cookie)).status,200);assert.equal(await(await request('/get-session',undefined,cookie)).json(),null);
      await assert.rejects(()=>read.unsafe('SELECT token FROM auth.session'));await assert.rejects(()=>connection.unsafe('SELECT * FROM mlm.person'));
      console.log(JSON.stringify({betterAuth:'1.6.22',realDrizzle:true,otpSessionJwtJwks:true,businessIdentityStub:true,realMessages:0}));
    }finally{await connection.end();await read.end()}
  `;
  const integrationOutput=must(['run','--rm','--pull=never','--network',`container:${name}`,'--read-only','--tmpfs','/tmp',
    '--mount',`type=bind,source=${app}/src,target=/app/src,readonly`,'--entrypoint','bun','mindbliss/api-test:auth-identity-20261025','--no-env-file','-e',integration]);
  assert.match(integrationOutput,/"otpSessionJwtJwks":true/);cases.push('real_better_auth_1622_drizzle_otp_session_jwt_jwks_identity_explicitly_stubbed');
  assert.equal(sql("SELECT to_regclass('auth.session') IS NOT NULL AND to_regnamespace('identity') IS NULL AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='mlm.person'::regclass AND attname='public_id' AND NOT attisdropped)"),'t');
  assert.equal(sql("SELECT md5(string_agg(row_to_json(t)::text,'')) FROM mlm.person t"),fingerprint);
  assert.equal(sql("SELECT md5(string_agg(row_to_json(t)::text,'')) FROM mlm.affiliate t"),treeFingerprint);
  sql('CREATE TABLE auth.future_secret(token text);ALTER TABLE auth.user ADD COLUMN future_secret text;CREATE TABLE mlm.future_business(id integer)');
  for(const role of [reader,writer]){as(role,'SELECT * FROM auth.future_secret',/permission denied/);as(role,'SELECT * FROM mlm.future_business',/permission denied/)}
  as(reader,'SELECT future_secret FROM auth.user',/permission denied/);
  cases.push('no_migration70_no_person_changes_and_no_future_default_access');
  guarded('GRANT CREATE ON SCHEMA public TO PUBLIC',/public_create_requires_separate_review/,'REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  guarded(`GRANT CREATE ON DATABASE ${database} TO PUBLIC`,/public_create_requires_separate_review/,`REVOKE CREATE ON DATABASE ${database} FROM PUBLIC`);
  guarded('GRANT UPDATE ON mlm.person TO PUBLIC',/effective_write_access/,'REVOKE UPDATE ON mlm.person FROM PUBLIC');
  guarded('GRANT SELECT ON auth.future_secret TO PUBLIC',/reader_auth_secrets_access/,'REVOKE SELECT ON auth.future_secret FROM PUBLIC');
  guarded('GRANT SELECT(created_at) ON auth.user TO PUBLIC',/reader_extra_auth_user_columns/,'REVOKE SELECT(created_at) ON auth.user FROM PUBLIC');
  guarded('GRANT SELECT ON mlm.person TO PUBLIC',/auth_core_business_read_access/,'REVOKE SELECT ON mlm.person FROM PUBLIC');
  guarded('GRANT USAGE ON SEQUENCE mlm.wallet_movement_id_seq TO PUBLIC',/public_sequence_access/,'REVOKE USAGE ON SEQUENCE mlm.wallet_movement_id_seq FROM PUBLIC');
  guarded('CREATE FUNCTION mlm.synthetic_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$SELECT 1$$',/accessible_security_definer_requires_separate_review/,'DROP FUNCTION mlm.synthetic_definer()');
  guarded('ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON TABLES TO PUBLIC',/public_future_data_defaults_require_separate_review/,'ALTER DEFAULT PRIVILEGES IN SCHEMA auth REVOKE SELECT ON TABLES FROM PUBLIC');
  cases.push('all_public_create_write_read_sequence_definer_and_default_guards_atomic');
  console.log(JSON.stringify({postgres:'18.6',migration71Sha256,cases,remoteDatabaseCalls:0,existingRolesChanged:0,personRowsChanged:0,migration70Applied:false,realMessages:0}));
}finally{if(created)must(['rm','-f',name])}
