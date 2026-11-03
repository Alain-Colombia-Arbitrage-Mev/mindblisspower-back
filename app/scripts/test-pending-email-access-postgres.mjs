// Explicit ephemeral rehearsal; never accepts a cloud/host database URL.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
if (process.argv.slice(2).join(' ') !== '--synthetic-docker') throw new Error('Requires --synthetic-docker');
const name = `pending-access-pg-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const source = fileURLToPath(new URL('./', import.meta.url));
const env = { ...process.env, POSTGRES_PASSWORD: password,
  PENDING_ACCESS_SYNTHETIC_URL: `postgres://postgres:${password}@127.0.0.1:5432/pending_access_synthetic?sslmode=disable` };
function docker(args, input) {
  const result = spawnSync('docker', args, { env, input, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Synthetic Docker failed').replaceAll(password, '[redacted]'));
  return result.stdout.trim();
}
let created = false;
try {
  docker(['run', '--pull=never', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=pending_access_synthetic',
    'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready);
  docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'pending_access_synthetic', '-v', 'ON_ERROR_STOP=1'], `
    CREATE SCHEMA auth; CREATE SCHEMA mlm; CREATE SCHEMA identity;
    CREATE TABLE auth."user"(id text PRIMARY KEY,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,name text,image text,
      phone_number text,phone_number_verified boolean NOT NULL DEFAULT false,contact_phone_e164 text,contact_whatsapp_e164 text,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE auth.account(id text,user_id text); CREATE TABLE auth.session(id text,user_id text);
    CREATE TABLE identity.auth_binding(subject text,person_id bigint);
    CREATE TABLE mlm.person(id bigint PRIMARY KEY,email text,status text,user_id text,blacklisted boolean,
      phone_number text,first_name text,last_name text,birthday date);
    CREATE TABLE mlm.affiliate(id bigint,person_id bigint,status text,parent_id bigint,position text,current_rank_id int);
    CREATE TABLE mlm.blacklist(email_norm text,phone_last10 text,name_norm text,birthdate date);
    CREATE FUNCTION mlm.norm_email(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lower(btrim($1)) $$;
    CREATE FUNCTION mlm.norm_phone10(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT right(regexp_replace($1,'[^0-9]','','g'),10) $$;
    CREATE FUNCTION mlm.norm_name(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lower(btrim($1)) $$;
    INSERT INTO auth."user"(id,email,email_verified,name) VALUES('existing-admin','admin@example.test',true,'Existing Administrator');
    INSERT INTO mlm.person VALUES
      (1,'GOOD@example.test','active',NULL,false,'1111111111','Good','Member',NULL),
      (2,'pending@example.test','pending',NULL,false,'2222222222','Pending','Member',NULL),
      (3,'invalid','active',NULL,false,'3333333333','Bad','Member',NULL),
      (4,'collision@example.test','active',NULL,false,'4444444444','Collision','One',NULL),
      (5,' COLLISION@example.test ','active',NULL,false,'5555555555','Collision','Two',NULL),
      (6,'blocked@example.test','active',NULL,true,'6666666666','Blocked','Member',NULL),
      (7,'suspended@example.test','suspended',NULL,false,'7777777777','Suspended','Member',NULL),
      (8,'admin@example.test','active',NULL,false,'8888888888','Admin','Member',NULL),
      (9,'affiliate-blocked@example.test','active',NULL,false,'9999999999','Aff','Member',NULL),
      (10,'blacklisted@example.test','active',NULL,false,'1231231231','List','Member',NULL),
      (11,'linked@example.test','active','old-auth-subject',false,'1231231232','Linked','Member',NULL),
      (12,' padded@example.test ','active',NULL,false,'1231231233','Padded','Member',NULL);
    INSERT INTO mlm.affiliate VALUES(11,1,'active',NULL,NULL,7),(12,9,'suspended',11,'L',5);
    INSERT INTO mlm.blacklist(email_norm) VALUES('blacklisted@example.test');
  `);
  const output = docker(['run', '--pull=never', '--rm', '-i', '--read-only', '--tmpfs', '/tmp', '--network', `container:${name}`,
    '--mount', `type=bind,source=${source},target=/app/scripts,readonly`, '-e', 'PENDING_ACCESS_SYNTHETIC_URL',
    '--entrypoint', 'bun', 'mindbliss/api-login-recovery-test-20261030:local', '--no-env-file', '-'], String.raw`
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    import {connectTarget,targetConfiguration,planMigration,applyMigration,validatePlan} from './scripts/pending-email-access-migration.ts';
    const raw=process.env.PENDING_ACCESS_SYNTHETIC_URL;
    const config=targetConfiguration(raw);assert.equal(config.local,true);assert.equal(config.database,'pending_access_synthetic');
    const {sql}=connectTarget(raw,config.target);let assertions=0;
    const equal=(a,b)=>{assert.deepEqual(a,b);assertions++;};
    const digest=async()=>createHash('sha256').update(JSON.stringify(await sql.unsafe('SELECT to_jsonb(p) AS row FROM mlm.person p ORDER BY id'))
      +JSON.stringify(await sql.unsafe('SELECT to_jsonb(a) AS row FROM mlm.affiliate a ORDER BY id'))).digest('hex');
    globalThis.fetch=async()=>{throw new Error('External providers forbidden');};
    try {
      const businessBefore=await digest();
      const plan=await planMigration(sql,config.database,config.target);
      equal(plan.counts.eligible,2);equal((await sql.unsafe('SELECT count(*)::int AS n FROM auth."user"'))[0].n,1);
      validatePlan(plan,plan.digest,config.target);assertions++;
      equal(await applyMigration(sql,config.database,plan),{status:'applied',inserted:2,total:2});
      equal((await sql.unsafe('SELECT count(*)::int AS n FROM auth."user" WHERE email_verified=false AND phone_number_verified=false AND phone_number IS NULL AND contact_phone_e164 IS NULL AND contact_whatsapp_e164 IS NULL'))[0].n,2);
      equal((await sql.unsafe('SELECT count(*)::int AS n FROM auth.account'))[0].n,0);
      equal((await sql.unsafe('SELECT count(*)::int AS n FROM auth.session'))[0].n,0);
      equal((await sql.unsafe('SELECT count(*)::int AS n FROM identity.auth_binding'))[0].n,0);
      equal(await digest(),businessBefore);
      const first=plan.candidates[0].authId;
      await sql.unsafe('UPDATE auth."user" SET email_verified=true WHERE id=$1',[first]);
      equal(await applyMigration(sql,config.database,plan),{status:'already-applied',inserted:0,total:2});
      equal((await sql.unsafe('SELECT email_verified FROM auth."user" WHERE id=$1',[first]))[0].email_verified,true);
      const fresh=await planMigration(sql,config.database,config.target);equal(fresh.counts.eligible,0);
      await sql.unsafe("INSERT INTO mlm.person VALUES(13,'new@example.test','active',NULL,false,'1231231234','New','Member',NULL)");
      await assert.rejects(()=>applyMigration(sql,config.database,fresh),/SOURCE_CHANGED_REPLAN_REQUIRED/);assertions++;
      const rollbackPlan=await planMigration(sql,config.database,config.target);
      await sql.unsafe("ALTER TABLE auth.\"user\" ADD CONSTRAINT synthetic_reject CHECK(email <> 'new@example.test')");
      await assert.rejects(()=>applyMigration(sql,config.database,rollbackPlan));assertions++;
      equal((await sql.unsafe("SELECT count(*)::int AS n FROM auth.\"user\" WHERE email='new@example.test'"))[0].n,0);
      await sql.unsafe('ALTER TABLE auth."user" DROP CONSTRAINT synthetic_reject');
      await sql.unsafe("CREATE FUNCTION auth.synthetic_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
      await sql.unsafe('CREATE TRIGGER synthetic_side_effect BEFORE INSERT ON auth."user" FOR EACH ROW EXECUTE FUNCTION auth.synthetic_trigger()');
      await assert.rejects(()=>planMigration(sql,config.database,config.target),/AUTH_USER_SHAPE_OR_SIDE_EFFECT_REQUIRES_REVIEW/);assertions++;
      equal((await sql.unsafe('SELECT email_verified,name FROM auth."user" WHERE id=$1',['existing-admin']))[0],{email_verified:true,name:'Existing Administrator'});
      console.log(JSON.stringify({syntheticPostgres:'17.11',assertions,pendingInserted:2,neutralAuthOnly:true,idempotent:true,
        sourceAndTreeUnchanged:true,rollback:true,triggerGuard:true,messagesSent:0,productionAccess:false,network:'none'}));
    }finally{await sql.end({timeout:2});}
  `);
  console.log(output);
} finally { if (created) docker(['rm', '-f', name]); }
