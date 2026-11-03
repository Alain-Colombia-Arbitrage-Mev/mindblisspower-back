// Explicit disposable rehearsal only. No source CSV, .env, host/cloud DSN,
// provider or published port. The library runs against a restricted fixture.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv.slice(2).join(' ') !== '--synthetic-docker') throw new Error('Requires --synthetic-docker');
const name = `blacklist-email-pg-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const source = fileURLToPath(new URL('./', import.meta.url));
const env = { ...process.env, POSTGRES_PASSWORD: password,
  BLACKLIST_SYNTHETIC_URL: `postgres://blacklist_fixture:${password}@127.0.0.1:5432/blacklist_email_synthetic` };
function docker(args, input) {
  const result = spawnSync('docker', args, { env, input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 180000, windowsHide: true });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Synthetic Docker failed').replaceAll(password, '[redacted]'));
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}
let created = false;
try {
  docker(['run', '--pull=never', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=blacklist_email_synthetic',
    'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore', windowsHide: true }).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Synthetic PostgreSQL not ready');
  docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'blacklist_email_synthetic', '-v', 'ON_ERROR_STOP=1'], `
    CREATE ROLE blacklist_fixture LOGIN PASSWORD '${password}';
    CREATE SCHEMA mlm; CREATE SCHEMA auth; CREATE SCHEMA identity; CREATE SCHEMA payments;
    CREATE TABLE mlm.blacklist(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,fullname text,username text,birthdate date,
      email text,phone text,email_norm text,phone_last10 text,name_norm text,motive text,source text NOT NULL,created_at timestamptz DEFAULT now());
    CREATE TABLE mlm.person(id bigint PRIMARY KEY,email text,status text,blacklisted boolean NOT NULL,alias text,user_id text,
      first_name text,last_name text,phone_number text,birthday date,updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,person_id bigint,status text,parent_id bigint,position text,current_rank_id int,pv numeric(20,2),
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE auth."user"(id text PRIMARY KEY,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,name text,image text,
      phone_number text,phone_number_verified boolean NOT NULL DEFAULT false,contact_phone_e164 text,contact_whatsapp_e164 text,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE auth.account(id text,user_id text,password text); CREATE TABLE auth.session(id text,user_id text,token text);
    CREATE TABLE identity.auth_binding(subject text,person_id bigint); CREATE TABLE payments.synthetic_ledger(id bigint,amount numeric(20,2));
    INSERT INTO mlm.person(id,email,status,blacklisted,alias,user_id,first_name,last_name,phone_number,birthday)
      SELECT n,CASE WHEN n%2=0 THEN ' BLOCKED'||lpad(n::text,3,'0')||'@EXAMPLE.TEST ' ELSE 'blocked'||lpad(n::text,3,'0')||'@example.test' END,
        (ARRAY['active','pending','suspended','banned','deleted'])[n%5+1],n%2=0 OR n>44,'synthetic-'||n,'subject-'||n,
        'Shared','Informational name','12125550100','1990-01-01'::date FROM generate_series(1,60) n;
    INSERT INTO mlm.affiliate(id,person_id,status,parent_id,position,current_rank_id,pv) SELECT n,n,(ARRAY['active','suspended','banned','deleted'])[n%4+1],CASE WHEN n>1 THEN n/2 END,
      CASE WHEN n>1 THEN CASE WHEN n%2=0 THEN 'L' ELSE 'R' END END,n%8,n*100 FROM generate_series(1,60) n;
    INSERT INTO auth."user"(id,email,email_verified,name) SELECT 'subject-'||n,'blocked'||lpad(n::text,3,'0')||'@example.test',n%2=0,'Synthetic member' FROM generate_series(1,60) n;
    INSERT INTO auth.account VALUES('synthetic-account','subject-1','synthetic-password-not-real');
    INSERT INTO auth.session VALUES('synthetic-session','subject-1','synthetic-token-not-real');
    INSERT INTO identity.auth_binding SELECT 'subject-'||n,n FROM generate_series(1,60) n;
    INSERT INTO payments.synthetic_ledger VALUES(1,999.99);
    INSERT INTO mlm.blacklist(fullname,username,email,email_norm,phone,phone_last10,name_norm,birthdate,motive,source) VALUES
      ('Old email','old-email','obsolete@example.test','obsolete@example.test',NULL,NULL,NULL,NULL,'Old reason','old'),
      ('Shared Informational name','old-name',NULL,NULL,'12125550100','2125550100','shared informational name','1990-01-01','Old reason','old'),
      ('Old broad','old-broad',NULL,NULL,'19995550100','9995550100','another',NULL,'Old reason','old');
    GRANT USAGE ON SCHEMA mlm,auth,identity,payments TO blacklist_fixture;
    GRANT SELECT ON ALL TABLES IN SCHEMA mlm,auth,identity,payments TO blacklist_fixture;
    GRANT INSERT,DELETE ON mlm.blacklist TO blacklist_fixture;
    GRANT UPDATE(blacklisted) ON mlm.person TO blacklist_fixture;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA mlm TO blacklist_fixture;
    CREATE ROLE reactivation_fixture NOLOGIN INHERIT;
    GRANT blacklist_fixture TO reactivation_fixture;
    GRANT UPDATE(status,updated_at) ON mlm.person,mlm.affiliate TO reactivation_fixture;
    GRANT INSERT(id,email,email_verified,name,image,phone_number,phone_number_verified,contact_phone_e164,contact_whatsapp_e164,created_at,updated_at)
      ON auth."user" TO reactivation_fixture;
  `);
  const output = docker(['run', '--pull=never', '--rm', '-i', '--network', `container:${name}`, '--read-only', '--tmpfs', '/tmp',
    '--mount', `type=bind,source=${source},target=/app/scripts,readonly`, '-e', 'BLACKLIST_SYNTHETIC_URL',
    '--entrypoint', 'bun', 'mindbliss/api-password-recovery-test-20261102:local', '--no-env-file', '-'], String.raw`
    import assert from 'node:assert/strict';
    import {createHash,randomUUID} from 'node:crypto';
    import {z} from 'zod';
    import postgres from 'postgres';
    import {parseBlacklistCsv,reconcileBlacklist} from './scripts/blacklist-email-policy.mjs';
    const sql=postgres(process.env.BLACKLIST_SYNTHETIC_URL,{max:1,prepare:false,onnotice:()=>{}});
    const ownerURL=new URL(process.env.BLACKLIST_SYNTHETIC_URL);ownerURL.username='postgres';
    const owner=postgres(ownerURL.href,{max:1,prepare:false,onnotice:()=>{}});
    let assertions=0,backups=0;
    const check=(actual,expected)=>{assert.deepEqual(actual,expected);assertions++;};
    const rejects=async(fn,pattern)=>{await assert.rejects(fn,pattern);assertions++;};
    const invalid=(bytes,pattern)=>{assert.throws(()=>parseBlacklistCsv(bytes),pattern);assertions++;};
    const encode=csv=>Buffer.from(csv,'utf8');
    globalThis.fetch=async()=>{throw new Error('External providers forbidden');};
    const csv='Nombre,username,email\r\n'+Array.from({length:44},(_,index)=>{
      const n=String(index+1).padStart(3,'0');
      return (index===0?'"Synthetic, ""Quoted"" Member"':'Synthetic member '+n)+',member-'+n+', BLOCKED'+n+'@EXAMPLE.TEST ';
    }).join('\r\n')+'\r\n';
    const parsed=parseBlacklistCsv(encode('\ufeff'+csv));
    const tables=['mlm.affiliate','auth."user"','auth.account','auth.session','identity.auth_binding','payments.synthetic_ledger'];
    const stable=async tx=>{
      const state={people:await tx.unsafe('SELECT to_jsonb(p)-\'blacklisted\' AS row FROM mlm.person p ORDER BY id')};
      for(const table of tables)state[table]=await tx.unsafe('SELECT to_jsonb(t) AS row FROM '+table+' t ORDER BY to_jsonb(t)::text');
      return createHash('sha256').update(JSON.stringify(state)).digest('hex');
    };
    const snapshot=async tx=>({business:await stable(tx),blacklist:await tx.unsafe('SELECT to_jsonb(b) AS row FROM mlm.blacklist b ORDER BY id'),
      flags:await tx.unsafe('SELECT id,blacklisted FROM mlm.person ORDER BY id')});
    const reviewed=async(fn)=>owner.begin(async tx=>{
      await tx.unsafe('LOCK TABLE mlm.blacklist,mlm.person IN SHARE ROW EXCLUSIVE MODE');
      const backup=await snapshot(tx);backups++;
      // Production's caller persists/verifies its external backup. This
      // synthetic rehearsal checks only its disposable in-memory snapshot.
      assert.ok(backup.business);assertions++;
      // Locks/backup belong to the caller; the library itself has only the
      // two reviewed DML capabilities, not general person UPDATE authority.
      await tx.unsafe('SET LOCAL ROLE blacklist_fixture');
      return fn(tx,backup);
    });
    try {
      check(parsed.rows.length,44);check(parsed.emails.length,44);
      check(parsed.rows[0].fullname,'Synthetic, "Quoted" Member');
      check(parsed.emails,[...parsed.emails].sort());
      check(parsed.sha256,createHash('sha256').update(encode('\ufeff'+csv)).digest('hex'));
      check(Object.isFrozen(parsed)&&Object.isFrozen(parsed.rows)&&Object.isFrozen(parsed.rows[0]),true);
      for(const bad of [Buffer.alloc(0),new Uint8Array([0xc3,0x28]),encode('Nombre,username,email\nA,a,a@example.test\0'),
        encode('Nombre,username,email\nA,a,'),encode('Nombre,username,email\nA,a,not-email'),
        encode('Nombre,username,email\nA,a,a@example.test,extra'),encode('Nombre,email,username\nA,a@example.test,a'),
        encode('Nombre,username,email\nA,a,a@example.test\nB,b, A@EXAMPLE.TEST '),
        encode('Nombre,username,email\n"A"x,a,a@example.test'),encode('Nombre,username,email\n"A,a,a@example.test'),
        encode('Nombre,username,email\nA,a,a@example.test\n\n')])invalid(bad,/CSV/);
      await rejects(()=>reconcileBlacklist(sql,parsed,'synthetic-reviewed'),/TRANSACTION_REQUIRED/);
      const initial=await snapshot(sql);check(initial.flags.filter(row=>row.blacklisted).length,38);
      const result=await reviewed(async(tx,backup)=>{
        const result=await reconcileBlacklist(tx,parsed,'synthetic-reviewed');
        check(await stable(tx),backup.business);
        const rows=await tx.unsafe('SELECT email,email_norm,fullname,username,phone,phone_last10,name_norm,birthdate,motive,source FROM mlm.blacklist ORDER BY email_norm');
        check(rows.map(row=>row.email_norm),parsed.emails);
        check(rows.every(row=>row.email===row.email_norm&&row.source==='synthetic-reviewed'&&row.phone===null&&row.phone_last10===null&&row.name_norm===null&&row.birthdate===null&&row.motive===null),true);
        check(rows.find(row=>row.email_norm===parsed.rows[0].email).fullname,parsed.rows[0].fullname);
        return result;
      });
      check(result,{source:'synthetic-reviewed',sha256:parsed.sha256,deleted:3,inserted:44,changed_flags:38,flags_set:22,flags_cleared:16,blacklisted_before:38,blacklisted_after:44});
      check(await stable(sql),initial.business);
      const flags=await sql.unsafe('SELECT id,blacklisted FROM mlm.person ORDER BY id');
      check(flags.every(row=>row.blacklisted===(Number(row.id)<=44)),true);
      const firstState=await snapshot(sql);
      await rejects(()=>reviewed(async tx=>{await reconcileBlacklist(tx,parsed,'synthetic-must-rollback');throw new Error('SYNTHETIC_FORCED_ROLLBACK');}),/SYNTHETIC_FORCED_ROLLBACK/);
      check(await snapshot(sql),firstState);
      const repeat=await reviewed(tx=>reconcileBlacklist(tx,parsed,'synthetic-reviewed'));
      check(repeat.changed_flags,0);check(repeat.flags_set,0);check(repeat.flags_cleared,0);
      check(repeat.deleted,44);check(repeat.inserted,44);check(repeat.blacklisted_after,44);
      check(await stable(sql),initial.business);
      const afterRepeat=await snapshot(sql);
      await rejects(()=>reviewed(tx=>reconcileBlacklist(tx,{...parsed,emails:parsed.emails.slice(1)},'synthetic-invalid')),/EMAIL_SET_MISMATCH/);
      check(await snapshot(sql),afterRepeat);
      await rejects(()=>reviewed(tx=>reconcileBlacklist(tx,parsed,'invalid\nsource')),/SOURCE_INVALID/);
      check(await snapshot(sql),afterRepeat);
      // Separate owner-authorized reactivation: 3145 people, 3098 unique valid
      // emails, 30 shared-email groups and 17 malformed addresses. No auth
      // subject is inferred from a shared address; all bindings remain manual.
      await owner.unsafe(__SQL__INSERT INTO mlm.person(id,email,status,blacklisted,alias,user_id,first_name,last_name,phone_number,birthday)
        SELECT 1000+n,CASE WHEN n<=3098 THEN 'restored'||lpad(n::text,4,'0')||'@example.test'
          WHEN n<=3128 THEN 'restored'||lpad((n-3098)::text,4,'0')||'@example.test' ELSE 'malformed-'||n END,
          'suspended',true,'restore-'||n,NULL,'Synthetic','Restored','12125550100','1990-01-01'::date FROM generate_series(1,3145) n__SQL__);
      await owner.unsafe(__SQL__INSERT INTO mlm.affiliate(id,person_id,status,parent_id,position,current_rank_id,pv)
        SELECT id,id,'deleted',id/2,CASE WHEN id%2=0 THEN 'L' ELSE 'R' END,id%8,id*101 FROM mlm.person WHERE id>1000__SQL__);
      const cohort=await owner.unsafe('SELECT id::text,lower(btrim(email)) AS email FROM mlm.person WHERE id>1000 ORDER BY id');
      const ids=cohort.map(row=>row.id),affIds=[...ids];
      const distinct=[...new Set(cohort.map(row=>row.email))].sort();
      const validEmail=email=>z.string().max(254).pipe(z.email()).safeParse(email).success;
      const pendingAuth=distinct.filter(validEmail).map(email=>({id:randomUUID(),email,name:'Cuenta pendiente'}));
      const created=pendingAuth.map(row=>row.id);
      check(cohort.length,3145);check(pendingAuth.length,3098);check(distinct.filter(email=>!validEmail(email)).length,17);
      check(distinct.filter(email=>cohort.filter(row=>row.email===email).length>1).length,30);
      const preserved=async tx=>({
        people:await tx.unsafe('SELECT to_jsonb(p)-\'blacklisted\'-\'status\'-\'updated_at\' AS row FROM mlm.person p ORDER BY id'),
        affiliates:await tx.unsafe('SELECT to_jsonb(a)-\'status\'-\'updated_at\' AS row FROM mlm.affiliate a ORDER BY id'),
        credentials:await tx.unsafe('SELECT to_jsonb(a) AS row FROM auth.account a ORDER BY id'),
        sessions:await tx.unsafe('SELECT to_jsonb(s) AS row FROM auth.session s ORDER BY id'),
        bindings:await tx.unsafe('SELECT to_jsonb(b) AS row FROM identity.auth_binding b ORDER BY subject'),
        finance:await tx.unsafe('SELECT to_jsonb(l) AS row FROM payments.synthetic_ledger l ORDER BY id'),
        existingAuth:await tx.unsafe('SELECT to_jsonb(u) AS row FROM auth."user" u WHERE id<>ALL($1::text[]) ORDER BY id',[created]),
        otherStatuses:await tx.unsafe('SELECT id,status FROM mlm.person WHERE id<=1000 ORDER BY id'),
        otherAffStatuses:await tx.unsafe('SELECT id,status FROM mlm.affiliate WHERE id<=1000 ORDER BY id'),
      });
      const beforeReactivation=await preserved(owner),rollbackSnapshot=await snapshot(owner);
      const reactivate=async forceRollback=>owner.begin(async tx=>{
        await tx.unsafe('LOCK TABLE mlm.blacklist,mlm.person,mlm.affiliate,auth."user" IN SHARE ROW EXCLUSIVE MODE');
        check((await snapshot(tx)).business,rollbackSnapshot.business);backups++;
        await tx.unsafe('SET LOCAL ROLE reactivation_fixture');
        const counts=await reconcileBlacklist(tx,parsed,'synthetic-reviewed');
        check(counts.flags_cleared,3145);check(counts.blacklisted_after,44);
        const changedPeople=await tx__SQL__UPDATE mlm.person SET status='active',updated_at=now() WHERE id=ANY(__VALUE__{ids}::bigint[]) AND status='suspended' AND blacklisted=false RETURNING id__SQL__;
        const changedAffiliates=await tx__SQL__UPDATE mlm.affiliate SET status='active',updated_at=now() WHERE id=ANY(__VALUE__{affIds}::bigint[]) AND person_id=ANY(__VALUE__{ids}::bigint[]) AND status='deleted' RETURNING id__SQL__;
        check(changedPeople.length,3145);check(changedAffiliates.length,3145);
        // Exact bulk insertion shape used by the reviewed root operator.
        const insertedAuth=await tx__SQL__INSERT INTO auth."user"(id,email,email_verified,name,image,phone_number,phone_number_verified,contact_phone_e164,contact_whatsapp_e164,created_at,updated_at) SELECT x.id,x.email,false,x.name,NULL,NULL,false,NULL,NULL,now(),now() FROM jsonb_to_recordset(__VALUE__{tx.json(pendingAuth)}::jsonb) AS x(id text,email text,name text) RETURNING id__SQL__;
        check(insertedAuth.length,3098);
        check(await preserved(tx),beforeReactivation);
        const accesses=await tx.unsafe('SELECT email,email_verified,phone_number,phone_number_verified,contact_phone_e164,contact_whatsapp_e164 FROM auth."user" WHERE id=ANY($1::text[])',[created]);
        check(accesses.length,3098);
        check(accesses.every(row=>row.email_verified===false&&row.phone_number===null&&row.phone_number_verified===false&&row.contact_phone_e164===null&&row.contact_whatsapp_e164===null),true);
        const [authority]=await tx.unsafe(__SQL__SELECT
          (SELECT count(*)::int FROM identity.auth_binding WHERE subject=ANY($1::text[])) AS bindings,
          (SELECT count(*)::int FROM auth.account WHERE user_id=ANY($1::text[])) AS credentials,
          (SELECT count(*)::int FROM auth.session WHERE user_id=ANY($1::text[])) AS sessions__SQL__,[created]);
        check(authority,{bindings:0,credentials:0,sessions:0});
        check((await tx.unsafe("SELECT count(*)::int AS n FROM mlm.person WHERE id>1000 AND status='active' AND NOT blacklisted"))[0].n,3145);
        check((await tx.unsafe("SELECT count(*)::int AS n FROM mlm.affiliate WHERE id>1000 AND status='active'"))[0].n,3145);
        if(forceRollback)throw new Error('SYNTHETIC_REACTIVATION_ROLLBACK');
      });
      await rejects(()=>reactivate(true),/SYNTHETIC_REACTIVATION_ROLLBACK/);
      check(await snapshot(owner),rollbackSnapshot);
      await reactivate(false);
      check(await preserved(owner),beforeReactivation);
      console.log(JSON.stringify({syntheticPostgres:'17.11',bun:Bun.version,assertions,backupCallbacks:backups,csvEmails:44,personFlags:44,
        exactEmailOnly:true,suspensionsAndAffiliatesPreserved:true,authTreeFinancialFactsUnchanged:true,rollback:true,semanticIdempotency:true,
        authorizedReactivatedPeople:3145,authorizedReactivatedAffiliates:3145,pendingAuthUsers:3098,invalidEmailsSkipped:17,sharedEmailsManualBinding:30,
        emailVerified:false,newBindings:0,newCredentials:0,newSessions:0,reactivationRollback:true,
        restrictedRole:true,network:'none',publishedPorts:0,messagesSent:0,productionAccess:false}));
    }finally{await Promise.all([sql.end({timeout:2}),owner.end({timeout:2})]);}
  `.replaceAll('__SQL__',String.fromCharCode(96)).replaceAll('__VALUE__','$'));
  console.log(output);
} finally { if (created) docker(['rm', '-f', name]); }
