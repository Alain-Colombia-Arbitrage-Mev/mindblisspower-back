// Explicit disposable PostgreSQL 18 rehearsal; excluded from default unit glob.
// Run: node test/role-policy.synthetic.mjs --synthetic-docker
// Never accepts a host/cloud DSN.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

assert.equal(process.argv.slice(2).join(' '), '--synthetic-docker', 'Requires --synthetic-docker');
const database = 'role_policy_synthetic';
const name = `role-policy-${randomBytes(6).toString('hex')}`;
const reader = 'mindbliss_member_reader_v1';
const writer = 'mindbliss_auth_writer_v1';
const source = readFileSync(new URL('../role-policy.example.sql', import.meta.url), 'utf8');
const policy = source.replaceAll('REPLACE_WITH_CURATED_DATABASE', database);
const migration = readFileSync(new URL('../../../../_meta/migration/70_stable_identity_bindings.sql', import.meta.url), 'utf8');
const app = fileURLToPath(new URL('../../../../app', import.meta.url));
const events = [];
let created = false;
function docker(args, input) {
  return spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 90_000 });
}
function must(args, input) {
  const result = docker(args, input);
  assert.equal(result.status, 0, result.stderr || 'Disposable Docker command failed');
  return result.stdout.trim();
}
function sql(statement, fail) {
  const result = docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], statement);
  if (fail) { assert.notEqual(result.status, 0); assert.match(result.stderr, fail); }
  else assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const asRole = (role, statement, fail) => sql(`BEGIN; SET LOCAL ROLE ${role}; ${statement}; ROLLBACK;`, fail);
