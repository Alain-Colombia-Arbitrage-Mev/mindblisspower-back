// Disposable PostgreSQL rehearsal only. No .env, production URL, provider,
// public network/port or customer input is accepted by this program.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

if (process.argv.slice(2).join(' ') !== '--synthetic-docker') throw new Error('Requires --synthetic-docker');
const image = 'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27';
const name = 'identity-correction-pg-' + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex');
const environment = { ...process.env, POSTGRES_PASSWORD: password };
const database = 'identity_correction_synthetic';
const sql = readFileSync(new URL('../../_meta/ops/20261105_correct_legacy_identity_access.sql', import.meta.url), 'utf8');
const parameters = { phase: 'quarantine', expected_database: database, source_person_id: '101', target_person_id: '102',
  case_email: 'owner@example.test', quarantine_email: 'review-old@identity.invalid', new_subject: randomUUID(),
  operation_key: 'synthetic-correction-' + randomUUID(), actor_subject: 'synthetic-admin',
  evidence_confirmed: 'legacy_username_and_phone_reviewed' };
let created = false, assertions = 0;
function docker(args, input, expectedFailure = false) {
  const result = spawnSync('docker', args, { env: environment, input, encoding: 'utf8', windowsHide: true,
    maxBuffer: 2 * 1024 * 1024, timeout: 60_000 });
  if (result.error) throw new Error('Synthetic Docker process unavailable');
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').replaceAll(password, '[redacted]');
  if (expectedFailure) { assert.notEqual(result.status, 0, 'Expected a transaction rollback'); assertions++; }
  else if (result.status !== 0) throw new Error(output || 'Synthetic Docker failed');
  return output;
}
const psql = (input, expectedFailure = false, extra = []) => docker(['exec', '-i', name, 'psql', '-X', '-qAt',
  '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', ...extra], input, expectedFailure);
