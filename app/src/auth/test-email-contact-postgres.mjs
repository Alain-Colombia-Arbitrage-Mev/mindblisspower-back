// Explicit local-only rehearsal. No env file, cloud DSN, published port or
// real delivery provider is accepted; PostgreSQL runs in --network none.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

if (process.argv.slice(2).join(' ') !== '--synthetic-docker') throw new Error('Requires --synthetic-docker');
const name = `email-contact-pg-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const source = fileURLToPath(new URL('../', import.meta.url));
const phoneLibrary = fileURLToPath(new URL('../../node_modules/libphonenumber-js', import.meta.url));
const migration = readFileSync(new URL('../../../_meta/migration/76_registration_contact_details.sql', import.meta.url), 'utf8');
const identityMigration = readFileSync(new URL('../../../_meta/migration/70_stable_identity_bindings.sql', import.meta.url), 'utf8');
const env = { ...process.env, POSTGRES_PASSWORD: password,
  EMAIL_CONTACT_TEST_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:5432/email_contact_synthetic`,
  EMAIL_CONTACT_AUTH_DATABASE_URL: `postgres://contact_auth_fixture:${password}@127.0.0.1:5432/email_contact_synthetic` };
function docker(args, input) {
  const result = spawnSync('docker', args, { env, input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 90_000 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Synthetic Docker command failed').replaceAll(password, '[redacted]'));
  return result.stdout.trim();
}
let created = false;
try {
  docker(['run', '--pull=never', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=email_contact_synthetic',
    'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'disposable PostgreSQL did not become ready');
  const sql = text => docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'email_contact_synthetic', '-v', 'ON_ERROR_STOP=1'], text);
  sql(`
    CREATE EXTENSION citext;
    CREATE SCHEMA auth; CREATE SCHEMA mlm;
    CREATE TABLE auth."user" (id text PRIMARY KEY,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,name text,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE mlm.person (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id text UNIQUE REFERENCES auth."user"(id),
      first_name text NOT NULL,last_name text NOT NULL,email citext NOT NULL UNIQUE,phone_number text NOT NULL,
      status text NOT NULL DEFAULT 'pending',kyc_status text NOT NULL DEFAULT 'not_started',is_admin boolean NOT NULL DEFAULT false,
      blacklisted boolean NOT NULL DEFAULT false);
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,person_id bigint NOT NULL REFERENCES mlm.person(id),parent_id bigint,sponsor_id bigint,path text,current_rank_id integer);
    INSERT INTO mlm.person(first_name,last_name,email,phone_number,status) VALUES('Legacy','Member','legacy-contact@example.test','+573001111111','active');
    INSERT INTO mlm.affiliate VALUES(71,1,NULL,NULL,'n71',3);
    CREATE ROLE mindbliss_auth_core_v1 NOLOGIN;
    CREATE ROLE mindbliss_member_reader_bootstrap_v1 NOLOGIN;
    CREATE ROLE mindbliss_reader_20261025 NOLOGIN;
    GRANT mindbliss_member_reader_bootstrap_v1 TO mindbliss_reader_20261025;
    CREATE ROLE contact_auth_fixture LOGIN PASSWORD '${password}';
    GRANT mindbliss_auth_core_v1 TO contact_auth_fixture;
  `);
  sql(identityMigration);
  sql(`
    GRANT USAGE ON SCHEMA auth,mlm,identity TO mindbliss_auth_core_v1;
    GRANT SELECT,INSERT,UPDATE,DELETE ON auth."user",auth.session,auth.account,auth.verification,auth.jwks,auth.rate_limit TO mindbliss_auth_core_v1;
    GRANT SELECT(id,public_id,user_id,email,status,blacklisted,is_admin) ON mlm.person TO mindbliss_auth_core_v1;
    GRANT INSERT(user_id,first_name,last_name,email,phone_number,status,kyc_status),UPDATE(user_id) ON mlm.person TO mindbliss_auth_core_v1;
    GRANT SELECT,INSERT ON identity.auth_binding TO mindbliss_auth_core_v1;
    GRANT SELECT ON identity.link_conflict TO mindbliss_auth_core_v1;
    GRANT INSERT(subject,candidate_person_id,reason),UPDATE(last_seen_at,resolved_at) ON identity.link_conflict TO mindbliss_auth_core_v1;
    GRANT USAGE ON SEQUENCE mlm.person_id_seq,identity.link_conflict_id_seq TO mindbliss_auth_core_v1;
    GRANT USAGE ON SCHEMA auth,mlm,identity TO mindbliss_member_reader_bootstrap_v1;
    GRANT SELECT(id,email,email_verified,name) ON auth."user" TO mindbliss_member_reader_bootstrap_v1;
    GRANT SELECT ON mlm.person,identity.auth_binding,identity.link_conflict TO mindbliss_member_reader_bootstrap_v1;
  `);
  // Wrong database guard and inherited reader grants must roll back every DDL
  // change. These deliberate negative checks happen only in this scratch DB.
  assert.throws(() => sql(migration), /registration_contacts_explicit_database_review_required/);
  sql('GRANT SELECT ON auth."user" TO mindbliss_member_reader_bootstrap_v1');
  const reviewed = migration.replace('REPLACE_WITH_CURATED_DATABASE', 'email_contact_synthetic');
  assert.throws(() => sql(reviewed), /registration_contacts_reader_private_contact_access/);
  assert.match(sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='auth' AND table_name='user' AND column_name LIKE 'contact_%'"), /\n\s*0\s*\n/);
  sql('REVOKE SELECT ON auth."user" FROM mindbliss_member_reader_bootstrap_v1');
  sql(reviewed);
  const result = docker(['run', '--pull=never', '--rm', '-i', '--network', `container:${name}`, '--read-only', '--tmpfs', '/tmp',
    '--mount', `type=bind,source=${source},target=/app/src,readonly`,
    '--mount', `type=bind,source=${phoneLibrary},target=/app/node_modules/libphonenumber-js,readonly`,
    '-e', 'EMAIL_CONTACT_TEST_DATABASE_URL', '-e', 'EMAIL_CONTACT_AUTH_DATABASE_URL',
    '--entrypoint', 'bun', 'mindbliss/api-test:auth-identity-20261025', '--no-env-file', '-'], String.raw`
    import assert from 'node:assert/strict';
    import {createHash,createHmac} from 'node:crypto';
    import postgres from 'postgres';
    import {drizzle} from 'drizzle-orm/postgres-js';
    import {betterAuth} from 'better-auth';
    import {Hono} from 'hono';
    import {postgresAuthAdapter} from './src/auth/postgres-auth-adapter.ts';
    import {createAuthOptions} from './src/auth/options.ts';
    import {authProxyContext} from './src/http/auth-proxy-context.ts';
    import {provisionAuthPerson,getAuthPersonBinding} from './src/modules/identity/index.ts';
    const url=new URL(process.env.EMAIL_CONTACT_TEST_DATABASE_URL);
    assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'5432'); assert.equal(url.pathname,'/email_contact_synthetic');
    let providerCalls=0; globalThis.fetch=async()=>{providerCalls++;throw new Error('External network forbidden');};
    const owner=postgres(url.href,{max:2,prepare:false,onnotice:()=>{}});
    const writerConnection=postgres(process.env.EMAIL_CONTACT_AUTH_DATABASE_URL,{max:4,prepare:false,onnotice:()=>{}});
    const db=drizzle(writerConnection);
    const env={NODE_ENV:'production',BETTER_AUTH_SECRET:'synthetic-contact-secret-at-least-thirty-two-characters',
      BETTER_AUTH_URL:'https://auth.example.test',BETTER_AUTH_TRUSTED_ORIGINS:'https://portal.example.test',
      AUTH_BFF_SHARED_SECRET:'synthetic-bff-secret-at-least-thirty-two-characters',BETTER_AUTH_EMAIL_OTP_ENABLED:'true',
      BETTER_AUTH_REGISTRATION_SMS_REQUIRED:'true',BETTER_AUTH_PHONE_OTP_ENABLED:'false',
      CLOUDFLARE_EMAIL_API_TOKEN:'synthetic-not-real',CLOUDFLARE_ACCOUNT_ID:'00000000000000000000000000000001',AUTH_EMAIL_FROM:'auth@example.test',
      SENTDM_API_KEY:'synthetic-not-real',SENTDM_OTP_TEMPLATE_ID:'00000000-0000-4000-8000-000000000001',SENTDM_OTP_CHANNEL:'sms'};
    const emails=[];let sms=0;let assertions=0;
    const equal=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);assertions++;};
    const check=(value,message)=>{assert.ok(value,message);assertions++;};
    const identity={provision:userId=>provisionAuthPerson(db,{userId}),binding:userId=>getAuthPersonBinding(db,{userId}),registrationAllowed:async()=>true};
    const auth=betterAuth(createAuthOptions(env,postgresAuthAdapter(db),identity,{email:async message=>{emails.push(message);},phone:async()=>{sms++;}}));
    const app=new Hono();app.use('/api/auth/*',authProxyContext(env.AUTH_BFF_SHARED_SECRET));
    app.on(['POST','GET'],'/api/auth/*',c=>auth.handler(c.req.raw));
    let ipNumber=1;
    async function request(path,body,cookie='') {
      const method=body===undefined?'GET':'POST';const serialized=body===undefined?'':JSON.stringify(body);
      const timestamp=String(Math.floor(Date.now()/1000));const ip='192.0.2.'+(ipNumber++);
      const hash=value=>createHash('sha256').update(value).digest('hex');
      const signature=createHmac('sha256',env.AUTH_BFF_SHARED_SECRET).update([method,'/api/auth'+path,timestamp,ip,hash(cookie),hash(serialized)].join('\n')).digest('hex');
      return app.request(new Request(env.BETTER_AUTH_URL+'/api/auth'+path,{method,
        headers:{origin:'https://portal.example.test','content-type':'application/json',cookie,'x-vp-auth-client-ip':ip,
          'x-vp-auth-timestamp':timestamp,'x-vp-auth-signature':signature},...(body===undefined?{}:{body:serialized})}));
    }
    const signup=(email,extra={})=>request('/sign-up/email',{name:'Synthetic Contact',email,password:'Synthetic-contact-password-123',...extra});
    const cookie=response=>response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    const emailCode=()=>/\b(\d{6})\b/.exec(emails.at(-1).text)[1];
    try {
      const fingerprint=JSON.stringify(await owner.unsafe('SELECT to_jsonb(a) AS row FROM mlm.affiliate a ORDER BY id'));
      const phone='+573001234567',whatsapp='+12025550123',email='new-contact@example.test';
      const response=await signup(email,{contactPhone:phone,contactWhatsapp:whatsapp});
      equal(response.status,200,'restricted auth role creates email account with private contacts');
      const payload=await response.json();equal(payload.token,null);equal(payload.user.emailVerified,false);
      equal(payload.user.contactPhone,undefined);equal(payload.user.contactWhatsapp,undefined);equal(response.headers.has('set-cookie'),false);
      const rows=await owner.unsafe('SELECT id,contact_phone_e164,contact_whatsapp_e164,phone_number,phone_number_verified,email_verified FROM auth."user" WHERE email=$1',[email]);
      equal(rows[0].contact_phone_e164,phone);equal(rows[0].contact_whatsapp_e164,whatsapp);equal(rows[0].phone_number,null);equal(rows[0].phone_number_verified,false);
      equal((await owner.unsafe('SELECT count(*)::int AS n FROM mlm.person WHERE user_id=$1',[rows[0].id]))[0].n,0,'unverified email never creates business identity');
      equal((await owner.unsafe('SELECT count(*)::int AS n FROM auth.session'))[0].n,0);
      equal((await request('/sign-in/email',{email,password:'Synthetic-contact-password-123'})).status,403);
      equal((await request('/email-otp/verify-email',{email,otp:emailCode()})).status,200);
      equal((await owner.unsafe('SELECT count(*)::int AS n FROM auth.session'))[0].n,0,'verification itself does not create session');
      const login=await request('/sign-in/email',{email,password:'Synthetic-contact-password-123'});equal(login.status,200);
      const person=(await owner.unsafe('SELECT phone_number FROM mlm.person WHERE user_id=$1',[rows[0].id]))[0];equal(person.phone_number,phone,'only new person receives its own subject contact');
      const session=await request('/get-session',undefined,cookie(login));equal(session.status,200);
      const current=await session.json();equal(current.user.emailVerified,true);equal(current.user.contactPhone,undefined);equal(current.user.contactWhatsapp,undefined);
      const originalPhone=(await owner.unsafe("SELECT phone_number FROM mlm.person WHERE email='legacy-contact@example.test'"))[0].phone_number;
      equal((await signup('legacy-contact@example.test',{contactPhone:phone,contactWhatsapp:whatsapp})).status,200,'shared contact is not reserved or unique');
      equal((await request('/email-otp/verify-email',{email:'legacy-contact@example.test',otp:emailCode()})).status,200);
      equal((await request('/sign-in/email',{email:'legacy-contact@example.test',password:'Synthetic-contact-password-123'})).status,200);
      const legacy=(await owner.unsafe("SELECT user_id,phone_number FROM mlm.person WHERE email='legacy-contact@example.test'"))[0];equal(legacy.user_id,null);equal(legacy.phone_number,originalPhone,'never overwrite legacy contact or claim via email/phone');
      const legacyUser=(await owner.unsafe('SELECT id FROM auth."user" WHERE email=$1',['legacy-contact@example.test']))[0];
      equal((await getAuthPersonBinding(db,{userId:legacyUser.id})).status,'claim_required');
      equal((await signup('short-country@example.test',{contactPhone:'+6838888'})).status,200,'country metadata allows a possible seven-digit international number');
      equal((await signup('empty-contact@example.test',{contactPhone:'',contactWhatsapp:'  '})).status,200);
      equal((await owner.unsafe('SELECT contact_phone_e164,contact_whatsapp_e164 FROM auth."user" WHERE email=$1',['empty-contact@example.test']))[0],{contact_phone_e164:null,contact_whatsapp_e164:null});
      for(const [field,value] of [['contactPhone','+999123456789'],['contactWhatsapp',null],['contactWhatsapp','+12025550123x8']]) {
        equal((await signup('invalid-'+assertions+'@example.test',{[field]:value})).status,400);
      }
      for(const path of ['/registration/phone/send','/registration/phone/verify','/sign-in/phone-number'])equal((await request(path,{email,phoneNumber:phone,code:'123456'})).status,404);
      await assert.rejects(()=>writerConnection.unsafe("UPDATE mlm.person SET phone_number='+12025550123' WHERE id=1"));assertions++;
      await assert.rejects(()=>owner.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE mindbliss_reader_20261025');await tx.unsafe('SELECT contact_phone_e164 FROM auth."user"');}));assertions++;
      await assert.rejects(()=>owner.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE mindbliss_reader_20261025');await tx.unsafe('SELECT contact_whatsapp_e164 FROM auth."user"');}));assertions++;
      for(const column of ['contact_phone_e164','contact_whatsapp_e164'])await assert.rejects(()=>owner.unsafe('UPDATE auth."user" SET '+column+'=$1 WHERE id=$2',['not-E164',rows[0].id]));assertions+=2;
      equal(JSON.stringify(await owner.unsafe('SELECT to_jsonb(a) AS row FROM mlm.affiliate a ORDER BY id')),fingerprint,'network positions and ranks unchanged');
      equal((await owner.unsafe('SELECT phone_number_verified FROM auth."user" WHERE id=$1',[rows[0].id]))[0].phone_number_verified,false);
      equal(sms,0);equal(providerCalls,0);equal((await owner.unsafe("SELECT to_regclass('auth.sms_opt_in') AS relation"))[0].relation,null);
      console.log(JSON.stringify({syntheticPostgres:'17.11',assertions,migrationDatabaseGuard:true,inheritedReaderGuard:true,
        restrictedAuthRole:true,emailProofRequired:true,contactsPersisted:true,sharedContactsAllowed:true,
        legacyPersonUnchanged:true,treeAndRankUnchanged:true,registrationSms:false,realMessages:0,network:'none',providerCalls,productionAccess:false}));
    } finally {await Promise.all([writerConnection.end({timeout:2}),owner.end({timeout:2})]);}
  `);
  console.log(result);
} finally {if (created) docker(['rm', '-f', name]);}
