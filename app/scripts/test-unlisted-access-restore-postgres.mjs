// Disposable owner-authorized restoration rehearsal. No source CSV, .env,
// real DSN, provider request, message or production access is accepted here.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv.slice(2).join(' ') !== '--synthetic-docker') throw new Error('Requires --synthetic-docker');
const name = 'unlisted-restore-pg-' + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex');
const source = fileURLToPath(new URL('./', import.meta.url));
const env = { ...process.env, POSTGRES_PASSWORD: password,
  UNLISTED_RESTORE_SYNTHETIC_URL: 'postgres://postgres:' + password + '@127.0.0.1:5432/unlisted_restore_synthetic' };
function docker(args, input) {
  const result = spawnSync('docker', args, { env, input, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 180000 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Synthetic Docker failed').replaceAll(password, '[redacted]'));
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}
let created = false;
try {
  docker(['run', '--pull=never', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=unlisted_restore_synthetic',
    'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore', windowsHide: true }).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Synthetic PostgreSQL not ready');
  docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'unlisted_restore_synthetic', '-v', 'ON_ERROR_STOP=1'], `
    CREATE SCHEMA mlm; CREATE SCHEMA auth; CREATE SCHEMA identity; CREATE SCHEMA payments;
    CREATE TABLE mlm.person(id bigint PRIMARY KEY,public_id uuid NOT NULL,email text NOT NULL,status text NOT NULL,blacklisted boolean NOT NULL,
      user_id text,alias text,first_name text,last_name text,phone_number text,birthday date,kyc_status text,balance numeric(20,2),
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,person_id bigint UNIQUE,status text NOT NULL,parent_id bigint,sponsor_id bigint,
      position text,path text,depth int,current_rank_id int,left_pv numeric(20,2),right_pv numeric(20,2),
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE mlm.blacklist(id bigint PRIMARY KEY,email text,email_norm text,fullname text,username text,phone text,phone_last10 text,name_norm text,birthdate date,source text);
    CREATE TABLE auth."user"(id text PRIMARY KEY,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,name text,image text,
      phone_number text,phone_number_verified boolean NOT NULL DEFAULT false,contact_phone_e164 text,contact_whatsapp_e164 text,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE auth.account(id text PRIMARY KEY,user_id text,password text);
    CREATE TABLE auth.session(id text PRIMARY KEY,user_id text,token text);
    CREATE TABLE auth.verification(id text PRIMARY KEY,identifier text,value text);
    CREATE TABLE identity.auth_binding(subject text PRIMARY KEY,person_id bigint UNIQUE,provider text);
    CREATE TABLE payments.ledger(id bigint PRIMARY KEY,person_id bigint,amount numeric(20,2),status text,reference text);
    CREATE TABLE payments.membership(id bigint PRIMARY KEY,person_id bigint,principal numeric(20,2),pv numeric(20,2),status text);
    INSERT INTO mlm.person(id,public_id,email,status,blacklisted,user_id,alias,first_name,last_name,phone_number,birthday,kyc_status,balance)
      SELECT n,md5('listed-'||n)::uuid,'listed'||lpad(n::text,3,'0')||'@example.test','banned',true,'listed-subject-'||n,
        'listed-'||n,'Listed','Synthetic','12125550100','1990-01-01','approved',n*100 FROM generate_series(1,44)n;
    INSERT INTO mlm.affiliate(id,person_id,status,parent_id,sponsor_id,position,path,depth,current_rank_id,left_pv,right_pv)
      SELECT id,id,'banned',id/2,1,CASE WHEN id%2=0 THEN 'L' ELSE 'R' END,'1.'||id,2,id%8,id*99,id*98 FROM mlm.person;
    INSERT INTO mlm.blacklist SELECT id,email,lower(btrim(email)),'Listed Synthetic',alias,NULL,NULL,NULL,NULL,'synthetic-list' FROM mlm.person;
    INSERT INTO auth."user"(id,email,email_verified,name)
      SELECT user_id,email,id%2=0,'Existing listed access' FROM mlm.person;
    INSERT INTO identity.auth_binding SELECT user_id,id,'better_auth' FROM mlm.person;
    INSERT INTO auth."user"(id,email,email_verified,name) VALUES('existing-admin','admin@example.test',true,'Existing Administrator');
    INSERT INTO auth.account VALUES('protected-credential','existing-admin','synthetic-password-only');
    INSERT INTO auth.session VALUES('protected-session','existing-admin','synthetic-session-only');
    INSERT INTO auth.verification VALUES('protected-verification','synthetic-unrelated','synthetic-hash-only');
    INSERT INTO mlm.person(id,public_id,email,status,blacklisted,alias,first_name,last_name,phone_number,birthday,kyc_status,balance)
      SELECT 1000+n,md5('unlisted-'||n)::uuid,'restored'||lpad(n::text,5,'0')||'@example.test',
        CASE WHEN n<=3371 THEN 'pending' WHEN n<=5256 THEN 'active' WHEN n<=7402 THEN 'banned' ELSE 'suspended' END,
        false,'unlisted-'||n,'Unlisted','Synthetic','12125550100','1990-01-01','not_started',n*123 FROM generate_series(1,7942)n;
    INSERT INTO mlm.affiliate(id,person_id,status,parent_id,sponsor_id,position,path,depth,current_rank_id,left_pv,right_pv)
      SELECT id,id,CASE WHEN id-1000 BETWEEN 5257 AND 6875 THEN 'banned' WHEN id-1000=7403 THEN 'active' ELSE 'suspended' END,
        id/2,1,CASE WHEN id%2=0 THEN 'L' ELSE 'R' END,'1.'||id,3,id%8,id*77,id*76 FROM mlm.person
      WHERE id>1000 AND NOT(id-1000 BETWEEN 7404 AND 7440);
    INSERT INTO mlm.person(id,public_id,email,status,blacklisted,alias,first_name,last_name,phone_number,birthday,kyc_status,balance)
      SELECT 10000+n,md5('additional-'||n)::uuid,
        CASE WHEN n<=2261 THEN 'additional'||lpad(n::text,5,'0')||'@example.test' ELSE 'invalid-email-'||n END,
        'pending',false,'additional-'||n,'Additional','Synthetic','12125550100','1990-01-01','not_started',n*10 FROM generate_series(1,2737)n;
    INSERT INTO payments.ledger VALUES(1,1,991.25,'posted','protected-ledger'),(2,1001,99.50,'pending','protected-unlisted-ledger');
    INSERT INTO payments.membership VALUES(1,1,100.00,99.00,'active'),(2,1001,500.00,495.00,'active');
    CREATE ROLE unlisted_restore_fixture NOLOGIN;
    GRANT USAGE ON SCHEMA mlm,auth,identity,payments TO unlisted_restore_fixture;
    GRANT SELECT ON ALL TABLES IN SCHEMA mlm,auth,identity,payments TO unlisted_restore_fixture;
    GRANT UPDATE(status,updated_at) ON mlm.person,mlm.affiliate TO unlisted_restore_fixture;
    GRANT INSERT(id,email,email_verified,name,image,phone_number,phone_number_verified,contact_phone_e164,contact_whatsapp_e164,created_at,updated_at)
      ON auth."user" TO unlisted_restore_fixture;
  `);
  const output = docker(['run', '--pull=never', '--rm', '-i', '--network', 'container:' + name, '--read-only', '--tmpfs', '/tmp',
    '--mount', 'type=bind,source=' + source + ',target=/app/scripts,readonly', '-e', 'UNLISTED_RESTORE_SYNTHETIC_URL',
    '--entrypoint', 'bun', 'mindbliss/api-password-recovery-test-20261102:local', '--no-env-file', '-'], String.raw`
    import assert from 'node:assert/strict';
    import {createHash,randomUUID} from 'node:crypto';
    import postgres from 'postgres';
    import {z} from 'zod';
    const target=new URL(process.env.UNLISTED_RESTORE_SYNTHETIC_URL);
    assert.equal(target.hostname,'127.0.0.1');assert.equal(target.pathname,'/unlisted_restore_synthetic');
    const sql=postgres(target.href,{max:1,prepare:false,onnotice:()=>{}});
    let assertions=0,backups=0;
    const check=(a,b)=>{assert.deepEqual(a,b);assertions++;};
    const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    globalThis.fetch=async()=>{throw new Error('External requests forbidden');};
    const allTables=['mlm.person','mlm.affiliate','mlm.blacklist','auth."user"','auth.account','auth.session','auth.verification','identity.auth_binding','payments.ledger','payments.membership'];
    const allState=async tx=>{const result={};for(const table of allTables)result[table]=await tx.unsafe('SELECT to_jsonb(t) AS row FROM '+table+' t ORDER BY to_jsonb(t)::text');return digest(result);};
    try{
      const cohort=await sql.unsafe('SELECT id::text,email,status FROM mlm.person WHERE id BETWEEN 1001 AND 8942 ORDER BY id');
      const ids=cohort.map(row=>row.id);
      const affiliates=await sql.unsafe('SELECT id::text FROM mlm.affiliate WHERE person_id=ANY($1::bigint[]) ORDER BY id',[ids]);
      const affIds=affiliates.map(row=>row.id);
      check(cohort.length,7942);check(affiliates.length,7905);
      check(cohort.filter(row=>row.status==='pending').length,3371);
      check(cohort.filter(row=>row.status==='active').length,1885);
      check(cohort.filter(row=>['banned','suspended'].includes(row.status)).length,2686);
      const [matrix]=await sql.unsafe(__SQL__SELECT count(*) FILTER(WHERE a.status IN('banned','suspended'))::int AS restricted,
        count(*) FILTER(WHERE a.status='active')::int AS active FROM mlm.affiliate a WHERE person_id=ANY($1::bigint[])__SQL__,[ids]);
      check(matrix,{restricted:7904,active:1});
      const emails=(await sql.unsafe("SELECT DISTINCT lower(btrim(email)) AS email FROM mlm.person WHERE NOT blacklisted AND user_id IS NULL ORDER BY email")).map(row=>row.email);
      const validEmail=email=>z.string().max(254).pipe(z.email()).safeParse(email).success;
      const pendingAuth=emails.filter(validEmail).map(email=>({id:randomUUID(),email,name:'Cuenta pendiente'}));
      const created=pendingAuth.map(row=>row.id);
      check(pendingAuth.length,10203);check(emails.filter(email=>!validEmail(email)).length,476);
      const listedState=async tx=>digest({
        people:await tx.unsafe('SELECT to_jsonb(p) AS row FROM mlm.person p WHERE id<=44 ORDER BY id'),
        affiliates:await tx.unsafe('SELECT to_jsonb(a) AS row FROM mlm.affiliate a WHERE person_id<=44 ORDER BY id'),
        blacklist:await tx.unsafe('SELECT to_jsonb(b) AS row FROM mlm.blacklist b ORDER BY id'),
      });
      const invariants=async tx=>{
        const state={
          people:await tx.unsafe('SELECT to_jsonb(p)-\'status\'-\'updated_at\' AS row FROM mlm.person p ORDER BY id'),
          affiliates:await tx.unsafe('SELECT to_jsonb(a)-\'status\'-\'updated_at\' AS row FROM mlm.affiliate a ORDER BY id'),
          existingAuth:await tx.unsafe('SELECT to_jsonb(u) AS row FROM auth."user" u WHERE id<>ALL($1::text[]) ORDER BY id',[created]),
          otherPeopleStatus:await tx.unsafe('SELECT id,status FROM mlm.person WHERE NOT(id=ANY($1::bigint[])) ORDER BY id',[ids]),
        };
        for(const table of allTables.slice(4))state[table]=await tx.unsafe('SELECT to_jsonb(t) AS row FROM '+table+' t ORDER BY to_jsonb(t)::text');
        return digest(state);
      };
      const baseline=await allState(sql),facts=await invariants(sql),listed=await listedState(sql);
      const restore=forceRollback=>sql.begin(async tx=>{
        await tx.unsafe('LOCK TABLE mlm.person,mlm.affiliate,auth."user" IN SHARE ROW EXCLUSIVE MODE');
        await tx.unsafe('LOCK TABLE mlm.blacklist,identity.auth_binding IN SHARE MODE');
        check(await allState(tx),baseline);backups++;
        await tx.unsafe('SET LOCAL ROLE unlisted_restore_fixture');
        const changedPeople=await tx__SQL__UPDATE mlm.person SET status='active',updated_at=now()
          WHERE id=ANY(__VALUE__{ids}::bigint[]) AND status IN('banned','suspended') AND blacklisted=false RETURNING id__SQL__;
        const changedAffiliates=await tx__SQL__UPDATE mlm.affiliate SET status='active',updated_at=now()
          WHERE id=ANY(__VALUE__{affIds}::bigint[]) AND person_id=ANY(__VALUE__{ids}::bigint[]) AND status IN('banned','suspended','deleted') RETURNING id__SQL__;
        const insertedAuth=await tx__SQL__INSERT INTO auth."user"(id,email,email_verified,name,image,phone_number,phone_number_verified,contact_phone_e164,contact_whatsapp_e164,created_at,updated_at)
          SELECT x.id,x.email,false,x.name,NULL,NULL,false,NULL,NULL,now(),now() FROM jsonb_to_recordset(__VALUE__{tx.json(pendingAuth)}::jsonb) AS x(id text,email text,name text) RETURNING id__SQL__;
        check(changedPeople.length,2686);check(changedAffiliates.length,7904);check(insertedAuth.length,10203);
        check(await invariants(tx),facts);check(await listedState(tx),listed);
        const [states]=await tx.unsafe(__SQL__SELECT count(*) FILTER(WHERE status='pending')::int AS pending,
          count(*) FILTER(WHERE status='active')::int AS active,count(*) FILTER(WHERE status IN('banned','suspended','deleted'))::int AS restricted
          FROM mlm.person WHERE id=ANY($1::bigint[])__SQL__,[ids]);
        check(states,{pending:3371,active:4571,restricted:0});
        check((await tx.unsafe("SELECT count(*)::int AS n FROM mlm.affiliate WHERE person_id=ANY($1::bigint[]) AND status='active'",[ids]))[0].n,7905);
        const accesses=await tx.unsafe('SELECT email,email_verified,phone_number,phone_number_verified,contact_phone_e164,contact_whatsapp_e164 FROM auth."user" WHERE id=ANY($1::text[])',[created]);
        check(accesses.length,10203);
        check(accesses.every(row=>validEmail(row.email)&&row.email_verified===false&&row.phone_number===null&&row.phone_number_verified===false&&row.contact_phone_e164===null&&row.contact_whatsapp_e164===null),true);
        const [authority]=await tx.unsafe(__SQL__SELECT
          (SELECT count(*)::int FROM auth.account WHERE user_id=ANY($1::text[])) AS credentials,
          (SELECT count(*)::int FROM auth.session WHERE user_id=ANY($1::text[])) AS sessions,
          (SELECT count(*)::int FROM identity.auth_binding WHERE subject=ANY($1::text[])) AS bindings__SQL__,[created]);
        check(authority,{credentials:0,sessions:0,bindings:0});
        check((await tx.unsafe('SELECT count(*)::int AS n FROM mlm.person WHERE blacklisted'))[0].n,44);
        if(forceRollback)throw new Error('SYNTHETIC_RESTORE_ROLLBACK');
      });
      await assert.rejects(()=>restore(true),/SYNTHETIC_RESTORE_ROLLBACK/);assertions++;
      check(await allState(sql),baseline);
      await restore(false);
      check(await invariants(sql),facts);check(await listedState(sql),listed);
      console.log(JSON.stringify({syntheticPostgres:'17.11',bun:Bun.version,assertions,backupCallbacks:backups,unlistedPeople:7942,
        changedPeople:2686,pendingPreserved:3371,changedAffiliates:7904,pendingAuthUsers:10203,invalidEmailsSkipped:476,
        listed44Unchanged:true,nonStatusFieldsPublicIdsPositionsPvFinancialsUnchanged:true,emailVerified:false,newCredentials:0,newSessions:0,newBindings:0,
        rollback:true,restrictedRole:true,messagesSent:0,providerCalls:0,network:'none',publishedPorts:0,productionAccess:false}));
    }finally{await sql.end({timeout:2});}
  `.replaceAll('__SQL__',String.fromCharCode(96)).replaceAll('__VALUE__','$'));
  console.log(output);
} finally { if (created) docker(['rm', '-f', name]); }
