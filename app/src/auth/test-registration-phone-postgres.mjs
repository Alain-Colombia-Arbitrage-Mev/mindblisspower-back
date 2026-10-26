// Opt-in disposable integration test. Never reads a host/cloud database URL,
// publishes a port, loads an env file or reaches a real messaging provider.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

if (process.argv.slice(2).join(' ') !== '--synthetic-docker') throw new Error('Requires --synthetic-docker');
const name = `registration-phone-pg-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const source = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, POSTGRES_PASSWORD: password,
  REGISTRATION_PHONE_TEST_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:5432/registration_phone_synthetic` };
function docker(args, input) {
  const result = spawnSync('docker', args, { env, input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 90_000 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Synthetic Docker command failed').replaceAll(password, '[redacted]'));
  return result.stdout.trim();
}
let created = false;
try {
  docker(['run', '--pull=never', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=registration_phone_synthetic',
    'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'disposable PostgreSQL did not become ready');
  // Minimal mirror of src/db/schema/auth.ts. Deliberately no optional sms_opt_in
  // table: registration proof must not require that separate profile feature.
  docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'registration_phone_synthetic', '-v', 'ON_ERROR_STOP=1'], `
    CREATE SCHEMA auth;
    CREATE TABLE auth."user" (
      id text PRIMARY KEY, email text NOT NULL UNIQUE, email_verified boolean NOT NULL DEFAULT false,
      name text, image text, phone_number text UNIQUE, phone_number_verified boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE auth.session (
      id text PRIMARY KEY, user_id text NOT NULL REFERENCES auth."user" ON DELETE CASCADE,
      expires_at timestamptz NOT NULL, token text NOT NULL UNIQUE, ip_address text, user_agent text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE auth.account (
      id text PRIMARY KEY, user_id text NOT NULL REFERENCES auth."user" ON DELETE CASCADE,
      account_id text NOT NULL, provider_id text NOT NULL, access_token text, refresh_token text, id_token text,
      access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text, password text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(provider_id, account_id));
    CREATE TABLE auth.verification (
      id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX ON auth.verification(identifier);
    CREATE TABLE auth.rate_limit (id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL, last_request bigint NOT NULL);
    CREATE TABLE auth.jwks (id text PRIMARY KEY, public_key text NOT NULL, private_key text NOT NULL,
      created_at timestamptz NOT NULL, expires_at timestamptz);
  `);
  const result = docker(['run', '--pull=never', '--rm', '-i', '--network', `container:${name}`, '--read-only', '--tmpfs', '/tmp',
    '--mount', `type=bind,source=${source},target=/app/src,readonly`, '-e', 'REGISTRATION_PHONE_TEST_DATABASE_URL',
    '--entrypoint', 'bun', 'mindbliss/api-test:auth-identity-20261025', '--no-env-file', '-'], String.raw`
    import assert from 'node:assert/strict';
    import {createHash,createHmac} from 'node:crypto';
    import postgres from 'postgres';
    import {drizzle} from 'drizzle-orm/postgres-js';
    import {betterAuth} from 'better-auth';
    import {Hono} from 'hono';
    import {bodyLimit} from 'hono/body-limit';
    import {postgresAuthAdapter} from './src/auth/postgres-auth-adapter.ts';
    import {createAuthOptions} from './src/auth/options.ts';
    import {authProxyContext} from './src/http/auth-proxy-context.ts';
    import {consumePhoneOTP,otpHash,recipientBudgetKey} from './src/auth/phone-otp.ts';
    import {registrationPhoneProof} from './src/auth/registration-phone.ts';
    const url=new URL(process.env.REGISTRATION_PHONE_TEST_DATABASE_URL);
    assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'5432');
    assert.equal(url.pathname,'/registration_phone_synthetic');
    // The container shares only the network namespace of a --network none PG.
    let providerCalls=0;
    globalThis.fetch=async()=>{providerCalls++;throw new Error('External network forbidden in synthetic test');};
    const connection=postgres(url.href,{max:8,prepare:false,connection:{application_name:'registration-phone-cas',statement_timeout:10000}});
    const control=postgres(url.href,{max:2,prepare:false,connection:{application_name:'registration-phone-control',statement_timeout:10000}});
    const db=drizzle(connection);
    let assertions=0;
    const equal=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);assertions++;};
    const check=(condition,message)=>{assert.ok(condition,message);assertions++;};
    const env={NODE_ENV:'production',BETTER_AUTH_SECRET:'synthetic-registration-secret-at-least-thirty-two',
      BETTER_AUTH_URL:'https://auth.example.test',BETTER_AUTH_TRUSTED_ORIGINS:'https://portal.example.test',
      AUTH_BFF_SHARED_SECRET:'synthetic-bff-secret-at-least-thirty-two-characters',
      BETTER_AUTH_EMAIL_OTP_ENABLED:'true',BETTER_AUTH_REGISTRATION_SMS_REQUIRED:'true',
      BETTER_AUTH_PHONE_OTP_ENABLED:'false',BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY:'false',
      CLOUDFLARE_EMAIL_API_TOKEN:'synthetic-not-real',CLOUDFLARE_ACCOUNT_ID:'00000000000000000000000000000001',AUTH_EMAIL_FROM:'auth@example.test',
      SENTDM_API_KEY:'synthetic-not-real',SENTDM_OTP_TEMPLATE_ID:'00000000-0000-4000-8000-000000000001',SENTDM_OTP_CHANNEL:'sms'};
    const sms=[]; const emails=[];
    const identity={provision:async()=>({status:'verification_required'}),binding:async()=>({status:'claim_required'}),registrationAllowed:async()=>true};
    const delivery={phone:async(phone,code)=>{sms.push({phone,code});},email:async(message)=>{emails.push(message);}};
    const options=createAuthOptions(env,postgresAuthAdapter(db),identity,delivery);
    const auth=betterAuth(options);
    const adapter=(await auth.$context).adapter;
    const appFor=authInstance=>{
      const app=new Hono();
      app.use('/api/auth/*',bodyLimit({maxSize:32768}));
      app.use('/api/auth/*',authProxyContext(env.AUTH_BFF_SHARED_SECRET));
      app.on(['POST','GET'],'/api/auth/*',c=>authInstance.handler(c.req.raw));
      return app;
    };
    const app=appFor(auth);
    let ipNumber=1;
    async function request(path,body,cookie='',application=app) {
      const method=body===undefined?'GET':'POST'; const serialized=body===undefined?'':JSON.stringify(body);
      const timestamp=String(Math.floor(Date.now()/1000)); const ip='192.0.2.'+(ipNumber++);
      const hash=value=>createHash('sha256').update(value).digest('hex');
      const signature=createHmac('sha256',env.AUTH_BFF_SHARED_SECRET).update([method,'/api/auth'+path,timestamp,ip,hash(cookie),hash(serialized)].join('\n')).digest('hex');
      return application.request(new Request(env.BETTER_AUTH_URL+'/api/auth'+path,{method,
        headers:{origin:'https://portal.example.test','content-type':'application/json',cookie,
          'x-vp-auth-client-ip':ip,'x-vp-auth-timestamp':timestamp,'x-vp-auth-signature':signature},
        ...(body===undefined?{}:{body:serialized})}));
    }
    const sendBody=(email,phoneNumber)=>({email,phoneNumber,consent:true,consentVersion:'registration-phone-v1'});
    async function challenge(email,phoneNumber) {
      const response=await request('/registration/phone/send',sendBody(email,phoneNumber));
      equal(response.status,200,'signed registration SMS request');
      const payload=await response.json();
      const rows=await connection.unsafe("SELECT id,identifier,value FROM auth.verification WHERE identifier LIKE 'registration-phone:%' ORDER BY created_at DESC LIMIT 1");
      check(/^h1_[a-f0-9]{64}:0$/.test(rows[0].value),'OTP stored only as HMAC');
      return {...payload,email,phoneNumber,code:sms.at(-1).code,row:rows[0]};
    }
    // Hold a real PostgreSQL row until all three statements are waiting on a
    // database lock. This deterministically exercises READ COMMITTED rechecks,
    // without timing guesses or a fake adapter's single-process behaviour.
    async function lockedRace(table,id,start) {
      check(['rate_limit','verification'].includes(table),'fixed lock target');
      const locker=await control.reserve();
      let pending=[]; let failure;
      try {
        await locker.unsafe('BEGIN');
        await locker.unsafe('SELECT id FROM auth.'+table+' WHERE id=$1 FOR UPDATE',[id]);
        pending=start();
        let blocked=false; let blockedCount=0;
        for(let attempt=0;attempt<100;attempt++) {
          const rows=await control.unsafe("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name='registration-phone-cas' AND wait_event_type='Lock'");
          blockedCount=rows[0].count;
          if(blockedCount>=pending.length){blocked=true;break;}
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        check(blocked,'all concurrent mutations reached the held row: '+id+' ('+blockedCount+'/'+pending.length+')');
      } catch(error){failure=error;}
      finally {await locker.unsafe('COMMIT');locker.release();}
      const results=await Promise.allSettled(pending);
      if(failure)throw failure;
      for(const result of results)if(result.status==='rejected')throw result.reason;
      return results.map(result=>result.value);
    }
    try {
      await adapter.create({model:'rateLimit',data:{id:'cas-budget',key:'cas-budget',count:0,lastRequest:Date.now()+60000},forceAllowId:true});
      const budget=await lockedRace('rate_limit','cas-budget',()=>[0,1,2].map(()=>adapter.incrementOne({model:'rateLimit',
        where:[{field:'key',value:'cas-budget'},{field:'count',operator:'lt',value:1}],increment:{count:1}})));
      equal(budget.filter(Boolean).length,1,'only one budget increment wins');
      equal((await adapter.findOne({model:'rateLimit',where:[{field:'id',value:'cas-budget'}]})).count,1);
      await adapter.create({model:'verification',data:{id:'cas-value',identifier:'cas-value',value:'0',expiresAt:new Date(Date.now()+60000)},forceAllowId:true});
      const cas=await lockedRace('verification','cas-value',()=>[0,1,2].map(()=>adapter.transaction(tx=>tx.incrementOne({model:'verification',
        where:[{field:'id',value:'cas-value'},{field:'value',value:'0'}],increment:{},set:{value:'1'}}))));
      equal(cas.filter(Boolean).length,1,'only one value CAS wins through transaction callback');
      equal((await adapter.findOne({model:'verification',where:[{field:'id',value:'cas-value'}]})).value,'1');

      const identifier='registration-phone:'+'a'.repeat(64);
      const code='123456';
      await adapter.create({model:'verification',data:{id:'otp-attempts',identifier,
        value:'h1_'+otpHash(env.BETTER_AUTH_SECRET,'phone:'+identifier,code)+':0',expiresAt:new Date(Date.now()+60000)},forceAllowId:true});
      const context={context:{adapter}};
      const wrong=await lockedRace('verification','otp-attempts',()=>[0,1,2].map(()=>consumePhoneOTP(env.BETTER_AUTH_SECRET,identifier,'999999',context,true)));
      equal(wrong,[false,false,false]);
      equal(await consumePhoneOTP(env.BETTER_AUTH_SECRET,identifier,code,context,true),false,'three concurrent failures exhaust OTP');
      equal(await adapter.findOne({model:'verification',where:[{field:'id',value:'otp-attempts'}]}),null);

      const flow=await challenge('racing@example.test','+12025550120');
      // Seed shared verify counters so their intentional unique-key creation
      // race does not reject competitors before the OTP row is exercised.
      for(const scope of ['verify-email:'+flow.email,'verify-phone:'+flow.phoneNumber,'verify-flow:'+flow.flowId]) {
        const key=recipientBudgetKey(env.BETTER_AUTH_SECRET,'registration:'+scope);
        await adapter.create({model:'rateLimit',data:{key,count:0,lastRequest:Date.now()+300000}});
      }
      const verified=await lockedRace('verification',flow.row.id,()=>[0,1,2].map(()=>request('/registration/phone/verify',
        {email:flow.email,phoneNumber:flow.phoneNumber,flowId:flow.flowId,code:flow.code})));
      equal(verified.map(response=>response.status).sort(),[200,400,400],'one real verify handler wins');
      const proof=await verified.find(response=>response.status===200).json();
      equal(proof.purpose,'registration'); equal(proof.email,flow.email); equal(proof.phoneNumber,flow.phoneNumber);
      const cookie='__Secure-vp_registration_phone='+proof.proof+'; vp_registration_phone_expected='+flow.phoneNumber;
      const proofRow=(await connection.unsafe("SELECT id FROM auth.verification WHERE identifier LIKE 'registration-proof:%' ORDER BY created_at DESC LIMIT 1"))[0];
      const proofContext={path:'/sign-up/email',request:new Request('https://auth.example.test/api/auth/sign-up/email',{headers:{cookie}}),
        setHeader:()=>{},context:{adapter}};
      const spent=await lockedRace('verification',proofRow.id,()=>[0,1,2].map(async()=>{
        try{await registrationPhoneProof(env.BETTER_AUTH_SECRET,proofContext,flow.email,{configured:true,secureCookie:true,consume:true});return true;}
        catch(error){if(error?.body?.code==='REGISTRATION_PHONE_INVALID')return false;throw error;}
      }));
      equal(spent.filter(Boolean).length,1,'only one registration proof consumer wins');
      equal(await adapter.findOne({model:'verification',where:[{field:'id',value:proofRow.id}]}),null);

      const fresh=await challenge('signup@example.test','+12025550121');
      const proofResponse=await request('/registration/phone/verify',{email:fresh.email,phoneNumber:fresh.phoneNumber,flowId:fresh.flowId,code:fresh.code});
      equal(proofResponse.status,200); const freshProof=await proofResponse.json();
      const freshCookie='__Secure-vp_registration_phone='+freshProof.proof+'; vp_registration_phone_expected='+fresh.phoneNumber;
      const signup=await request('/sign-up/email',{name:'Synthetic Member',email:fresh.email,password:'Synthetic-password-123'},freshCookie);
      equal(signup.status,200,'real signed Hono/Better Auth signup');
      const signupBody=await signup.json(); equal(signupBody.token,null); equal(signupBody.user.emailVerified,false);
      const user=(await connection.unsafe('SELECT phone_number,phone_number_verified,email_verified FROM auth."user" WHERE email=$1',[fresh.email]))[0];
      equal(user,{phone_number:fresh.phoneNumber,phone_number_verified:true,email_verified:false});
      equal((await connection.unsafe('SELECT count(*)::int AS count FROM auth.session'))[0].count,0,'SMS signup never creates session');
      equal(signup.headers.has('set-cookie'),false);

      const off=betterAuth(createAuthOptions({...env,BETTER_AUTH_REGISTRATION_SMS_REQUIRED:'false'},postgresAuthAdapter(db),identity,delivery));
      const offApp=appFor(off); const previousSms=sms.length;
      equal((await request('/registration/phone/send',sendBody('off@example.test','+12025550122'),'',offApp)).status,404);
      equal((await request('/sign-up/email',{name:'Email Member',email:'email-signup@example.test',password:'Synthetic-password-123'},'',offApp)).status,200);
      equal(sms.length,previousSms,'disabled feature cannot send SMS');
      await connection.unsafe('INSERT INTO auth."user"(id,email,email_verified,name) VALUES($1,$2,true,$3)',['email-login','email-login@example.test','Email Login']);
      equal((await request('/email-otp/send-verification-otp',{email:'email-login@example.test',type:'sign-in'},'',offApp)).status,200);
      const emailCode=/\b(\d{6})\b/.exec(emails.at(-1).text);
      check(emailCode,'fake email captured code');
      equal((await request('/sign-in/email-otp',{email:'email-login@example.test',otp:emailCode[1]},'',offApp)).status,200,'email-only login still works');
      equal((await request('/sign-in/phone-number',{phoneNumber:fresh.phoneNumber,password:'Synthetic-password-123'})).status,404);
      equal(providerCalls,0);
      equal((await control.unsafe("SELECT to_regclass('auth.sms_opt_in') AS relation"))[0].relation,null,'optional schema never required');
      console.log(JSON.stringify({syntheticPostgres:'17.11',assertions,deterministicRowLockRaces:5,
        budgetWinners:1,valueCasWinners:1,verifyWinners:1,proofWinners:1,threeFailuresExhaustOtp:true,
        signedHonoSignup:true,emailOnlyLogin:true,network:'none',providerCalls,productionAccess:false}));
    } finally {await Promise.all([connection.end({timeout:2}),control.end({timeout:2})]);}
  `);
  console.log(result);
} finally {
  if (created) docker(['rm', '-f', name]);
}
