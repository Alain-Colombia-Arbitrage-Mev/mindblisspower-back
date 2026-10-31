// Explicit isolated harness: no host/cloud DSN, network access or real provider.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

if (process.argv.slice(2).join(' ') !== '--synthetic-docker') throw new Error('Requires --synthetic-docker');
const name = `registration-synthetic-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const source = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, POSTGRES_PASSWORD: password,
  REGISTRATION_TEST_DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:5432/registration_synthetic` };
function docker(args, input) {
  const result = spawnSync('docker', args, { env, input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Synthetic Docker command failed').replaceAll(password, '[redacted]'));
  return result.stdout.trim();
}
let created = false;
try {
  docker(['run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=registration_synthetic',
    'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'disposable PostgreSQL did not become ready');
  docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'registration_synthetic', '-v', 'ON_ERROR_STOP=1'], `
    CREATE EXTENSION unaccent;
    CREATE SCHEMA mlm;
    CREATE TABLE mlm.person(id bigint PRIMARY KEY,email text,phone_number text,first_name text,last_name text,birthday date,blacklisted boolean,status text);
    CREATE TABLE mlm.affiliate(person_id bigint,status text);
    CREATE TABLE mlm.blacklist(email_norm text,phone_last10 text,name_norm text,birthdate date);
    CREATE FUNCTION mlm.norm_email(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(lower(btrim(p)),'') $$;
    CREATE FUNCTION mlm.norm_name(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(regexp_replace(lower(public.unaccent(btrim(coalesce(p,'')))),'\\s+',' ','g'),'') $$;
    CREATE FUNCTION mlm.norm_phone10(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
      WITH d AS (SELECT regexp_replace(coalesce(p,''),'\\D','','g') AS digits)
      SELECT CASE WHEN length(digits)<10 THEN NULL WHEN right(digits,10) ~ '^(.)\\1{9}$' THEN NULL ELSE right(digits,10) END FROM d $$;
  `);
  const result = docker(['run', '--rm', '-i', '--network', `container:${name}`, '--read-only',
    '--mount', `type=bind,source=${source},target=/app/src,readonly`, '-e', 'REGISTRATION_TEST_DATABASE_URL',
    '--entrypoint', 'bun', 'mindbliss/api-test:auth-identity-20261025', '--no-env-file', '-'], `
    import assert from 'node:assert/strict';
    import postgres from 'postgres';
    import {drizzle} from 'drizzle-orm/postgres-js';
    import {registrationAllowed} from './src/auth/registration.ts';
    const url=new URL(process.env.REGISTRATION_TEST_DATABASE_URL);
    assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.pathname,'/registration_synthetic');
    const connection=postgres(url.href,{max:1,prepare:false});
    const reader=drizzle(connection);
    const candidate={email:'candidate@example.test',name:'Synthetic Member'};
    let assertions=0;
    const check=async(expected,extra={})=>{assert.equal(await registrationAllowed(reader,{...candidate,...extra}),expected);assertions++;};
    try {
      await check(true);
      await connection.unsafe("INSERT INTO mlm.blacklist(email_norm) VALUES('candidate@example.test')");
      await check(false); await connection.unsafe('TRUNCATE mlm.blacklist');
      await connection.unsafe("INSERT INTO mlm.blacklist(name_norm) VALUES('synthetic member')");
      await check(false,{name:'  SýnTHETIC   MéMBER  '}); await connection.unsafe('TRUNCATE mlm.blacklist');
      await connection.unsafe("INSERT INTO mlm.blacklist(name_norm,birthdate) VALUES('synthetic member','1990-01-12')");
      await check(true); await check(false,{birthDate:'1990-01-12'}); await check(true,{birthDate:'1991-01-12'});
      await connection.unsafe('TRUNCATE mlm.blacklist');
      await connection.unsafe("INSERT INTO mlm.blacklist(phone_last10) VALUES('2025550123')");
      await check(false,{phone:'+12025550123'}); await connection.unsafe('TRUNCATE mlm.blacklist');
      await connection.unsafe("INSERT INTO mlm.person VALUES(1,'candidate@example.test','+12025550123','Synthetic','Member','1990-01-12',true,'active')");
      await check(false); await connection.unsafe("UPDATE mlm.person SET blacklisted=false,status='suspended' WHERE id=1");
      await check(false); await connection.unsafe("UPDATE mlm.person SET status='active' WHERE id=1");
      await connection.unsafe("INSERT INTO mlm.affiliate VALUES(1,'suspended')");
      await check(false); await connection.unsafe("UPDATE mlm.affiliate SET status='active'");
      await check(true);
      await connection.unsafe("INSERT INTO mlm.blacklist(phone_last10) VALUES('2025550123')");
      await check(false); await connection.unsafe('TRUNCATE mlm.blacklist');
      await connection.unsafe("INSERT INTO mlm.blacklist(name_norm,birthdate) VALUES('synthetic member','1990-01-12')");
      await check(false);
      await connection.unsafe('DROP TABLE mlm.blacklist');
      await assert.rejects(()=>registrationAllowed(reader,candidate)); assertions++;
      console.log(JSON.stringify({syntheticPostgres:'17.11',realReadOnlyCTE:true,assertions,providerCalls:0,productionAccess:false}));
    } finally { await connection.end(); }
  `);
  console.log(result);
} finally {
  if (created) docker(['rm', '-f', name]);
}