function apply(overrides = {}, expectedFailure = false, operationSQL = sql) {
  const values = { ...parameters, ...overrides };
  const flags = Object.entries(values).flatMap(([key, value]) => ['-v', `${key}=${value}`]);
  return psql(operationSQL, expectedFailure, flags);
}
const state = () => {
  const tables = ['mlm.person','mlm.affiliate','mlm.rank','mlm.wallet','mlm.affiliate_package','mlm.affiliate_rank_achieved',
    'mlm.blacklist','payments.sales_import_row','payments.nowpayments_membership_attempt','payments.investment',
    'auth.user','auth.account','auth.session','auth.verification','auth.rate_limit','identity.auth_binding','audit.activity_log'];
  const fields = tables.map(table => `'${table}',(SELECT coalesce(jsonb_agg(row),'[]'::jsonb) FROM
    (SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY to_jsonb(t)::text) AS row)`).join(',');
  return JSON.parse(psql(`SELECT jsonb_build_object(${fields});`).trim());
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function equal(actual, expected) { assert.deepEqual(actual, expected); assertions++; }
function rollbackCase(overrides = {}) {
  const before = state(); apply(overrides, true); equal(hash(state()), hash(before));
}
try {
  docker(['run', '--pull=never', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_DB=${database}`, image]);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore', windowsHide: true,
      timeout: 5000 }).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Synthetic PostgreSQL unavailable');
  psql(`
    CREATE EXTENSION citext;
    CREATE SCHEMA auth; CREATE SCHEMA mlm; CREATE SCHEMA identity; CREATE SCHEMA payments; CREATE SCHEMA audit;
    CREATE TABLE auth."user"(id text PRIMARY KEY,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,
      name text,image text,phone_number text UNIQUE,phone_number_verified boolean NOT NULL DEFAULT false,
      contact_phone_e164 text,contact_whatsapp_e164 text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE mlm.person(id bigint PRIMARY KEY,public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      user_id text UNIQUE REFERENCES auth."user"(id) ON DELETE RESTRICT,email citext NOT NULL UNIQUE,
      legacy_id_person bigint,alias text,first_name text,last_name text,phone_number text,birthday date,
      status text NOT NULL,is_admin boolean NOT NULL DEFAULT false,blacklisted boolean NOT NULL DEFAULT false,balance numeric(20,2));
    CREATE TABLE mlm.rank(id smallint PRIMARY KEY,code text NOT NULL);
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,person_id bigint UNIQUE REFERENCES mlm.person(id),status text NOT NULL,
      parent_id bigint,sponsor_id bigint,position text,path text,depth int,current_rank_id smallint REFERENCES mlm.rank(id),
      rank_points_baseline numeric,left_pv_lifetime numeric,right_pv_lifetime numeric);
    CREATE TABLE mlm.wallet(id bigint PRIMARY KEY,affiliate_id bigint,balance numeric(20,2));
    CREATE TABLE mlm.affiliate_package(id bigint PRIMARY KEY,affiliate_id bigint,principal numeric(20,2),pv numeric,status text);
    CREATE TABLE mlm.affiliate_rank_achieved(affiliate_id bigint,rank_id smallint,source text,bonus numeric);
    CREATE TABLE mlm.blacklist(email_norm text,phone_last10 text,name_norm text,birthdate date);
    CREATE FUNCTION mlm.norm_email(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT nullif(lower(btrim($1)),'') $$;
    CREATE FUNCTION mlm.norm_phone10(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT nullif(right(regexp_replace($1,'[^0-9]','','g'),10),'') $$;
    CREATE FUNCTION mlm.norm_name(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT nullif(lower(btrim($1)),'') $$;
    CREATE TABLE identity.auth_binding(subject text PRIMARY KEY REFERENCES auth."user"(id) ON DELETE RESTRICT,
      person_id bigint NOT NULL UNIQUE REFERENCES mlm.person(id) ON DELETE RESTRICT,provider text NOT NULL DEFAULT 'better_auth',
      link_method text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION identity.protect_public_id() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.public_id IS DISTINCT FROM NEW.public_id THEN RAISE EXCEPTION 'person_public_id_is_immutable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER person_public_id_immutable BEFORE UPDATE OF public_id ON mlm.person FOR EACH ROW EXECUTE FUNCTION identity.protect_public_id();
    CREATE FUNCTION identity.protect_auth_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.subject IS DISTINCT FROM NEW.subject OR OLD.person_id IS DISTINCT FROM NEW.person_id
        OR OLD.provider IS DISTINCT FROM NEW.provider OR OLD.link_method IS DISTINCT FROM NEW.link_method
        THEN RAISE EXCEPTION 'auth_binding_is_immutable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER auth_binding_immutable BEFORE UPDATE ON identity.auth_binding FOR EACH ROW EXECUTE FUNCTION identity.protect_auth_binding();
    CREATE TABLE auth.account(id text PRIMARY KEY,user_id text REFERENCES auth."user"(id),password text);
    CREATE TABLE auth.session(id text PRIMARY KEY,user_id text REFERENCES auth."user"(id),token text);
    CREATE TABLE auth.verification(id text PRIMARY KEY,identifier text NOT NULL,value text);
    CREATE TABLE auth.rate_limit(id text PRIMARY KEY,key text,count int,last_request bigint);
    CREATE TABLE payments.sales_import_row(id bigint PRIMARY KEY,person_id bigint,total numeric);
    CREATE TABLE payments.nowpayments_membership_attempt(id bigint PRIMARY KEY,person_id bigint,total numeric,status text);
    CREATE TABLE payments.investment(id bigint PRIMARY KEY,person_id bigint,principal numeric,expires_at date);
    CREATE TABLE audit.activity_log(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor_user_id text REFERENCES auth."user"(id),
      entity_type text NOT NULL,entity_id text NOT NULL,action text NOT NULL,before_data jsonb,after_data jsonb,occurred_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO auth."user"(id,email,email_verified,name) VALUES
      ('synthetic-admin','admin@example.test',true,'Admin'),('synthetic-old','owner@example.test',true,'Old access'),
      ('synthetic-other','other@example.test',true,'Other access');
    INSERT INTO mlm.person(id,user_id,email,legacy_id_person,alias,first_name,last_name,phone_number,status,is_admin,balance) VALUES
      (100,'synthetic-admin','admin@example.test',100,'admin','Admin','Fixture','12025550100','active',true,0),
      (101,'synthetic-old','OWNER@example.test',101,'wrong-fixture','Wrong','Member','12025550101','active',false,17.12),
      (102,NULL,'owner+vleg102@example.test',102,'correct-fixture','Correct','Member','12025550101','active',false,28.34),
      (103,'synthetic-other','other@example.test',103,'other','Other','Member','12025550103','active',false,39.56);
    INSERT INTO mlm.rank VALUES(1,'BRONZE'),(11,'AMBASSADOR');
    INSERT INTO mlm.affiliate VALUES(1000,100,'active',NULL,NULL,NULL,'1000',0,11,1000000,0,0),
      (1001,101,'active',1000,1000,'L','1000.1001',1,1,1000,99,88),
      (1002,102,'active',1000,1000,'R','1000.1002',1,11,1000000,77,66),
      (1003,103,'active',1001,1000,'L','1000.1001.1003',2,1,1000,55,44);
    INSERT INTO identity.auth_binding(subject,person_id,link_method) VALUES
      ('synthetic-admin',100,'approved_claim'),('synthetic-old',101,'verified_email'),('synthetic-other',103,'verified_email');
    INSERT INTO mlm.wallet VALUES(1,1001,10.11),(2,1002,20.22),(3,1003,30.33);
    INSERT INTO mlm.affiliate_package VALUES(1,1001,50,49.5,'active'),(2,1002,100,99,'active');
    INSERT INTO mlm.affiliate_rank_achieved VALUES(1001,1,'legacy',0),(1002,11,'legacy',0);
    INSERT INTO payments.sales_import_row VALUES(1,103,100);
    INSERT INTO payments.nowpayments_membership_attempt VALUES(1,103,50,'activated');
    INSERT INTO payments.investment VALUES(1,103,50,'2027-11-05');
    INSERT INTO auth.account VALUES('old-credential','synthetic-old','synthetic-retained-hash'),('other-credential','synthetic-other','synthetic-unrelated-hash');
    INSERT INTO auth.session VALUES('old-session-1','synthetic-old','synthetic-token-1'),('old-session-2','synthetic-old','synthetic-token-2'),
      ('other-session','synthetic-other','synthetic-unrelated-token');
    INSERT INTO auth.verification VALUES('otp-signin','sign-in-otp-owner@example.test','synthetic-private-otp-hash'),
      ('otp-verify','email-verification-otp-owner@example.test','synthetic-private-otp-hash'),
      ('otp-reset','forget-password-otp-owner@example.test','synthetic-private-otp-hash'),
      ('other-otp','sign-in-otp-other@example.test','synthetic-unrelated-otp-hash'),
      ('recipient-budget','synthetic-message-budget','synthetic-budget-not-an-otp');
    INSERT INTO auth.rate_limit VALUES('limit','synthetic-owner-budget',4,12345);
  `);
  // Every failed case is compared across ALL fixture relations, not just the
  // expected record. Sequence gaps on rolled-back audit INSERT are not claims.
  rollbackCase({ quarantine_email: 'other@example.test' });
  rollbackCase({ quarantine_email: 'review@deliverable.example.test' });
  rollbackCase({ expected_database: 'not_this_database' });
  rollbackCase({ actor_subject: 'synthetic-other' });
  rollbackCase({ evidence_confirmed: 'not-reviewed' });
  rollbackCase({ phase: 'complete' });
  psql(`INSERT INTO identity.auth_binding(subject,person_id,link_method) VALUES('synthetic-other-target',102,'approved_claim');`, true);
  // A real conflicting target principal/binding must abort, not be overwritten.
  psql(`INSERT INTO auth."user"(id,email) VALUES('synthetic-bound-target','bound@example.test');
    UPDATE mlm.person SET user_id='synthetic-bound-target' WHERE id=102;
    INSERT INTO identity.auth_binding(subject,person_id,link_method) VALUES('synthetic-bound-target',102,'approved_claim');`);
  rollbackCase();
  psql(`DELETE FROM identity.auth_binding WHERE subject='synthetic-bound-target'; UPDATE mlm.person SET user_id=NULL WHERE id=102;
    DELETE FROM auth."user" WHERE id='synthetic-bound-target';`);
  psql(`ALTER TABLE mlm.person DISABLE TRIGGER person_public_id_immutable;`); rollbackCase();
  psql(`ALTER TABLE mlm.person ENABLE TRIGGER person_public_id_immutable;`);
  // An unexpected trigger is rejected before it can drift an affiliate.
  psql(`CREATE FUNCTION mlm.synthetic_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    UPDATE mlm.affiliate SET rank_points_baseline=0 WHERE person_id=NEW.id; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_drift AFTER UPDATE OF email ON mlm.person FOR EACH ROW EXECUTE FUNCTION mlm.synthetic_drift();`);
  rollbackCase();
  psql(`DROP TRIGGER synthetic_drift ON mlm.person; DROP FUNCTION mlm.synthetic_drift();`);
  const before = state();
  const row = (snapshot, table, id) => snapshot[table].find(value => String(value.data.id) === String(id))?.data;
  const without = (value, fields) => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
  const quarantinedResult = apply(); assert.match(quarantinedResult, /quarantined_wait_6_minutes/); assertions++;
  const quarantined = state();
  for (const table of ['mlm.person','mlm.affiliate','mlm.rank','mlm.wallet','mlm.affiliate_package','mlm.affiliate_rank_achieved',
    'payments.sales_import_row','payments.nowpayments_membership_attempt','payments.investment','auth.account','auth.rate_limit','identity.auth_binding']) {
    equal(hash(quarantined[table]),hash(before[table]));
  }
  equal(quarantined['auth.user'].length,before['auth.user'].length);
  equal(row(quarantined,'auth.user',parameters.new_subject),undefined);
  equal(row(quarantined,'auth.user','synthetic-old').email_verified,false);
  equal(row(quarantined,'auth.user','synthetic-old').email,parameters.quarantine_email);
  equal(quarantined['auth.session'].map(value=>value.data.id),['other-session']);
  equal(quarantined['audit.activity_log'].length,1);
  equal(quarantined['audit.activity_log'][0].data.entity_type,'legacy_identity_access_correction_phase1');
  equal(quarantined['audit.activity_log'][0].data.after_data.pending_principal_created,false);
  const premature = apply({ phase:'complete' },true);
  assert.match(premature,/identity_correction_token_drain_pending/); assertions++;
  equal(hash(state()),hash(quarantined));
  rollbackCase(); // Phase one cannot be replayed or restart its drain clock.

  // FIXTURE ONLY: advance the audited database timestamp to avoid a six-minute
  // test sleep. The production operation has NO time parameter or override.
  psql(`UPDATE audit.activity_log SET occurred_at=now()-interval '7 minutes'
    WHERE entity_type='legacy_identity_access_correction_phase1';`);
  rollbackCase({ phase:'complete', new_subject:randomUUID() });
  psql(`UPDATE mlm.person SET balance=balance+0.01 WHERE id=102;`);
  rollbackCase({ phase:'complete' });
  psql(`UPDATE mlm.person SET balance=balance-0.01 WHERE id=102;`);
  psql(`INSERT INTO auth.session VALUES('synthetic-late-session','synthetic-old','synthetic-late-token');`);
  rollbackCase({ phase:'complete' });
  psql(`DELETE FROM auth.session WHERE id='synthetic-late-session';`);
  psql(`INSERT INTO mlm.blacklist(email_norm) VALUES('owner@example.test');`);
  rollbackCase({ phase:'complete' });
  psql(`DELETE FROM mlm.blacklist;`);
  // A late INSERT constraint failure must roll back both person-email changes
  // while leaving the already committed old-access quarantine in force.
  psql(`ALTER TABLE auth."user" ADD CONSTRAINT synthetic_late_failure CHECK(name <> 'Cuenta pendiente');`);
  rollbackCase({ phase:'complete' });
  psql(`ALTER TABLE auth."user" DROP CONSTRAINT synthetic_late_failure;`);
  // Exercise the actual postcondition, not only the unexpected-trigger guard.
  const marker = "  IF (SELECT to_jsonb(p)-'email' FROM mlm.person p WHERE p.id=c.source_person_id)";
  equal(sql.split(marker).length,2);
  const driftSQL = sql.replace(marker,`  UPDATE mlm.affiliate SET rank_points_baseline=0 WHERE person_id=c.target_person_id;\n${marker}`);
  const beforeDrift = state();
  const drift = apply({ phase:'complete' },true,driftSQL);
  assert.match(drift,/identity_correction_postcondition_drift/); assertions++;
  equal(hash(state()),hash(beforeDrift));

  const result = apply({ phase:'complete' }); assert.match(result, /legacy_identity_access_correction_applied_pending_otp/); assertions++;
  const after = state();
  for (const table of ['mlm.affiliate','mlm.rank','mlm.wallet','mlm.affiliate_package','mlm.affiliate_rank_achieved','mlm.blacklist',
    'payments.sales_import_row','payments.nowpayments_membership_attempt','payments.investment','auth.account','auth.rate_limit','identity.auth_binding']) {
    equal(hash(after[table]), hash(before[table]));
  }
  for (const id of [100,103]) equal(row(after,'mlm.person',id), row(before,'mlm.person',id));
  for (const id of [101,102]) equal(without(row(after,'mlm.person',id),['email']), without(row(before,'mlm.person',id),['email']));
  equal(row(after,'mlm.person',101).email, parameters.quarantine_email);
  equal(row(after,'mlm.person',102).email, parameters.case_email);
  equal(row(after,'mlm.person',102).user_id, null);
  for (const id of ['synthetic-admin','synthetic-other']) equal(row(after,'auth.user',id),row(before,'auth.user',id));
  equal(without(row(after,'auth.user','synthetic-old'),['email','email_verified','updated_at']),
    without(row(before,'auth.user','synthetic-old'),['email','email_verified','updated_at']));
  equal(row(after,'auth.user','synthetic-old').email_verified,false);
  equal(row(after,'auth.user','synthetic-old').email,parameters.quarantine_email);
  const pending = row(after,'auth.user',parameters.new_subject);
  equal(pending.email_verified,false); equal(pending.email,parameters.case_email);
  equal([pending.image,pending.phone_number,pending.contact_phone_e164,pending.contact_whatsapp_e164],[null,null,null,null]);
  equal(pending.phone_number_verified,false);
  equal(after['auth.session'].map(value=>value.data.id),['other-session']);
  equal(after['auth.verification'],before['auth.verification'].filter(value=>!['otp-signin','otp-verify','otp-reset'].includes(value.data.id)));
  equal(after['audit.activity_log'].length,2);
  const phase1Audit = after['audit.activity_log'].find(value=>value.data.entity_type==='legacy_identity_access_correction_phase1').data;
  const audit = after['audit.activity_log'].find(value=>value.data.entity_type==='legacy_identity_access_correction').data;
  equal(phase1Audit.after_data.sessions_revoked,2); equal(phase1Audit.after_data.native_challenges_revoked,3);
  equal(audit.after_data.pending_principal_created,true); equal(audit.after_data.sessions_revoked,0);
  assert.doesNotMatch(JSON.stringify(after['audit.activity_log']), /@|synthetic-retained-hash|synthetic-token|private-otp-hash|password|contact_phone/); assertions++;
  rollbackCase(); rollbackCase({ phase:'complete' });
  // Protectors remain live after success. No exception or global weakening.
  psql(`UPDATE mlm.person SET public_id=gen_random_uuid() WHERE id=102;`,true);
  psql(`UPDATE identity.auth_binding SET person_id=102 WHERE subject='synthetic-old';`,true);
  equal(hash(state()),hash(after));
  const topology = JSON.parse(docker(['inspect','--format','{{json .HostConfig}}',name]));
  equal(topology.NetworkMode,'none'); equal(topology.PortBindings,{});
  console.log(JSON.stringify({ postgres: '17.11', assertions, pendingPrincipal: true, oldBindingPreserved: true,
    phases:2, fixedTokenDrainSeconds:360, prematureCompletionRejected:true,
    immutableTriggersActive: true, globalBusinessHashesUnchanged: true, rollbackAndReplayGuard: true,
    credentialsCopied: 0, messagesSent: 0, productionAccess: false, network: 'none', publishedPorts: 0 }));
} finally {
  // Exact random fixture container only; no user containers/volumes are touched.
  if (created) docker(['rm','-f',name]);
}