function guardedPolicy(setup, expected, cleanup) {
  const guarded = policy.replaceAll(reader, 'synthetic_guard_reader').replaceAll(writer, 'synthetic_guard_writer');
  sql(setup);
  sql(guarded, expected);
  assert.equal(sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('synthetic_guard_reader','synthetic_guard_writer')"), '0');
  sql(cleanup);
}
try {
  // No port, no network, no persistent volume, no passwords/production env.
  must(['run', '-d', '--pull=never', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', `POSTGRES_DB=${database}`,
    'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (docker(['exec', name, 'pg_isready', '-U', 'postgres']).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready);
  assert.match(sql('SHOW server_version'), /^18\./);
  sql(source, /explicit_database_review_required/);
  sql(policy, /required_schema_or_migration_70_missing/);
  events.push('explicit_target_and_migration_guards');
  sql(`CREATE EXTENSION citext; CREATE SCHEMA auth; CREATE SCHEMA mlm; CREATE SCHEMA payments;
    CREATE SCHEMA extension_private; CREATE EXTENSION unaccent WITH SCHEMA extension_private;
    CREATE ROLE synthetic_shared_legacy NOLOGIN; GRANT pg_read_all_data,pg_write_all_data TO synthetic_shared_legacy;
    CREATE TABLE auth.user(id text PRIMARY KEY,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,name text,
      contact_phone_e164 text,contact_whatsapp_e164 text,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TYPE mlm.person_status AS ENUM('pending','active','suspended','banned','deleted');
    CREATE TYPE mlm.kyc_status AS ENUM('not_started','in_review','approved','rejected','expired');
    CREATE TABLE mlm.person(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id text UNIQUE REFERENCES auth.user(id),
      first_name text NOT NULL,last_name text NOT NULL,email citext NOT NULL UNIQUE,phone_number text NOT NULL,
      status mlm.person_status NOT NULL DEFAULT 'pending',kyc_status mlm.kyc_status NOT NULL DEFAULT 'not_started',
      is_admin boolean NOT NULL DEFAULT false,blacklisted boolean NOT NULL DEFAULT false);
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,person_id bigint REFERENCES mlm.person(id));
    CREATE TABLE mlm.affiliate_package(id bigint PRIMARY KEY);
    CREATE TABLE mlm.blacklist(id bigint PRIMARY KEY);
    CREATE TABLE mlm.package(id bigint PRIMARY KEY);
    CREATE TABLE mlm.rank(id bigint PRIMARY KEY);
    CREATE VIEW mlm.v_rank_progress AS SELECT id FROM mlm.affiliate;
    CREATE TABLE mlm.wallet_movement(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,amount numeric NOT NULL);
    CREATE TABLE mlm.concept(id bigint PRIMARY KEY);
    CREATE TABLE mlm.bonus_run(id bigint PRIMARY KEY);
    CREATE TABLE mlm.alert_event(id bigint PRIMARY KEY);
    CREATE TABLE mlm.plan_config(id bigint PRIMARY KEY);
    CREATE TABLE payments.purchase_intent(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE FUNCTION mlm.norm_email(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT lower(btrim($1))$$;
    CREATE FUNCTION mlm.norm_phone10(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT right($1,10)$$;
    CREATE FUNCTION mlm.norm_name(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT lower(extension_private.unaccent($1))$$;
    CREATE FUNCTION mlm.synthetic_mutation() RETURNS bigint LANGUAGE sql AS $$UPDATE mlm.wallet_movement SET amount=0 RETURNING id$$;
    INSERT INTO auth.user(id,email,email_verified,name) VALUES('bound-subject','bound@example.test',true,'Synthetic Bound'),
      ('legacy-subject','legacy@example.test',true,'Synthetic Legacy');
    INSERT INTO mlm.person(user_id,first_name,last_name,email,phone_number,status)
      VALUES('bound-subject','Synthetic','Bound','bound@example.test','','active'),(NULL,'Synthetic','Legacy','legacy@example.test','','active');
    INSERT INTO mlm.affiliate VALUES(7,1); INSERT INTO mlm.wallet_movement(amount) VALUES(17);`);
  sql(migration);
  sql(policy);
  sql(policy, /new_names_required/);
  assert.equal(sql(`SELECT pg_has_role('synthetic_shared_legacy','pg_read_all_data','MEMBER') AND pg_has_role('synthetic_shared_legacy','pg_write_all_data','MEMBER')`), 't');
  assert.equal(sql(`SELECT count(*) FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('${reader}','${writer}'))`), '0');
  assert.equal(sql(`SELECT bool_and(NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) FROM pg_roles WHERE rolname IN ('${reader}','${writer}')`), 't');
  events.push('fresh_no_login_groups_shared_role_untouched');
  assert.equal(asRole(reader, "SELECT u.id FROM auth.user u JOIN identity.auth_binding b ON b.subject=u.id JOIN mlm.person p ON p.id=b.person_id WHERE u.email_verified AND u.name='Synthetic Bound'"), 'bound-subject');
  assert.equal(asRole(reader, "SELECT mlm.norm_name('ÁRBOL')"), 'arbol');
  asRole(reader, 'SELECT subject,provider,person_id FROM identity.auth_binding; SELECT subject,resolved_at,reason FROM identity.link_conflict');
  for (const table of ['session','account','verification','jwks','rate_limit']) asRole(reader, `SELECT * FROM auth.${table}`, /permission denied/);
  asRole(reader, 'SELECT * FROM auth.user', /permission denied/);
  asRole(reader, 'SELECT contact_phone_e164,contact_whatsapp_e164 FROM auth.user', /permission denied/);
  for (const statement of ["UPDATE mlm.wallet_movement SET amount=0", 'DELETE FROM mlm.affiliate', 'TRUNCATE mlm.person',
    "INSERT INTO auth.user(id,email) VALUES('denied','denied@example.test')", 'SELECT mlm.synthetic_mutation()']) asRole(reader, statement, /permission denied/);
  events.push('reader_real_projection_normalization_and_secret_write_denials');
  for (const statement of ['UPDATE mlm.wallet_movement SET amount=0', 'DELETE FROM mlm.person',
    'INSERT INTO payments.purchase_intent DEFAULT VALUES', 'INSERT INTO mlm.affiliate(id) VALUES(9)',
    'UPDATE mlm.person SET is_admin=true', 'UPDATE mlm.person SET public_id=gen_random_uuid()',
    "INSERT INTO mlm.person(first_name,last_name,email,phone_number,is_admin) VALUES('A','B','denied@example.test','',true)",
    'INSERT INTO identity.legacy_claim_grant DEFAULT VALUES', 'DELETE FROM identity.legacy_claim_grant',
    "UPDATE identity.legacy_claim_grant SET approved_by_subject='bound-subject'", 'INSERT INTO identity.stripe_customer DEFAULT VALUES']) asRole(writer, statement, /permission denied/);
  asRole(writer, "INSERT INTO auth.jwks(id,public_key,private_key,created_at) VALUES('synthetic-jwk','synthetic-public','synthetic-encrypted',now()); UPDATE auth.jwks SET expires_at=now() WHERE id='synthetic-jwk'; DELETE FROM auth.jwks WHERE id='synthetic-jwk'");
  events.push('auth_writer_cannot_write_tree_finance_admin_or_approve_claims');
  sql(`CREATE ROLE synthetic_member_login LOGIN INHERIT IN ROLE ${reader}; CREATE ROLE synthetic_auth_login LOGIN INHERIT IN ROLE ${writer};`);
  // Real Better Auth + Drizzle + least-privilege login, not just privilege flags.
  const integration = String.raw`
    import assert from 'node:assert/strict';
    import postgres from 'postgres'; import { drizzle } from 'drizzle-orm/postgres-js';
    import { betterAuth } from 'better-auth'; import { drizzleAdapter } from 'better-auth/adapters/drizzle';
    import * as schema from './src/db/schema/auth.ts';
    import { createAuthOptions } from './src/auth/options.ts';
    import { provisionAuthPerson,getAuthPersonBinding } from './src/modules/identity/index.ts';
    const write=postgres('postgres://synthetic_auth_login@127.0.0.1:5432/role_policy_synthetic',{max:2,prepare:false});
    const read=postgres('postgres://synthetic_member_login@127.0.0.1:5432/role_policy_synthetic',{max:1,prepare:false});
    const w=drizzle(write),r=drizzle(read); const messages=[];
    const env={ BETTER_AUTH_SECRET:'synthetic-role-policy-secret-at-least-32-characters',BETTER_AUTH_URL:'https://auth.example.test',
      BETTER_AUTH_TRUSTED_ORIGINS:'https://portal.example.test',BETTER_AUTH_EMAIL_OTP_ENABLED:'true',
      CLOUDFLARE_ACCOUNT_ID:'00000000000000000000000000000001',CLOUDFLARE_EMAIL_API_TOKEN:'synthetic-role-policy-token',AUTH_EMAIL_FROM:'codes@example.test'};
    const auth=betterAuth(createAuthOptions(env,drizzleAdapter(w,{provider:'pg',schema,usePlural:false}),
      {provision:userId=>provisionAuthPerson(w,{userId}),binding:userId=>getAuthPersonBinding(w,{userId})},
      {email:async message=>{messages.push(message)},phone:async()=>{throw new Error('No phone delivery')}}));
    const request=(path,body)=>auth.handler(new Request(env.BETTER_AUTH_URL+'/api/auth'+path,{method:'POST',
      headers:{origin:'https://portal.example.test','content-type':'application/json','x-forwarded-for':'192.0.2.31'},body:JSON.stringify(body)}));
    try{
      const sent=await request('/email-otp/send-verification-otp',{email:'bound@example.test',type:'sign-in'});assert.equal(sent.status,200);
      assert.equal(messages.length,1);const otp=messages[0].text.match(/\b(\d{6})\b/)[1];
      const verified=await request('/sign-in/email-otp',{email:'bound@example.test',otp});assert.equal(verified.status,200);
      const body=await verified.json();assert.equal(body.user.id,'bound-subject');
      assert.equal((await request('/sign-in/email-otp',{email:'bound@example.test',otp})).status,400);
      assert.equal((await getAuthPersonBinding(r,{userId:'bound-subject'})).status,'existing');
      assert.equal((await provisionAuthPerson(w,{userId:'legacy-subject'})).status,'claim_required');
      assert.equal((await getAuthPersonBinding(r,{userId:'legacy-subject'})).status,'claim_required');
      await write.unsafe("INSERT INTO auth.user(id,email,email_verified,name) VALUES('new-subject','new@example.test',true,'Synthetic New')");
      assert.equal((await provisionAuthPerson(w,{userId:'new-subject'})).status,'created');
      assert.equal((await getAuthPersonBinding(r,{userId:'new-subject'})).status,'existing');
      assert.equal((await write.unsafe("SELECT count(*)::int AS n FROM auth.session WHERE user_id='bound-subject'"))[0].n,1);
      await assert.rejects(()=>read.unsafe('SELECT token FROM auth.session'));
      console.log(JSON.stringify({realBetterAuth:true,realDrizzle:true,leastPrivilegeLogins:true,realMessages:0}));
    }finally{await write.end();await read.end()}
  `;
  const output = must(['run', '--rm', '--pull=never', '--network', `container:${name}`, '--read-only', '--tmpfs', '/tmp',
    '--mount', `type=bind,source=${app}/src,target=/app/src,readonly`,
    '--mount', `type=bind,source=${app}/node_modules/libphonenumber-js,target=/app/node_modules/libphonenumber-js,readonly`, '--entrypoint', 'bun',
    'mindbliss/api-test:auth-identity-20261025', '--no-env-file', '-e', integration]);
  assert.match(output, /"leastPrivilegeLogins":true/);
  events.push('real_email_otp_session_and_identity_on_restricted_logins');
  sql('ALTER TABLE auth.user ADD COLUMN future_secret text; CREATE TABLE auth.future_secret(value text); CREATE TABLE mlm.future_business(value text)');
  asRole(reader, 'SELECT id,email,email_verified,name FROM auth.user');
  asRole(reader, 'SELECT future_secret FROM auth.user', /permission denied/);
  asRole(reader, 'SELECT * FROM auth.future_secret', /permission denied/);
  asRole(reader, 'SELECT * FROM mlm.future_business', /permission denied/);
  asRole(writer, 'SELECT * FROM auth.future_secret', /permission denied/);
  events.push('future_auth_columns_and_all_new_tables_require_new_review');
  guardedPolicy('GRANT SELECT ON auth.session TO PUBLIC', /reader_inherited_auth_secrets_access/, 'REVOKE SELECT ON auth.session FROM PUBLIC');
  guardedPolicy('GRANT UPDATE ON mlm.wallet_movement TO PUBLIC', /reader_inherited_write_access/, 'REVOKE UPDATE ON mlm.wallet_movement FROM PUBLIC');
  guardedPolicy('CREATE FUNCTION mlm.synthetic_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$SELECT 1$$',
    /accessible_security_definer_requires_separate_review/, 'DROP FUNCTION mlm.synthetic_definer()');
  guardedPolicy('ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON TABLES TO PUBLIC',
    /public_future_data_defaults_require_separate_review/, 'ALTER DEFAULT PRIVILEGES IN SCHEMA auth REVOKE SELECT ON TABLES FROM PUBLIC');
  events.push('public_data_writes_definer_and_future_defaults_abort_atomically');
  console.log(JSON.stringify({postgres:'18.6',cases:events,remoteDatabaseCalls:0,realMessages:0,existingRolesChanged:0}));
} finally {
  if (created) must(['rm', '-f', name]);
}
