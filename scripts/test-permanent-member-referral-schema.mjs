import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadNativeProfilePrefixCache } from './native-member-profile-prefix-cache.mjs';

// A verified synthetic-only through114 fixture; no live URLs, host ports or
// application secrets are read. Every scenario runs in this one labelled DB.
assert.equal(process.argv.length, 2);
let verifiedPrefix = await loadNativeProfilePrefixCache();
if (!verifiedPrefix) {
  // A clean checkout can build the same synthetic prerequisite from tracked
  // harnesses. The warm path never reruns already-passed historical probes.
  const child = spawn(process.execPath, [fileURLToPath(new URL('test-native-member-profile-schema.mjs', import.meta.url))], { stdio: 'inherit', shell: false });
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(status, 0, 'synthetic_prerequisite_failed'); verifiedPrefix = await loadNativeProfilePrefixCache();
}
assert.ok(verifiedPrefix, 'tracked_synthetic_prefix_required');
const { manifest: cache, source: prefix } = verifiedPrefix;
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(cache.synthetic, 'native-profile-through114-v1'); assert.equal(cache.productionConnections, 0);
assert.equal(cache.network, 'none'); assert.equal(cache.hostPorts, 0); assert.equal(cache.prefix114Probes, 202);
assert.equal(sha(prefix), cache.sha256);
const container = `mb-permanent-referral-test-${randomUUID()}`, database = 'mindbliss_curated_20261025';
const runtime = 'mindbliss_auth_core_v1', owner = 'member_referral117_owner', reader = 'mindbliss_go_payments_reader_v1';
const label = 'permanent-referral117', image = 'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
const docker = (args, input) => spawnSync('docker', args, { input, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
const psql = (source, fail = false) => { const result = docker(['exec', '-i', container, 'psql', '-X', '-w', '-qAt', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'], source);
  if (!fail && result.status !== 0) throw Error(result.stderr || 'synthetic_sql_failed'); return result; };
const value = (source, role = runtime) => psql(`${role ? `SET ROLE ${role};` : ''}${source}`).stdout.trim();
let probes = 0;
const eq = (source, expected, role = runtime) => { assert.equal(value(source, role), expected, source); probes++; };
const deny = (source, code, role = runtime) => { const result = psql(`${role ? `SET ROLE ${role};` : ''}${source}`, true); assert.notEqual(result.status, 0, source); assert.match(result.stderr, new RegExp(code), source); probes++; };
const lit = value => `'${String(value).replaceAll("'", "''")}'`;
function concurrent(source, marker = '') {
  let ready; const signalled = new Promise(resolve => { ready = resolve; });
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-X', '-w', '-qAt', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let stdout = '', stderr = '';
  const complete = new Promise((resolve, reject) => { child.on('error', reject); child.stdout.on('data', data => { stdout += data; if (marker && stdout.includes(marker)) ready(); });
    child.stderr.on('data', data => { stderr += data; }); child.on('close', status => resolve({ status, stdout, stderr })); });
  child.stdin.end(source); if (!marker) ready(); return { ready: signalled, complete };
}
const users = Array.from({ length: 18 }, (_, i) => ({ subject: `ref117-owner-${i}`, session: `ref117-session-${i}`, person: 11700 + i }));
const read = (i, session = users[i].session) => `SELECT identity.read_member_referral('${users[i].subject}','${session}')::text;`;
const capture = (i, code = '', company = 117903) => `SELECT identity.capture_member_referral('${users[i].subject}','${users[i].session}',${lit(code)},${company})::text;`;
const own = i => JSON.parse(value(read(i)));
try {
  assert.equal(docker(['run', '--detach', '--pull', 'never', '--name', container, '--label', `mindbliss.synthetic=${label}`, '--network', 'none',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', `POSTGRES_DB=${database}`, image]).status, 0);
  let ready = false; for (let i = 0; i < 100; i++) { if (docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', database]).status === 0) { ready = true; break; } await delay(100); } assert.ok(ready);
  for (const role of cache.roles) psql(`CREATE ROLE ${role.name} ${role.login ? 'LOGIN' : 'NOLOGIN'} ${role.inherit ? 'INHERIT' : 'NOINHERIT'};`);
  for (const member of cache.members) psql(`GRANT ${member.role} TO ${member.member};`);
  psql(prefix);
  assert.equal(docker(['inspect', '--format', '{{.HostConfig.NetworkMode}}', container]).stdout.trim(), 'none');
  psql(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE referral117_default NOLOGIN;
    DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='${reader}')THEN CREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;END$$;
    ALTER TABLE auth."user" ADD COLUMN IF NOT EXISTS email text,ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS name text,ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),ADD COLUMN IF NOT EXISTS contact_phone_e164 text;
    ALTER TABLE mlm.person ADD COLUMN IF NOT EXISTS country text,ADD COLUMN IF NOT EXISTS payout_wallet_usdc text,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT '2026-01-01',ADD COLUMN IF NOT EXISTS birthday date,
      ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT '2026-01-01';
    DO $$BEGIN IF(SELECT atttypid FROM pg_attribute WHERE attrelid='mlm.person'::regclass AND attname='public_id')='bigint'::regtype THEN
     ALTER TABLE mlm.person ALTER COLUMN public_id TYPE uuid USING md5('ref117-prefix:'||public_id::text)::uuid;END IF;END$$;
    CREATE TABLE IF NOT EXISTS mlm.affiliate(id bigint PRIMARY KEY,legacy_id_vicionario bigint,person_id bigint NOT NULL,sponsor_id bigint,parent_id bigint,invitation_link text,status text NOT NULL DEFAULT 'active',created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE mlm.affiliate ADD COLUMN IF NOT EXISTS id bigint,ADD COLUMN IF NOT EXISTS sponsor_id bigint,ADD COLUMN IF NOT EXISTS parent_id bigint,ADD COLUMN IF NOT EXISTS invitation_link text,ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    UPDATE mlm.affiliate SET id=-person_id WHERE id IS NULL; CREATE UNIQUE INDEX IF NOT EXISTS affiliate_ref117_id_idx ON mlm.affiliate(id);
    CREATE TABLE IF NOT EXISTS mlm.affiliate_package(id bigint PRIMARY KEY,affiliate_id bigint NOT NULL,status text NOT NULL);
    CREATE TABLE IF NOT EXISTS payments.registration_referral(email_norm text PRIMARY KEY,referral_code text NOT NULL,sponsor_affiliate_id bigint NOT NULL,preferred_side text,source text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),consumed_at timestamptz);
    CREATE TABLE IF NOT EXISTS payments.purchase_intent(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),person_id bigint,sponsor_affiliate_id bigint,status text NOT NULL DEFAULT 'created');
    CREATE TABLE IF NOT EXISTS payments.nowpayments_membership_attempt(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),person_id bigint,sponsor_affiliate_id bigint,state text NOT NULL DEFAULT 'creating_invoice');
    CREATE TABLE IF NOT EXISTS mlm.blacklist(email_norm text,phone_last10 text,name_norm text,birthdate date);
    CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
    GRANT USAGE ON SCHEMA auth,identity,mlm,payments,public TO ${owner};GRANT USAGE ON SCHEMA payments TO ${reader};
    GRANT SELECT ON auth."user",auth.session,identity.auth_binding,mlm.person,mlm.affiliate,mlm.affiliate_package,mlm.blacklist,payments.registration_referral,payments.purchase_intent,payments.nowpayments_membership_attempt TO ${owner};
    GRANT UPDATE(expires_at) ON auth.session TO ${owner};GRANT UPDATE(subject) ON identity.auth_binding TO ${owner};
    GRANT UPDATE(first_name,last_name,phone_number,country,updated_at)ON mlm.person TO ${owner};GRANT UPDATE(name,contact_phone_e164,updated_at)ON auth."user" TO ${owner};
    ALTER DEFAULT PRIVILEGES IN SCHEMA identity GRANT SELECT ON TABLES TO referral117_default;
    ALTER DEFAULT PRIVILEGES IN SCHEMA identity,payments GRANT EXECUTE ON FUNCTIONS TO referral117_default;`);
  const normalization = await readFile(new URL('../_meta/migration/43_blacklist.sql', import.meta.url), 'utf8');
  for (const name of ['norm_email', 'norm_phone10']) { const definition = normalization.match(new RegExp(`CREATE OR REPLACE FUNCTION mlm\\.${name}\\([\\s\\S]*?\\$\\$;`))?.[0]; assert.ok(definition); psql(definition); }
  psql(`CREATE OR REPLACE FUNCTION mlm.norm_name(p text)RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT NULLIF(regexp_replace(lower(public.unaccent(btrim(coalesce(p,'')))),'\\s+',' ','g'),'')$$;
   GRANT EXECUTE ON FUNCTION mlm.norm_name(text),mlm.norm_email(text),mlm.norm_phone10(text)TO ${owner};`);
  const guardSource = (await readFile(new URL('../_meta/migration/92_administrative_wallets_meld.sql', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const guard = guardSource.match(/CREATE FUNCTION identity\.administrative_wallet_person\(p_subject text\)[\s\S]*?END \$function\$;/)?.[0]; assert.ok(guard); psql(guard.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
  psql(`GRANT EXECUTE ON FUNCTION identity.administrative_wallet_person(text) TO ${owner};`);
  const nativeSource = (await readFile(new URL('../_meta/migration/114_administrative_wallet_signing_dry_run.sql', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const native = nativeSource.match(/CREATE FUNCTION identity\.require_administrative_native_session\(p_subject text,p_session text\)[\s\S]*?END \$function\$;/)?.[0]; assert.ok(native); psql(native.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
  psql(`ALTER FUNCTION identity.require_administrative_native_session(text,text) OWNER TO ${owner};`);
  const oldProfile = (await readFile(new URL('../_meta/migration/115_native_member_profile.sql', import.meta.url), 'utf8')).replaceAll('\r\n', '\n'); psql(oldProfile);
  psql(`INSERT INTO auth."user"(id,eligible,email,email_verified,name)VALUES${users.map(u => `('${u.subject}',true,'${u.subject}@example.invalid',true,'Synthetic Member')`).join(',')};
   INSERT INTO auth.session(id,user_id,expires_at)VALUES${users.map(u => `('${u.session}','${u.subject}',clock_timestamp()+interval '2 days')`).join(',')};
   INSERT INTO mlm.person(id,public_id,user_id,email,status,first_name,last_name,phone_number,updated_at)
   VALUES${users.map((u, i) => `(${u.person},'${randomUUID()}','${u.subject}','${u.subject}@example.invalid','${i === 1 ? 'pending' : 'active'}','Synthetic','Member${i}','+12025550123','2026-01-01')`).join(',')};
   INSERT INTO identity.auth_binding(subject,provider,person_id)VALUES${users.map(u => `('${u.subject}','better_auth',${u.person})`).join(',')};
   INSERT INTO mlm.person(id,public_id,user_id,email,status,first_name,last_name,phone_number,updated_at)VALUES
    (11790,'${randomUUID()}',NULL,'recruiting@example.invalid','active','Recruiting','Sponsor','','2026-01-01'),
    (11791,'${randomUUID()}',NULL,'placement@example.invalid','active','Placement','Parent','','2026-01-01'),
    (11792,'${randomUUID()}',NULL,'company@example.invalid','active','Synthetic','Company','','2026-01-01'),
    (11794,'${randomUUID()}',NULL,'case-a@example.invalid','active','Case','First','','2026-01-01'),
    (11795,'${randomUUID()}',NULL,'case-b@example.invalid','active','Case','Second','','2026-01-01'),
    (11796,'${randomUUID()}',NULL,'numeric@example.invalid','active','Numeric','Sponsor','','2026-01-01'),
    (11797,'${randomUUID()}',NULL,'literal@example.invalid','active','Literal','Sponsor','','2026-01-01');
   INSERT INTO mlm.affiliate(id,person_id,sponsor_id,parent_id,invitation_link,status)VALUES
    (117901,11790,NULL,NULL,'RECRUITING','active'),(117902,11791,NULL,NULL,'ROTATED-CODE','active'),(117903,11792,NULL,NULL,'COMPANY','active'),
    (117000,11700,117901,117902,'LEGACY-OWN','active'),(117910,11794,NULL,NULL,'abc','active'),(117911,11795,NULL,NULL,'ABC','active'),
    (42,11796,NULL,NULL,'NUMERIC','active'),(117912,11797,NULL,NULL,'MP42','active');
   INSERT INTO payments.registration_referral(email_norm,referral_code,sponsor_affiliate_id,source,updated_at)
    VALUES('${users[5].subject}@example.invalid','ROTATED-CODE',117901,'verified_login',now()-interval '90 days');`);
  const tableNames = ['identity.permanent_member_referral', 'identity.member_registration_sponsor'];
  const signatures = ['identity.member_referral_person_eligible(bigint)', 'identity.ensure_permanent_member_referral(text,text)', 'identity.read_member_referral(text,text)',
    'identity.capture_member_referral(text,text,text,bigint)', 'identity.read_member_profile_v2(text,text)', 'identity.update_member_profile_v2(text,text,text,text,text)',
    'payments.guard_permanent_referral_checkout()', 'payments.read_permanent_checkout_sponsor(text,bigint)'];
  const fnQ = `SELECT md5(coalesce(string_agg(pg_get_functiondef(p.oid)||p.proowner::text||coalesce(p.proacl::text,'')||coalesce(p.proconfig::text,''),E'\n'ORDER BY p.oid),''))FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('identity','payments','mlm')AND p.oid NOT IN(${signatures.map(s => `coalesce(to_regprocedure(${lit(s)})::oid,0)`).join(',')});`;
  const oldRowsQ = `SELECT jsonb_object_agg(name,fingerprint)::text FROM(SELECT n.nspname||'.'||c.relname name,
   md5(coalesce((xpath('/row/value/text()',query_to_xml(format('SELECT string_agg(to_jsonb(t)::text,E''\\n''ORDER BY to_jsonb(t)::text) AS value FROM %I.%I t',n.nspname,c.relname),false,true,'')))[1]::text,''))fingerprint
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r'AND n.nspname IN('identity','payments','mlm','auth')AND n.nspname||'.'||c.relname NOT IN(${tableNames.map(lit).join(',')}))s;`;
  const before = { rows: value(oldRowsQ, ''), functions: value(fnQ, ''), people: value('SELECT jsonb_agg(to_jsonb(p)ORDER BY id)::text FROM mlm.person p;', ''),
    affiliates: value('SELECT jsonb_agg(to_jsonb(a)ORDER BY id)::text FROM mlm.affiliate a;', '') };
  const migration = (await readFile(new URL('../_meta/migration/117_permanent_member_referrals.sql', import.meta.url), 'utf8')).replaceAll('\r\n', '\n'); psql(migration);
  eq(oldRowsQ, before.rows, ''); eq(fnQ, before.functions, '');
  const first = own(0), pending = own(1); assert.equal(first.code, 'LEGACY-OWN'); assert.equal(first.sponsor_name, 'Recruiting Sponsor');
  assert.equal(first.sponsor_referral_code, 'RECRUITING'); assert.equal(first.positioned, true); assert.match(pending.code, /^MB[0-9a-f]{32}$/); assert.equal(pending.positioned, false); assert.equal(pending.attribution_source, 'unassigned'); probes += 7;
  assert.equal(own(1).code, pending.code); eq(`SELECT count(*) FROM mlm.affiliate WHERE person_id=${users[1].person};`, '0', ''); probes++;
  eq(`SELECT count(*) FROM mlm.affiliate_package WHERE affiliate_id=117000;`, '0', ''); eq(oldRowsQ, before.rows, '');
  const child = JSON.parse(value(capture(2, pending.code))); assert.equal(child.positioned, false); assert.equal(child.immutable, true); assert.equal(child.ref, pending.code); probes += 3;
  assert.equal(own(2).sponsor_name, 'Synthetic Member1'); assert.equal(own(2).attribution_source, 'referral'); probes += 2;
  const viaProfile = JSON.parse(value(`SELECT row_to_json(r)::text FROM identity.read_member_profile_v2('${users[2].subject}','${users[2].session}')r;`)); assert.equal(viaProfile.sponsor_name, 'Synthetic Member1'); assert.equal(viaProfile.referral_code, own(2).code); probes += 2;
  const direct = JSON.parse(value(capture(3))); assert.equal(direct.ref, 'COMPANY'); assert.equal(own(3).sponsor_name, 'Synthetic Company'); assert.equal(own(3).attribution_source, 'company'); probes += 3;
  value(capture(3, pending.code)); assert.equal(own(3).sponsor_name, 'Synthetic Company'); probes++;
  value(capture(0, pending.code)); assert.equal(own(0).sponsor_name, 'Recruiting Sponsor'); probes++;
  value(capture(5)); assert.equal(own(5).sponsor_name, 'Recruiting Sponsor'); assert.equal(own(5).sponsor_referral_code, 'ROTATED-CODE'); probes += 2;
  deny(capture(4, own(4).code), 'member_referral_invalid_code'); deny(capture(4, 'missing-code'), 'member_referral_invalid_code'); deny(capture(4, '', 117000), 'member_referral_unconfigured');
  deny(read(1, users[0].session), 'member_referral_forbidden'); deny(read(1, 'missing'), 'member_referral_forbidden');
  psql(`UPDATE auth.session SET expires_at=clock_timestamp()-interval '1 second' WHERE id='${users[4].session}';`); deny(read(4), 'member_referral_forbidden');
  psql(`UPDATE auth.session SET expires_at=clock_timestamp()+interval '2 days' WHERE id='${users[4].session}';`);
  psql(`INSERT INTO mlm.blacklist(email_norm)VALUES('${users[4].subject}@example.invalid');`); deny(read(4), 'member_referral_forbidden'); deny(capture(4), 'member_referral_forbidden'); psql(`DELETE FROM mlm.blacklist WHERE email_norm='${users[4].subject}@example.invalid';`);
  psql(`DELETE FROM auth.session WHERE id='${users[4].session}';`); deny(read(4), 'member_referral_forbidden');
  psql(`INSERT INTO auth.session(id,user_id,expires_at)VALUES('new-session-ref117','${users[4].subject}',clock_timestamp()+interval '2 days');`);
  assert.match(JSON.parse(value(read(4, 'new-session-ref117'))).code, /^MB/); probes++;
  const aliasCases = [[8, 'abc', 'Case First'], [9, 'ABC', 'Case Second'], [10, 'MP42', 'Literal Sponsor'], [11, 'MP00042', 'Numeric Sponsor']];
  for (const [i, code, sponsor] of aliasCases) { value(capture(i, code)); assert.equal(own(i).sponsor_name, sponsor); probes++; }
  deny(capture(12, 'AbC'), 'member_referral_invalid_code');
  psql(`UPDATE mlm.affiliate SET invitation_link=${lit(pending.code.toLowerCase())}WHERE id=117912;`); deny(capture(12, pending.code), 'member_referral_invalid_code'); psql(`UPDATE mlm.affiliate SET invitation_link='MP42'WHERE id=117912;`);
  const a = own(13).code, b = own(14).code;
  const cycle1 = concurrent(`SET ROLE ${runtime};BEGIN;${capture(13, b)}SELECT pg_sleep(0.3);COMMIT;`);
  await delay(50); const cycle2 = concurrent(`SET ROLE ${runtime};${capture(14, a)}`); const cycleResults = await Promise.all([cycle1.complete, cycle2.complete]);
  assert.equal(cycleResults.filter(r => r.status === 0).length, 1); assert.match(cycleResults.find(r => r.status !== 0).stderr, /member_referral_invalid_code/); probes += 2;
  const concurrentLinks = await Promise.all([concurrent(`SET ROLE ${runtime};${read(15)}`).complete, concurrent(`SET ROLE ${runtime};${read(15)}`).complete]); assert.ok(concurrentLinks.every(r => r.status === 0)); assert.equal(concurrentLinks[0].stdout.trim(), concurrentLinks[1].stdout.trim()); probes += 2;
  eq(`SELECT count(*)FROM identity.permanent_member_referral WHERE subject='${users[15].subject}';`, '1', '');
  // Reservation snapshot exists before capture. Timestamp fence forces local
  // transaction rollback instead of a stale, wrongly-company-attributed order.
  const stale = concurrent(`BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT id FROM mlm.person WHERE id=${users[6].person};\n\\echo REF117_READY\nSELECT pg_sleep(0.8);INSERT INTO payments.nowpayments_membership_attempt(person_id,sponsor_affiliate_id)VALUES(${users[6].person},117903);COMMIT;`, 'REF117_READY');
  await stale.ready; value(capture(6, pending.code)); const staleResult = await stale.complete; assert.notEqual(staleResult.status, 0); assert.match(staleResult.stderr, /could not serialize access/); probes += 2;
  eq(`SELECT count(*)FROM payments.nowpayments_membership_attempt WHERE person_id=${users[6].person};`, '0', '');
  const held = concurrent(`BEGIN;INSERT INTO payments.purchase_intent(person_id,sponsor_affiliate_id)VALUES(${users[7].person},117903);\n\\echo REF117_ORDER_READY\nSELECT pg_sleep(0.5);COMMIT;`, 'REF117_ORDER_READY');
  await held.ready; const pendingCapture = concurrent(`SET ROLE ${runtime};${capture(7, pending.code)}`); assert.equal((await held.complete).status, 0); const pendingResult = await pendingCapture.complete; assert.notEqual(pendingResult.status, 0); assert.match(pendingResult.stderr, /member_referral_outstanding_order/); probes += 3;
  eq(`SELECT count(*)FROM identity.member_registration_sponsor WHERE subject='${users[7].subject}';`, '0', '');
  deny(`SELECT *FROM payments.read_permanent_checkout_sponsor('${users[2].subject}',${users[2].person});`, 'referral_sponsor_needs_placement', reader);
  deny(`SELECT *FROM payments.read_permanent_checkout_sponsor('${users[15].subject}',${users[15].person});`, 'referral_attribution_required', reader);
  deny(`SELECT *FROM payments.read_permanent_checkout_sponsor('${users[2].subject}',${users[3].person});`, 'referral_identity_review', reader);
  eq(`SELECT sponsor_affiliate_id FROM payments.read_permanent_checkout_sponsor('${users[0].subject}',${users[0].person});`, '117901', reader);
  for (const table of ['payments.purchase_intent', 'payments.nowpayments_membership_attempt']) deny(`INSERT INTO ${table}(person_id,sponsor_affiliate_id)VALUES(${users[2].person},117903);`, 'referral_sponsor_needs_placement', '');
  psql(`INSERT INTO mlm.affiliate(id,person_id,sponsor_id,parent_id,invitation_link,status)VALUES(117999,${users[1].person},117903,117901,'LATER-LEGACY','active');`);
  assert.equal(own(1).code, pending.code); probes++;
  eq(`SELECT sponsor_affiliate_id FROM payments.read_permanent_checkout_sponsor('${users[2].subject}',${users[2].person});`, '117999', reader);
  for (const table of ['payments.purchase_intent', 'payments.nowpayments_membership_attempt']) {
    deny(`INSERT INTO ${table}(person_id,sponsor_affiliate_id)VALUES(${users[2].person},117903);`, 'referral_sponsor_mismatch', '');
    psql(`BEGIN;INSERT INTO ${table}(person_id,sponsor_affiliate_id)VALUES(${users[2].person},117999);ROLLBACK;`); probes++;
  }
  const profileBefore = JSON.parse(value(`SELECT row_to_json(r)::text FROM identity.read_member_profile_v2('${users[2].subject}','${users[2].session}')r;`));
  const profileChanged = JSON.parse(value(`BEGIN;SELECT row_to_json(r)::text FROM identity.update_member_profile_v2('${users[2].subject}','${users[2].session}','Marina del Río','+12025550124',NULL)r;ROLLBACK;`));
  assert.equal(profileChanged.sponsor_name, profileBefore.sponsor_name); assert.equal(profileChanged.referral_code, profileBefore.referral_code); assert.equal(profileChanged.first_name, 'Marina'); probes += 3;
  // Totals are not truncated to the 50 displayed referral records.
  psql(`INSERT INTO mlm.person(id,public_id,email,status,first_name,last_name,phone_number)SELECT 11800+n,md5('direct117-'||n)::uuid,'direct117-'||n||'@example.invalid','active','Direct','Member',''FROM generate_series(1,55)n;
   INSERT INTO mlm.affiliate(id,person_id,sponsor_id,parent_id,invitation_link,status)SELECT 118000+n,11800+n,117000,117902,'DIRECT117-'||n,'active'FROM generate_series(1,55)n;`);
  const totals = own(0); assert.equal(totals.metrics.total, 55); assert.equal(totals.referrals.length, 50); probes += 2;
  const exposed = new Set(['identity.read_member_referral(text,text)', 'identity.capture_member_referral(text,text,text,bigint)', 'identity.read_member_profile_v2(text,text)', 'identity.update_member_profile_v2(text,text,text,text,text)']);
  const functions = signatures.map(signature => JSON.parse(value(`SELECT jsonb_build_object('signature',p.oid::regprocedure::text,'md5',md5(pg_get_functiondef(p.oid)),'owner',p.proowner,'securityDefiner',p.prosecdef,'proconfig',p.proconfig,'acl',p.proacl)::text FROM pg_proc p WHERE p.oid=${lit(signature)}::regprocedure;`, '')));
  for (const f of functions) { assert.equal(f.securityDefiner, true); assert.deepEqual(f.proconfig, f.signature === 'identity.member_referral_person_eligible(bigint)' ? ['search_path=pg_catalog'] : ['search_path=pg_catalog', 'lock_timeout=2s']);
    eq(`SELECT has_function_privilege('${runtime}',${lit(f.signature)},'EXECUTE');`, exposed.has(f.signature) ? 't' : 'f', '');
    eq(`SELECT has_function_privilege('referral117_default',${lit(f.signature)},'EXECUTE');`, 'f', ''); }
  for (const table of tableNames) { eq(`SELECT relrowsecurity FROM pg_class WHERE oid=${lit(table)}::regclass;`, 't', '');
    eq(`SELECT has_table_privilege('${runtime}',${lit(table)},'SELECT,INSERT,UPDATE,DELETE');`, 'f', '');
    eq(`SELECT has_table_privilege('referral117_default',${lit(table)},'SELECT,INSERT,UPDATE,DELETE');`, 'f', ''); }
  eq(fnQ, before.functions, '');
  const currentPeople = JSON.parse(value('SELECT jsonb_agg(to_jsonb(p)ORDER BY id)::text FROM mlm.person p;', ''));
  const capturedPeople = new Set(JSON.parse(value("SELECT coalesce(jsonb_agg(person_id),'[]'::jsonb)::text FROM identity.member_registration_sponsor;", '')));
  for (const person of JSON.parse(before.people)) { const current = currentPeople.find(p => p.id === person.id); assert.ok(current);
    const fields = x => Object.fromEntries(Object.entries(x).filter(([key]) => key !== 'updated_at'));
    assert.deepEqual(fields(current), fields(person)); if (!capturedPeople.has(person.id)) assert.equal(current.updated_at, person.updated_at); probes++; }
  const currentAffiliates = JSON.parse(value('SELECT jsonb_agg(to_jsonb(a)ORDER BY id)::text FROM mlm.affiliate a;', ''));
  for (const affiliate of JSON.parse(before.affiliates)) { assert.deepEqual(currentAffiliates.find(a => a.id === affiliate.id), affiliate); probes++; }
  const tables = tableNames.map(name => JSON.parse(value(`SELECT jsonb_build_object('name',${lit(name)},'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid))ORDER BY a.attnum)FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=${lit(name)}::regclass AND a.attnum>0 AND NOT a.attisdropped),'constraints',(SELECT jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid,true))ORDER BY c.conname)FROM pg_constraint c WHERE c.conrelid=${lit(name)}::regclass),'indexes',(SELECT jsonb_agg(indexname ORDER BY indexname)FROM pg_indexes WHERE schemaname=split_part(${lit(name)},'.',1)AND tablename=split_part(${lit(name)},'.',2)))::text;`, '')));
  const triggers = JSON.parse(value(`SELECT jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,'definition',pg_get_triggerdef(t.oid,true))ORDER BY t.tgname)::text FROM pg_trigger t WHERE t.tgname IN('purchase_intent_permanent_referral_guard','nowpayments_membership_permanent_referral_guard');`, ''));
  const report = { migrationSha256: sha(migration), syntheticPostgresPassed: true, probes, tables,
    functions: functions.map(f => ({ ...f, ownerReferenceSignature: 'identity.require_administrative_native_session(text,text)', runtimeExecute: exposed.has(f.signature), goReaderExecute: f.signature === 'payments.read_permanent_checkout_sponsor(text,bigint)' })),
    addedTriggers: triggers, constraints: [], changedFunctions: [], migrationOldRowsUnchanged: true, allOldFunctionsUnchanged: true,
    runtimeOldPersonException: 'Only first attribution capture updates its own mlm.person.updated_at MVCC fence; no other person/affiliate/financial field is written.',
    canonicalExistingSponsorsPreserved: true, pendingPersonNoPurchaseLink: true, noFabricatedTreeNodes: true, legacyVerifiedSponsorIdAuthority: true,
    repeatableReadRaceSerializationVerified: true, outstandingOrderCaptureRejected: true, productionConnections: 0, charges: 0, transfers: 0, network: 'none' };
  await mkdir(new URL('../.wrangler/', import.meta.url), { recursive: true }); await writeFile(new URL('../.wrangler/permanent-member-referrals-117-manifest.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ permanentMemberReferrals: 'passed', probes, newTables: tables.length, newFunctions: functions.length, newTriggers: triggers.length, syntheticOnly: true, productionConnections: 0, charges: 0, transfers: 0 }));
} finally {
  const found = docker(['inspect', '--format', '{{index .Config.Labels "mindbliss.synthetic"}}', container]);
  if (found.status === 0 && found.stdout.trim() === label && /^mb-permanent-referral-test-[a-f0-9-]{36}$/.test(container)) docker(['rm', '--force', container]);
}
