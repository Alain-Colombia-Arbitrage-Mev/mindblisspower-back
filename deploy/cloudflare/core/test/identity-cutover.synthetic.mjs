// Explicit ephemeral PostgreSQL18 rehearsal; never accepts a cloud DSN/env.
// Run: node test/identity-cutover.synthetic.mjs --synthetic-docker
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
assert.equal(process.argv.slice(2).join(' '),'--synthetic-docker');
const database='identity_cutover_synthetic',name=`identity-cutover-${randomBytes(6).toString('hex')}`;
const reader='mindbliss_reader_20261025',writer='mindbliss_auth_20261025';
const readGroup='mindbliss_member_reader_bootstrap_v1',authGroup='mindbliss_auth_core_v1';
const migrationSource=readFileSync(new URL('../../../../_meta/migration/72_cloudflare_identity_cutover.sql',import.meta.url),'utf8');
const migration=migrationSource.replaceAll('REPLACE_WITH_CURATED_DATABASE',database);
const migration72Sha256=createHash('sha256').update(migrationSource).digest('hex');
const authCore=readFileSync(new URL('../../../../_meta/migration/71_better_auth_core_only.sql',import.meta.url),'utf8').replaceAll('REPLACE_WITH_CURATED_DATABASE',database);
const bootstrap=readFileSync(new URL('../role-bootstrap.example.sql',import.meta.url),'utf8').replaceAll('REPLACE_WITH_CURATED_DATABASE',database);
const app=fileURLToPath(new URL('../../../../app',import.meta.url));
const cases=[];let created=false;
const docker=(args,input)=>spawnSync('docker',args,{input,encoding:'utf8',maxBuffer:8*1024*1024,timeout:90_000});
function must(args,input){const r=docker(args,input);assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
function sql(input,fail){const r=docker(['exec','-i',name,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],input);
  if(fail){assert.notEqual(r.status,0);assert.match(r.stderr,fail)}else assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
const as=(role,input,fail)=>sql(`BEGIN;SET LOCAL ROLE ${role};${input};ROLLBACK;`,fail);
function guarded(setup,error,cleanup){sql(setup);sql(migration,error);assert.equal(sql("SELECT to_regnamespace('identity') IS NULL AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='mlm.person'::regclass AND attname='public_id' AND NOT attisdropped)"),'t');sql(cleanup)}
try{
  must(['run','-d','--pull=never','--name',name,'--network','none','--tmpfs','/var/lib/postgresql','-e','POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',`POSTGRES_DB=${database}`,'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888']);created=true;
  let ready=false;for(let i=0;i<60;i++){if(docker(['exec',name,'pg_isready','-U','postgres']).status===0){ready=true;break}await new Promise(r=>setTimeout(r,500))}assert.ok(ready);
  sql(`CREATE EXTENSION citext;CREATE EXTENSION ltree;CREATE EXTENSION unaccent;CREATE SCHEMA auth;CREATE SCHEMA mlm;CREATE SCHEMA payments;
    CREATE ROLE synthetic_shared_old NOLOGIN;GRANT pg_read_all_data,pg_write_all_data TO synthetic_shared_old;
    CREATE ROLE app_read NOLOGIN;CREATE ROLE app_write NOLOGIN;CREATE ROLE app_admin NOLOGIN;
    CREATE TABLE auth.user(id text PRIMARY KEY,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,name text,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TYPE mlm.person_status AS ENUM('pending','active','suspended','banned','deleted');
    CREATE TYPE mlm.kyc_status AS ENUM('not_started','in_review','approved','rejected','expired');
    CREATE TABLE mlm.person(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id text UNIQUE REFERENCES auth.user(id) ON DELETE RESTRICT,
      legacy_id_person integer UNIQUE,first_name text NOT NULL,last_name text NOT NULL,email citext NOT NULL UNIQUE,phone_number text NOT NULL,
      status mlm.person_status NOT NULL DEFAULT 'pending',kyc_status mlm.kyc_status NOT NULL DEFAULT 'not_started',
      is_admin boolean NOT NULL DEFAULT false,blacklisted boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE mlm.rank(id smallint PRIMARY KEY,code text NOT NULL UNIQUE);
    CREATE TABLE mlm.affiliate(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,person_id bigint NOT NULL UNIQUE REFERENCES mlm.person(id),
      parent_id bigint REFERENCES mlm.affiliate(id),sponsor_id bigint REFERENCES mlm.affiliate(id),position text,path ltree NOT NULL,
      current_rank_id smallint REFERENCES mlm.rank(id),left_pv numeric NOT NULL DEFAULT 0,right_pv numeric NOT NULL DEFAULT 0);
    CREATE TABLE mlm.affiliate_package(id bigint);CREATE TABLE mlm.blacklist(id bigint);CREATE TABLE mlm.package(id bigint);
    CREATE VIEW mlm.v_rank_progress AS SELECT id AS affiliate_id FROM mlm.affiliate;
    CREATE TABLE mlm.wallet_movement(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,amount numeric);
    CREATE TABLE mlm.concept(id bigint);CREATE TABLE mlm.bonus_run(id bigint);CREATE TABLE mlm.alert_event(id bigint);CREATE TABLE mlm.plan_config(id bigint);
    CREATE TABLE payments.purchase_intent(id uuid);
    CREATE FUNCTION mlm.norm_email(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT lower(btrim($1))$$;
    CREATE FUNCTION mlm.norm_phone10(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT right($1,10)$$;
    CREATE FUNCTION mlm.norm_name(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT lower(public.unaccent($1))$$;
    INSERT INTO mlm.person(legacy_id_person,first_name,last_name,email,phone_number,status)
      VALUES(1,'Synthetic','Legacy One','legacy1@example.test','','active'),(2,'Synthetic','Legacy Two','legacy2@example.test','','active');
    INSERT INTO mlm.rank VALUES(3,'SYNTHETIC');
    INSERT INTO mlm.affiliate(person_id,path,current_rank_id) VALUES(1,'n1',3);
    INSERT INTO mlm.affiliate(person_id,parent_id,sponsor_id,position,path,current_rank_id) VALUES(2,1,1,'L','n1.n2',3);
    INSERT INTO mlm.wallet_movement(amount) VALUES(17);`);
  sql(authCore);sql(bootstrap);sql(migrationSource,/explicit_database_review_required/);
  sql(migration,/runtime_role_attributes_require_review/);
  sql(`CREATE ROLE ${reader} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ${writer} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT ${readGroup} TO ${reader} WITH INHERIT TRUE,SET FALSE,ADMIN FALSE;
    GRANT ${authGroup} TO ${writer} WITH INHERIT TRUE,SET FALSE,ADMIN FALSE;`);
  const personHash=sql("SELECT md5(string_agg(to_jsonb(p)::text,'' ORDER BY id)) FROM mlm.person p");
  const treeHash=sql("SELECT md5(string_agg(to_jsonb(a)::text,'' ORDER BY id)) FROM mlm.affiliate a");
  const rolesHash=sql("SELECT md5(string_agg(to_jsonb(r)::text,'' ORDER BY rolname)) FROM pg_roles r");
  const membershipHash=sql("SELECT md5(string_agg(to_jsonb(m)::text,'' ORDER BY roleid,member,grantor)) FROM pg_auth_members m");
  guarded(`GRANT ${readGroup} TO ${reader} WITH SET TRUE`,/login_membership_requires_review/,`GRANT ${readGroup} TO ${reader} WITH SET FALSE`);
  guarded(`GRANT pg_read_all_data TO ${reader}`,/login_membership_requires_review/,`REVOKE pg_read_all_data FROM ${reader}`);
  guarded("INSERT INTO auth.user(id,email) VALUES('premature','premature@example.test')",/enrollment_already_started_requires_review/,"DELETE FROM auth.user WHERE id='premature'");
  guarded('CREATE FUNCTION mlm.synthetic_person_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$;CREATE TRIGGER synthetic_person_trigger BEFORE UPDATE ON mlm.person FOR EACH ROW EXECUTE FUNCTION mlm.synthetic_person_trigger()',
    /person_rules_or_triggers_require_review/,'DROP TRIGGER synthetic_person_trigger ON mlm.person;DROP FUNCTION mlm.synthetic_person_trigger()');
  guarded('GRANT SELECT ON auth.session TO PUBLIC',/reader_auth_secrets_access/,'REVOKE SELECT ON auth.session FROM PUBLIC');
  guarded('GRANT UPDATE ON mlm.wallet_movement TO PUBLIC',/reader_write_access/,'REVOKE UPDATE ON mlm.wallet_movement FROM PUBLIC');
  guarded('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO synthetic_shared_old',/global_default_data_grants_require_review/,
    'ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM synthetic_shared_old');
  guarded(`CREATE FUNCTION mlm.synthetic_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$SELECT 1$$;
    REVOKE ALL ON FUNCTION mlm.synthetic_definer() FROM PUBLIC;GRANT EXECUTE ON FUNCTION mlm.synthetic_definer() TO ${authGroup}`,
    /newly_accessible_definer_requires_review/,'DROP FUNCTION mlm.synthetic_definer()');
  cases.push('target_empty_enrollment_role_membership_person_trigger_public_acl_guards_atomic');
  sql(migration);sql(migration,/existing_identity_state_requires_review/);
  assert.equal(sql("SELECT md5(string_agg((to_jsonb(p)-'public_id')::text,'' ORDER BY id)) FROM mlm.person p"),personHash);
  assert.equal(sql("SELECT md5(string_agg(to_jsonb(a)::text,'' ORDER BY id)) FROM mlm.affiliate a"),treeHash);
  assert.equal(sql("SELECT md5(string_agg(to_jsonb(r)::text,'' ORDER BY rolname)) FROM pg_roles r"),rolesHash);
  assert.equal(sql("SELECT md5(string_agg(to_jsonb(m)::text,'' ORDER BY roleid,member,grantor)) FROM pg_auth_members m"),membershipHash);
  assert.equal(sql('SELECT count(*)=count(public_id) AND count(*)=count(DISTINCT public_id) FROM mlm.person'),'t');
  sql('UPDATE mlm.person SET public_id=gen_random_uuid() WHERE id=1',/person_public_id_is_immutable/);
  assert.equal(sql('SELECT count(*) FROM auth.user'),'0');assert.equal(sql('SELECT count(*) FROM identity.auth_binding'),'0');
  for(const statement of ['SELECT token FROM auth.session','SELECT private_key FROM auth.jwks','SELECT token_hash FROM identity.legacy_claim_grant'])as(reader,statement,/permission denied/);
  for(const statement of ['UPDATE mlm.person SET is_admin=true','UPDATE mlm.person SET status=\'active\'',
    'INSERT INTO mlm.affiliate(person_id,path) VALUES(1,\'denied\')','UPDATE mlm.wallet_movement SET amount=0',
    'INSERT INTO identity.legacy_claim_grant DEFAULT VALUES','INSERT INTO identity.stripe_customer DEFAULT VALUES'])as(writer,statement,/permission denied/);
  cases.push('canonical_uuid_addition_preserves_people_tree_ranks_and_all_existing_role_memberships');
  const integration=String.raw`
    import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
    import postgres from 'postgres';import {drizzle} from 'drizzle-orm/postgres-js';
    import {betterAuth} from 'better-auth';import {drizzleAdapter} from 'better-auth/adapters/drizzle';
    import {createLocalJWKSet,jwtVerify} from 'jose';import * as schema from './src/db/schema/auth.ts';
    import {createAuthOptions} from './src/auth/options.ts';import {createAuthDelivery} from './src/auth/delivery.ts';
    import {provisionAuthPerson,getAuthPersonBinding,approveLegacyClaim,claimLegacyPerson} from './src/modules/identity/index.ts';
    assert.equal((await Bun.file('./node_modules/better-auth/package.json').json()).version,'1.6.22');
    const owner=postgres('postgres://postgres@127.0.0.1:5432/identity_cutover_synthetic',{max:1,prepare:false});
    const write=postgres('postgres://mindbliss_auth_20261025@127.0.0.1:5432/identity_cutover_synthetic',{max:4,prepare:false});
    const read=postgres('postgres://mindbliss_reader_20261025@127.0.0.1:5432/identity_cutover_synthetic',{max:1,prepare:false});
    const w=drizzle(write),r=drizzle(read),operator=drizzle(owner),messages=[];
    const env={BETTER_AUTH_SECRET:'synthetic-identity-secret-at-least-32-characters',BETTER_AUTH_URL:'https://auth.example.test',
      BETTER_AUTH_TRUSTED_ORIGINS:'https://portal.example.test',BETTER_AUTH_EMAIL_OTP_ENABLED:'true',BETTER_AUTH_PHONE_OTP_ENABLED:'false',
      BETTER_AUTH_JWT_ENABLED:'true',BETTER_AUTH_JWT_ISSUER:'https://auth.example.test',BETTER_AUTH_JWT_AUDIENCE:'synthetic-identity-members',
      CLOUDFLARE_ACCOUNT_ID:'00000000000000000000000000000001',CLOUDFLARE_EMAIL_API_TOKEN:'synthetic-identity-token',AUTH_EMAIL_FROM:'codes@example.test'};
    const delivery=createAuthDelivery(env,async(_url,request)=>{const body=JSON.parse(request.body);messages.push(body);
      return Response.json({success:true,errors:[],result:{delivered:[],queued:body.to,permanent_bounces:[]}})});
    // REAL database identity hooks. Only delivery transport is fake; owner is
    // restricted to explicitly identified fixture/bootstrap/operator actions.
    const auth=betterAuth(createAuthOptions(env,drizzleAdapter(w,{provider:'pg',schema,usePlural:false}),
      {provision:userId=>provisionAuthPerson(w,{userId}),binding:userId=>getAuthPersonBinding(w,{userId})},delivery));
    const request=(path,body,cookie)=>auth.handler(new Request(env.BETTER_AUTH_URL+'/api/auth'+path,{method:body===undefined?'GET':'POST',
      headers:{origin:'https://portal.example.test','content-type':'application/json','x-forwarded-for':'192.0.2.72',...(cookie?{cookie}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})}));
    const cookies=response=>response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
    const code=()=>messages.at(-1).text.match(/\b(\d{6})\b/)[1];
    try{
      const originalTree=JSON.stringify(await owner.unsafe('SELECT to_jsonb(a) AS row FROM mlm.affiliate a ORDER BY id'));
      assert.equal((await request('/email-otp/send-verification-otp',{email:'legacy2@example.test',type:'sign-in'})).status,200);
      assert.equal(messages.length,0);assert.equal((await owner.unsafe('SELECT count(*)::int AS n FROM auth.user'))[0].n,0);
      // Synthetic FIRST-OPERATOR bootstrap represents separate explicit human
      // approval. It is NOT in migration72 and never creates an affiliate.
      await owner.unsafe("INSERT INTO auth.user(id,email,email_verified,name) VALUES('staff-operator','staff@example.test',false,'Synthetic Staff Operator')");
      const staff=(await owner.unsafe("INSERT INTO mlm.person(user_id,first_name,last_name,email,phone_number,status,kyc_status,is_admin) VALUES('staff-operator','Synthetic','Staff','staff@example.test','','active','not_started',true) RETURNING id::text,public_id::text"))[0];
      await owner.unsafe("INSERT INTO identity.auth_binding(subject,person_id,link_method) VALUES('staff-operator',"+staff.id+",'new_registration')");
      assert.equal((await getAuthPersonBinding(w,{userId:'staff-operator'})).status,'verification_required');
      await assert.rejects(()=>approveLegacyClaim(operator,{approverUserId:'staff-operator',userId:'not-created',personPublicId:staff.public_id,kind:'approved_claim'}),/identity_approval_denied/);
      assert.equal((await request('/token')).status,401);
      assert.equal((await request('/email-otp/send-verification-otp',{email:'staff@example.test',type:'sign-in'})).status,200);
      const staffCode=code();const staffLogin=await request('/sign-in/email-otp',{email:'staff@example.test',otp:staffCode});assert.equal(staffLogin.status,200);
      const staffCookie=cookies(staffLogin);assert.equal((await getAuthPersonBinding(r,{userId:'staff-operator'})).status,'existing');
      assert.equal((await owner.unsafe("SELECT email_verified FROM auth.user WHERE id='staff-operator'"))[0].email_verified,true);
      assert.equal((await owner.unsafe('SELECT count(*)::int AS n FROM mlm.affiliate WHERE person_id='+staff.id))[0].n,0);
      assert.equal((await request('/token',undefined,staffCookie)).status,200);
      const password=randomUUID()+randomUUID();
      const signup=await request('/sign-up/email',{email:'legacy1@example.test',name:'Synthetic Legacy Applicant',password});assert.equal(signup.status,200);
      const legacyUser=(await signup.json()).user.id;assert.equal((await getAuthPersonBinding(w,{userId:legacyUser})).status,'verification_required');
      const verified=await request('/email-otp/verify-email',{email:'legacy1@example.test',otp:code()});assert.equal(verified.status,200);
      const legacyLogin=await request('/sign-in/email',{email:'legacy1@example.test',password});assert.equal(legacyLogin.status,200);
      const legacyCookie=cookies(legacyLogin);assert.equal((await getAuthPersonBinding(r,{userId:legacyUser})).status,'claim_required');
      assert.equal((await request('/token',undefined,legacyCookie)).status,403);
      const legacyPerson=(await owner.unsafe("SELECT id::text,public_id::text,user_id FROM mlm.person WHERE email='legacy1@example.test'"))[0];assert.equal(legacyPerson.user_id,null);
      const approval={approverUserId:'staff-operator',userId:legacyUser,personPublicId:legacyPerson.public_id,kind:'approved_claim'};
      await assert.rejects(()=>approveLegacyClaim(w,approval),error=>(error.cause?.code??error.code)==='42501');
      const grant=await approveLegacyClaim(operator,approval);
      assert.notEqual((await owner.unsafe("SELECT token_hash FROM identity.legacy_claim_grant WHERE id='"+grant.grantId+"'"))[0].token_hash,grant.token);
      assert.equal((await claimLegacyPerson(w,{userId:legacyUser,token:grant.token})).status,'existing');
      assert.equal((await claimLegacyPerson(w,{userId:legacyUser,token:grant.token})).personId,legacyPerson.id);
      const tokenResponse=await request('/token',undefined,legacyCookie);assert.equal(tokenResponse.status,200);
      const {token}=await tokenResponse.json();const jwks=await(await request('/jwks')).json();
      const{payload,protectedHeader}=await jwtVerify(token,createLocalJWKSet(jwks),{issuer:env.BETTER_AUTH_JWT_ISSUER,audience:env.BETTER_AUTH_JWT_AUDIENCE});
      assert.equal(protectedHeader.alg,'RS256');assert.equal(payload.sub,legacyUser);assert.equal(payload.person_public_id,legacyPerson.public_id);
      assert.equal(payload.email_verified,true);assert.equal(payload.exp-payload.iat,300);
      assert.equal(JSON.stringify(await owner.unsafe('SELECT to_jsonb(a) AS row FROM mlm.affiliate a ORDER BY id')),originalTree);
      assert.equal((await owner.unsafe('SELECT count(*)::int AS n FROM mlm.person'))[0].n,3);
      await assert.rejects(()=>read.unsafe('SELECT token_hash FROM identity.legacy_claim_grant'));
      await assert.rejects(()=>read.unsafe('SELECT private_key FROM auth.jwks'));
      await assert.rejects(()=>write.unsafe('UPDATE mlm.person SET is_admin=true'));
      console.log(JSON.stringify({betterAuth:'1.6.22',realBusinessIdentityHooks:true,firstAdminRequiresOTP:true,staffAffiliateCount:0,
        legacyAutoLink:false,verifiedEmailAndSeparateApprovalRequired:true,treeAndRankChanges:0,realMessages:0}));
    }finally{await owner.end();await write.end();await read.end()}
  `;
  const output=must(['run','--rm','--pull=never','--network',`container:${name}`,'--read-only','--tmpfs','/tmp',
    '--mount',`type=bind,source=${app}/src,target=/app/src,readonly`,'--entrypoint','bun','mindbliss/api-test:auth-identity-20261025','--no-env-file','-e',integration]);
  assert.match(output,/"realBusinessIdentityHooks":true/);assert.match(output,/"legacyAutoLink":false/);
  cases.push('real_better_auth_hooks_staff_otp_no_affiliate_legacy_verification_then_operator_approval');
  assert.equal(sql("SELECT md5(string_agg(to_jsonb(a)::text,'' ORDER BY id)) FROM mlm.affiliate a"),treeHash);
  assert.equal(sql('SELECT amount FROM mlm.wallet_movement WHERE id=1'),'17');
  console.log(JSON.stringify({postgres:'18.6',migration72Sha256,cases,remoteDatabaseCalls:0,realMessages:0,treeAndFinancialWrites:0,realBusinessIdentityHooks:true}));
}finally{if(created)must(['rm','-f',name])}
