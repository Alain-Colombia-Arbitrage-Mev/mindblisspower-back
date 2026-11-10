import { beforeAll, afterAll, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createLocalJWKSet, jwtVerify } from 'jose';
import * as authSchema from '../../db/schema/auth';
import { createAuthOptions } from '../../auth/options';
import type { AuthDelivery, AuthEnvironment, EmailMessage } from '../../auth/delivery';
import { recipientBudgetKey } from '../../auth/phone-otp';
import { approveLegacyClaim, bindStripeCustomer, claimLegacyPerson, getAuthPersonBinding, provisionAuthPerson, type IdentityDatabase } from './index';
import type { IdentityTransaction } from './model';

// This dedicated URL is accepted ONLY inside the disposable Docker harness.
// Never inherit DATABASE_URL / TEST_DATABASE_URL or contact a real deployment.
const configured = process.env.IDENTITY_SYNTHETIC_DOCKER === '1';
const integration = configured ? test : test.skip;
let connection: ReturnType<typeof postgres>;
let database: IdentityDatabase;
let migration: string;
let legacyPublicId: string;
let fingerprint: string;
let grantToken: string;
let duplicateMigrationRolledBack = false;

async function applyMigration(source = migration) {
  const reserved = await connection.reserve();
  try { await reserved.unsafe(source); }
  catch (error) { await reserved.unsafe('ROLLBACK'); throw error; }
  finally { reserved.release(); }
}

beforeAll(async () => {
  if (!configured) return;
  const url = new URL(process.env.IDENTITY_TEST_DATABASE_URL ?? '');
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/identity_synthetic' || url.port !== '5432') throw new Error('identity_test_must_be_disposable_local_postgres');
  connection = postgres(url.toString(), { prepare: false, max: 4, onnotice: () => {} });
  database = drizzle(connection) as unknown as IdentityDatabase;
  migration = await readFile(new URL('../../../../_meta/migration/70_stable_identity_bindings.sql', import.meta.url), 'utf8');
  await connection.unsafe(`CREATE EXTENSION citext; CREATE EXTENSION ltree; CREATE EXTENSION unaccent;
    CREATE ROLE app_read NOLOGIN; CREATE ROLE app_write NOLOGIN; CREATE ROLE app_admin NOLOGIN;
    CREATE SCHEMA auth; CREATE SCHEMA mlm; CREATE SCHEMA payments;
    ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON TABLES TO app_read;
    CREATE TABLE auth.user(id text PRIMARY KEY,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,name text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TYPE mlm.person_status AS ENUM('pending','active','suspended','banned','deleted');
    CREATE TYPE mlm.kyc_status AS ENUM('not_started','in_review','approved','rejected','expired');
    CREATE TABLE mlm.person(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id text UNIQUE REFERENCES auth.user(id),legacy_id_person integer UNIQUE,
      first_name text NOT NULL,last_name text NOT NULL,email citext NOT NULL UNIQUE,phone_number text NOT NULL,birthday date,status mlm.person_status NOT NULL DEFAULT 'pending',
      kyc_status mlm.kyc_status NOT NULL DEFAULT 'not_started',is_admin boolean NOT NULL DEFAULT false,blacklisted boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE mlm.rank(id smallint PRIMARY KEY,code text NOT NULL UNIQUE);
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,person_id bigint NOT NULL UNIQUE REFERENCES mlm.person(id),parent_id bigint REFERENCES mlm.affiliate(id),sponsor_id bigint REFERENCES mlm.affiliate(id),path ltree NOT NULL,current_rank_id smallint REFERENCES mlm.rank(id),status text NOT NULL DEFAULT 'active');
    CREATE TABLE mlm.blacklist(email_norm text,phone_last10 text,name_norm text,birthdate date);
    CREATE FUNCTION mlm.norm_email(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(lower(btrim(p)),'') $$;
    CREATE FUNCTION mlm.norm_phone10(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
      WITH d AS (SELECT regexp_replace(coalesce(p,''),'\\D','','g') AS digits)
      SELECT CASE WHEN length(digits)<10 OR right(digits,10) ~ '^(.)\\1{9}$' THEN NULL ELSE right(digits,10) END FROM d $$;
    CREATE FUNCTION mlm.norm_name(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT NULLIF(regexp_replace(lower(unaccent(btrim(coalesce(p,'')))),'\\s+',' ','g'),'') $$;
    INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,is_admin) VALUES('Legacy','Operator','legacy@example.test','0','active',true);
    INSERT INTO mlm.rank VALUES(3,'SYNTHETIC');
    INSERT INTO mlm.affiliate(id,person_id,parent_id,sponsor_id,path,current_rank_id) VALUES(71,1,NULL,NULL,'n71',3);`);
  fingerprint = JSON.stringify(await connection`SELECT to_jsonb(a) AS row FROM mlm.affiliate a ORDER BY id`);
  // A pre-existing duplicate provider subject must abort ALL additive changes,
  // not silently discard an OAuth account or leave a half-applied UUID rollout.
  const accountDDL = migration.match(/CREATE TABLE IF NOT EXISTS auth\.account \([\s\S]*?\n\);/)?.[0];
  if (!accountDDL) throw new Error('missing_account_migration_contract');
  await connection.unsafe(accountDDL);
  await connection`INSERT INTO auth.user(id,email) VALUES('duplicate-one','duplicate-one@example.test'),('duplicate-two','duplicate-two@example.test')`;
  await connection`INSERT INTO auth.account(id,user_id,provider_id,account_id) VALUES('duplicate-one','duplicate-one','google','duplicate-subject'),('duplicate-two','duplicate-two','google','duplicate-subject')`;
  await expect(applyMigration()).rejects.toBeDefined();
  expect((await connection`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='mlm' AND table_name='person' AND column_name='public_id'`)[0]!.n).toBe(0);
  expect((await connection`SELECT to_regnamespace('identity') IS NULL AS absent`)[0]!.absent).toBe(true);
  duplicateMigrationRolledBack = true;
  await connection`DELETE FROM auth.account WHERE id IN ('duplicate-one','duplicate-two')`;
  await connection`DELETE FROM auth.user WHERE id IN ('duplicate-one','duplicate-two')`;
  await applyMigration();
  // Registration contact columns are additive and private to the auth writer.
  await connection.unsafe(`CREATE ROLE mindbliss_auth_core_v1 NOLOGIN;
    CREATE ROLE mindbliss_auth_20261025 LOGIN;
    GRANT mindbliss_auth_core_v1 TO mindbliss_auth_20261025;
    GRANT USAGE ON SCHEMA mlm TO mindbliss_auth_core_v1;
    GRANT SELECT(id,public_id,user_id,email,status,blacklisted,is_admin) ON mlm.person TO mindbliss_auth_core_v1;`);
  const contactMigration = (await readFile(new URL('../../../../_meta/migration/76_registration_contact_details.sql', import.meta.url), 'utf8'))
    .replace('REPLACE_WITH_CURATED_DATABASE', 'identity_synthetic');
  const contactConnection = await connection.reserve();
  try { await contactConnection.unsafe(contactMigration); }
  catch (error) { await contactConnection.unsafe('ROLLBACK'); throw error; }
  finally { contactConnection.release(); }
  const smsMigration = (await readFile(new URL('../../../../_meta/migration/75_sms_auth_opt_in.sql', import.meta.url), 'utf8'))
    .replace('REPLACE_WITH_CURATED_DATABASE', 'identity_synthetic');
  const smsConnection = await connection.reserve();
  try { await smsConnection.unsafe(smsMigration); }
  catch (error) { await smsConnection.unsafe('ROLLBACK'); throw error; }
  finally { smsConnection.release(); }
  const verifiedEmailMigration = (await readFile(new URL('../../../../_meta/migration/78_verified_email_identity_binding.sql', import.meta.url), 'utf8'))
    .replace('REPLACE_WITH_CURATED_DATABASE', 'identity_synthetic');
  const verifiedEmailConnection = await connection.reserve();
  try {
    await verifiedEmailConnection.unsafe(verifiedEmailMigration);
    await verifiedEmailConnection.unsafe(verifiedEmailMigration);
  } catch (error) { await verifiedEmailConnection.unsafe('ROLLBACK'); throw error; }
  finally { verifiedEmailConnection.release(); }
  const walletMigration = (await readFile(new URL('../../../../_meta/migration/92_administrative_wallets_meld.sql', import.meta.url), 'utf8'))
    .replace("pg_catalog.current_database()<>'mindbliss_curated_20261025'", "pg_catalog.current_database()<>'identity_synthetic'");
  await applyMigration(walletMigration);
  legacyPublicId = (await connection`SELECT public_id::text FROM mlm.person WHERE id=1`)[0]!.public_id;
  for (const [id, email, verified] of [['legacy-user', 'legacy@example.test', true], ['new-user', 'new@example.test', true], ['unverified-user', 'unverified@example.test', false], ['admin-user', 'operator@example.test', true], ['other-user', 'other@example.test', true]] as const) {
    await connection`INSERT INTO auth.user(id,email,email_verified,name) VALUES(${id},${email},${verified},'Synthetic Member')`;
  }
}, 30_000);
afterAll(async () => { if (connection) await connection.end(); });

integration('migration is repeatable, adds stable UUIDs and never rewrites network/rank facts', async () => {
  expect(duplicateMigrationRolledBack).toBe(true);
  await applyMigration();
  expect((await connection`SELECT public_id::text FROM mlm.person WHERE id=1`)[0]!.public_id).toBe(legacyPublicId);
  expect(JSON.stringify(await connection`SELECT to_jsonb(a) AS row FROM mlm.affiliate a ORDER BY id`)).toBe(fingerprint);
  expect((await connection`SELECT count(*)::int AS n FROM identity.auth_binding`)[0]!.n).toBe(0);
  await expect(connection`UPDATE mlm.person SET public_id=gen_random_uuid() WHERE id=1`).rejects.toBeDefined();
  expect((await connection`SELECT has_table_privilege('app_read','auth.jwks','SELECT') AS allowed`)[0]!.allowed).toBe(false);
  expect((await connection`SELECT has_column_privilege('app_write','identity.legacy_claim_grant','consumed_at','UPDATE') AS allowed`)[0]!.allowed).toBe(true);
  for (const column of ['subject', 'person_id', 'token_hash', 'approved_by_subject', 'expires_at']) {
    expect((await connection`SELECT has_column_privilege('app_write','identity.legacy_claim_grant',${column},'UPDATE') AS allowed`)[0]!.allowed).toBe(false);
  }
  expect((await connection`SELECT has_table_privilege('app_write','identity.legacy_claim_grant','INSERT') AS allowed`)[0]!.allowed).toBe(false);
});

integration('administrative wallet allocation is immutable, unique under concurrency and exhausts honestly', async () => {
  await connection.unsafe(`INSERT INTO auth."user"(id,email,email_verified,name)
    SELECT 'wallet-user-'||g,'wallet-user-'||g||'@example.test',true,'Wallet Member' FROM generate_series(1,29) g;
    INSERT INTO mlm.person(user_id,first_name,last_name,email,phone_number,status)
    SELECT 'wallet-user-'||g,'Wallet','Member','wallet-user-'||g||'@example.test',
      (3000000000+g)::text,'active' FROM generate_series(1,29) g;
    INSERT INTO identity.auth_binding(subject,person_id,link_method)
    SELECT p.user_id,p.id,'new_registration' FROM mlm.person p WHERE p.user_id LIKE 'wallet-user-%';`);

  const subjects = Array.from({ length: 28 }, (_, index) => `wallet-user-${index + 1}`);
  const assignments = await Promise.all(subjects.map(async subject =>
    (await connection`SELECT * FROM identity.ensure_administrative_wallet(${subject})`)[0]!));
  expect(assignments.every(row => row.status === 'assigned')).toBe(true);
  expect(new Set(assignments.map(row => row.address)).size).toBe(28);
  const original = assignments[0]!;
  const repeated = (await connection`SELECT * FROM identity.ensure_administrative_wallet('wallet-user-1')`)[0]!;
  expect(repeated.address).toBe(original.address);
  expect(repeated.checkout_reference).toBe(original.checkout_reference);
  expect((await connection`SELECT * FROM identity.ensure_administrative_wallet('wallet-user-29')`)[0]!.status).toBe('exhausted');
  expect((await connection`SELECT * FROM identity.administrative_wallet_inventory()`)[0]).toMatchObject({
    total: 28, assigned: 28, remaining: 0, disabled: 0,
  });

  const attempt = (await connection`SELECT * FROM payments.create_meld_onramp_attempt(
    'wallet-user-1','administrative',${original.address},'CO','BANXA','CREDIT_DEBIT_CARD',100,96,4)`)[0]!;
  expect(Number(attempt.mindbliss_fee_usd)).toBe(1);

  expect((await connection`SELECT payments.capture_meld_webhook_event(
    'event-wallet-1','TRANSACTION_CRYPTO_PENDING',now(),'account-test','profile-test','2026-11-10'::date,
    ${attempt.id}::uuid,${attempt.id}::uuid,'transaction-test','PENDING','CRYPTO_PURCHASE',${'a'.repeat(64)},
    '{"eventId":"event-wallet-1"}'::jsonb) AS inserted`)[0]!.inserted).toBe(true);
  expect((await connection`SELECT payments.capture_meld_webhook_event(
    'event-wallet-1','TRANSACTION_CRYPTO_PENDING',now(),'account-test','profile-test','2026-11-10'::date,
    ${attempt.id}::uuid,${attempt.id}::uuid,'transaction-test','PENDING','CRYPTO_PURCHASE',${'a'.repeat(64)},
    '{"eventId":"event-wallet-1"}'::jsonb) AS inserted`)[0]!.inserted).toBe(false);
  expect((await connection`SELECT matched_subject FROM payments.meld_webhook_event WHERE event_id='event-wallet-1'`)[0]!.matched_subject)
    .toBe('wallet-user-1');
  expect((await connection`SELECT status FROM payments.meld_onramp_attempt WHERE id=${attempt.id}::uuid`)[0]!.status).toBe('pending');
  expect((await connection`SELECT payments.capture_meld_webhook_event(
    'event-wallet-complete','TRANSACTION_CRYPTO_COMPLETE',now(),'account-test','profile-test','2026-11-10'::date,
    ${attempt.id}::uuid,${attempt.id}::uuid,'transaction-test','COMPLETE','CRYPTO_PURCHASE',${'b'.repeat(64)},
    '{"eventId":"event-wallet-complete"}'::jsonb) AS inserted`)[0]!.inserted).toBe(true);
  expect((await connection`SELECT payments.capture_meld_webhook_event(
    'event-wallet-late-pending','TRANSACTION_CRYPTO_PENDING',now(),'account-test','profile-test','2026-11-10'::date,
    ${attempt.id}::uuid,${attempt.id}::uuid,'transaction-test','PENDING','CRYPTO_PURCHASE',${'c'.repeat(64)},
    '{"eventId":"event-wallet-late-pending"}'::jsonb) AS inserted`)[0]!.inserted).toBe(true);
  expect((await connection`SELECT status,commission_status FROM payments.meld_onramp_attempt WHERE id=${attempt.id}::uuid`)[0])
    .toMatchObject({ status: 'complete', commission_status: 'calculated' });
  await expect(connection`UPDATE payments.meld_webhook_event SET payment_status='COMPLETE' WHERE event_id='event-wallet-1'`).rejects.toBeDefined();
  for (const table of ['identity.administrative_wallet_pool', 'identity.administrative_wallet_assignment', 'payments.meld_onramp_attempt', 'payments.meld_webhook_event']) {
    expect((await connection`SELECT has_table_privilege('mindbliss_auth_core_v1',${table},'SELECT,INSERT,UPDATE,DELETE') AS allowed`)[0]!.allowed).toBe(false);
  }
});

integration('eligibility migration requires explicit primary review and adds only the missing column SELECT grants', async () => {
  const prepared = await readFile(new URL('../../../../_meta/migration/90_auth_identity_eligibility_reads.sql', import.meta.url), 'utf8');
  const columns = [['mlm.person','first_name'], ['mlm.person','last_name'], ['mlm.person','phone_number'], ['mlm.person','birthday'],
    ['mlm.affiliate','person_id'], ['mlm.affiliate','status'], ['mlm.blacklist','email_norm'], ['mlm.blacklist','phone_last10'],
    ['mlm.blacklist','name_norm'], ['mlm.blacklist','birthdate']] as const;
  for (const [relation, column] of columns) expect((await connection`SELECT has_column_privilege('mindbliss_auth_core_v1',${relation},${column},'SELECT') AS allowed`)[0]!.allowed).toBe(false);
  const before = JSON.stringify(await connection`SELECT to_jsonb(p) AS row FROM mlm.person p ORDER BY id`);
  await expect(applyMigration(prepared)).rejects.toBeDefined();
  expect((await connection`SELECT has_column_privilege('mindbliss_auth_core_v1','mlm.person','birthday','SELECT') AS allowed`)[0]!.allowed).toBe(false);
  const reviewed = prepared.replace('REPLACE_WITH_CURATED_DATABASE', 'identity_synthetic');
  await applyMigration(reviewed);
  await applyMigration(reviewed);
  for (const role of ['mindbliss_auth_core_v1', 'mindbliss_auth_20261025']) {
    for (const [relation, column] of columns) expect((await connection`SELECT has_column_privilege(${role},${relation},${column},'SELECT') AS allowed`)[0]!.allowed).toBe(true);
    for (const relation of ['mlm.affiliate','mlm.blacklist']) {
      expect((await connection`SELECT has_table_privilege(${role},${relation},'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed`)[0]!.allowed).toBe(false);
      expect((await connection`SELECT has_any_column_privilege(${role},${relation},'INSERT,UPDATE,REFERENCES') AS allowed`)[0]!.allowed).toBe(false);
    }
    expect((await connection`SELECT has_column_privilege(${role},'mlm.affiliate','id','SELECT') AS allowed`)[0]!.allowed).toBe(false);
    expect((await connection`SELECT has_column_privilege(${role},'mlm.person','is_admin','UPDATE') AS allowed`)[0]!.allowed).toBe(false);
  }
  expect(JSON.stringify(await connection`SELECT to_jsonb(p) AS row FROM mlm.person p ORDER BY id`)).toBe(before);
  expect(JSON.stringify(await connection`SELECT to_jsonb(a) AS row FROM mlm.affiliate a ORDER BY id`)).toBe(fingerprint);
});

integration('verified signup is idempotent but legacy administrative privileges still require reviewed linking', async () => {
  expect((await provisionAuthPerson(database, { userId: 'unverified-user' })).status).toBe('verification_required');
  const created = await provisionAuthPerson(database, { userId: 'new-user' });
  expect(created.status).toBe('created');
  expect(await provisionAuthPerson(database, { userId: 'new-user' })).toEqual({ ...created, status: 'existing' });
  expect((await provisionAuthPerson(database, { userId: 'legacy-user' })).status).toBe('claim_required');
  expect((await connection`SELECT user_id FROM mlm.person WHERE id=1`)[0]!.user_id).toBeNull();
  expect((await connection`SELECT count(*)::int AS n FROM mlm.affiliate`)[0]!.n).toBe(1);
  expect((await connection`SELECT count(*)::int AS n FROM identity.link_conflict WHERE subject='legacy-user'`)[0]!.n).toBe(1);
  await provisionAuthPerson(database, { userId: 'legacy-user' });
  expect((await connection`SELECT count(*)::int AS n FROM identity.link_conflict WHERE subject='legacy-user'`)[0]!.n).toBe(1);
});

integration('verified normalized email links exactly one eligible legacy person, preserving every network and financial field', async () => {
  await connection`INSERT INTO auth.user(id,email,email_verified,name) VALUES('normalized-user','normalized@example.test',false,'Untrusted Display Name')`;
  const [person] = await connection`INSERT INTO mlm.person(first_name,last_name,email,phone_number,status)
    VALUES('Original','Legacy','  NORMALIZED@example.test  ','+12025550199','active') RETURNING id::text,public_id::text`;
  const before = JSON.stringify(await connection`SELECT to_jsonb(p)-'user_id' AS row FROM mlm.person p WHERE id=${person!.id}`);
  expect((await provisionAuthPerson(database, { userId: 'normalized-user' })).status).toBe('verification_required');
  expect((await connection`SELECT count(*)::int AS n FROM identity.auth_binding WHERE subject='normalized-user'`)[0]!.n).toBe(0);
  await connection`UPDATE auth.user SET email_verified=true WHERE id='normalized-user'`;
  const linked = await provisionAuthPerson(database, { userId: 'normalized-user' });
  expect(linked).toMatchObject({ status: 'existing', personId: person!.id, publicId: person!.public_id });
  expect(await provisionAuthPerson(database, { userId: 'normalized-user' })).toEqual(linked);
  expect((await connection`SELECT link_method FROM identity.auth_binding WHERE subject='normalized-user'`)[0]!.link_method).toBe('verified_email');
  expect(JSON.stringify(await connection`SELECT to_jsonb(p)-'user_id' AS row FROM mlm.person p WHERE id=${person!.id}`)).toBe(before);
  expect(JSON.stringify(await connection`SELECT to_jsonb(a) AS row FROM mlm.affiliate a ORDER BY id`)).toBe(fingerprint);
});

integration('normalized email ambiguity, unavailable people and competing subjects never overwrite a legacy identity', async () => {
  await connection`INSERT INTO auth.user(id,email,email_verified) VALUES('ambiguous-user','ambiguous@example.test',true),
    ('blocked-auto-user','blocked-auto@example.test',true),('competing-one','competing@example.test',true),('competing-two','COMPETING@example.test',true)`;
  await connection`INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,blacklisted) VALUES
    ('Ambiguous','One','ambiguous@example.test','0','active',false),('Ambiguous','Two',' ambiguous@example.test ','0','active',false),
    ('Blocked','Legacy','blocked-auto@example.test','0','active',true),('Competing','Legacy','competing@example.test','0','pending',false)`;
  expect((await provisionAuthPerson(database, { userId: 'ambiguous-user' })).status).toBe('quarantined');
  expect((await provisionAuthPerson(database, { userId: 'blocked-auto-user' })).status).toBe('quarantined');
  expect((await connection`SELECT count(*)::int AS n FROM identity.auth_binding WHERE subject IN ('ambiguous-user','blocked-auto-user')`)[0]!.n).toBe(0);
  const results = await Promise.all(['competing-one','competing-two'].map(userId => provisionAuthPerson(database, { userId })));
  expect(results.filter(result => result.status === 'existing')).toHaveLength(1);
  expect(results.filter(result => result.status === 'quarantined')).toHaveLength(1);
  expect((await connection`SELECT count(*)::int AS n FROM identity.auth_binding WHERE subject IN ('competing-one','competing-two')`)[0]!.n).toBe(1);
  expect((await connection`SELECT count(*)::int AS n FROM mlm.person WHERE lower(btrim(email::text))='competing@example.test'`)[0]!.n).toBe(1);
  expect(JSON.stringify(await connection`SELECT to_jsonb(a) AS row FROM mlm.affiliate a ORDER BY id`)).toBe(fingerprint);
});

integration('verified email linking works without binding UPDATE, admin mutation or financial privileges', async () => {
  await connection`INSERT INTO auth.user(id,email,email_verified) VALUES('restricted-user','restricted@example.test',true)`;
  await connection`INSERT INTO mlm.person(first_name,last_name,email,phone_number,status) VALUES('Restricted','Legacy','restricted@example.test','0','active')`;
  await connection.unsafe(`CREATE ROLE verified_email_restricted NOLOGIN;
    GRANT USAGE ON SCHEMA auth,mlm,identity TO verified_email_restricted;
    GRANT SELECT(id,email,email_verified,name,contact_phone_e164),UPDATE(email_verified) ON auth.user TO verified_email_restricted;
    GRANT SELECT(id,public_id,user_id,email,status,blacklisted,is_admin,phone_number,first_name,last_name,birthday),UPDATE(user_id) ON mlm.person TO verified_email_restricted;
    GRANT SELECT(person_id,status) ON mlm.affiliate TO verified_email_restricted;
    GRANT SELECT(email_norm,phone_last10,name_norm,birthdate) ON mlm.blacklist TO verified_email_restricted;
    GRANT EXECUTE ON FUNCTION mlm.norm_email(text),mlm.norm_phone10(text),mlm.norm_name(text) TO verified_email_restricted;
    GRANT SELECT,INSERT ON identity.auth_binding TO verified_email_restricted;
    GRANT SELECT,INSERT(subject,candidate_person_id,reason),UPDATE(last_seen_at,resolved_at) ON identity.link_conflict TO verified_email_restricted;
    GRANT USAGE ON SEQUENCE identity.link_conflict_id_seq TO verified_email_restricted;`);
  const restricted = { transaction: (callback: (tx: unknown) => unknown) => database.transaction(async tx => {
    await tx.execute(sql`SET LOCAL ROLE verified_email_restricted`);
    return callback(tx);
  }) } as unknown as IdentityDatabase;
  expect((await provisionAuthPerson(restricted, { userId: 'restricted-user' })).status).toBe('existing');
  expect((await connection`SELECT link_method FROM identity.auth_binding WHERE subject='restricted-user'`)[0]!.link_method).toBe('verified_email');
  expect((await connection`SELECT has_table_privilege('verified_email_restricted','identity.auth_binding','UPDATE') AS allowed`)[0]!.allowed).toBe(false);
  expect((await connection`SELECT has_column_privilege('verified_email_restricted','mlm.person','is_admin','UPDATE') AS allowed`)[0]!.allowed).toBe(false);
  expect((await connection`SELECT has_table_privilege('verified_email_restricted','mlm.affiliate','INSERT,UPDATE,DELETE') AS allowed`)[0]!.allowed).toBe(false);
});

for (const [index, kind, blocked] of [
  [0, 'affiliate-suspended', true], [1, 'affiliate-banned', true], [2, 'affiliate-deleted', true],
  [3, 'blacklist-email', true], [4, 'blacklist-phone', true], [5, 'blacklist-name', true],
  [6, 'name-birthday-match', true], [7, 'name-birthday-different', false], [8, 'name-birthday-missing', false],
  [9, 'null-and-placeholder-identifiers', false],
] as const) integration(`canonical verified email eligibility respects ${kind} without changing legacy facts`, async () => {
  const userId = `eligibility-${index}`, email = `${userId}@example.test`;
  await connection`INSERT INTO auth.user(id,email,email_verified,name) VALUES(${userId},${email},true,'Untrusted Safe Display Name')`;
  const phone = kind === 'null-and-placeholder-identifiers' ? '0000000000' : `+12025550${String(index).padStart(3, '0')}`;
  const birthday = kind === 'name-birthday-match' ? '1990-01-12' : kind === 'name-birthday-different' ? '1991-01-12' : null;
  const [person] = await connection`INSERT INTO mlm.person(first_name,last_name,email,phone_number,birthday,status)
    VALUES('  SýnTHETIC  ',' MéMBER  ',${email},${phone},${birthday},'active') RETURNING id::text,public_id::text`;
  const before = JSON.stringify(await connection`SELECT to_jsonb(p)-'user_id' AS row FROM mlm.person p WHERE id=${person!.id}`);
  if (kind.startsWith('affiliate-')) {
    await connection`INSERT INTO mlm.affiliate(id,person_id,path,status) VALUES(${900 + index},${person!.id},${'n' + (900 + index)},${kind.slice('affiliate-'.length)})`;
  } else if (kind === 'blacklist-email') {
    await connection`INSERT INTO mlm.blacklist(email_norm) VALUES(mlm.norm_email(${email}))`;
  } else if (kind === 'blacklist-phone') {
    await connection`INSERT INTO mlm.blacklist(phone_last10) VALUES(mlm.norm_phone10(${phone}))`;
  } else if (kind === 'null-and-placeholder-identifiers') {
    await connection`INSERT INTO mlm.blacklist(email_norm,phone_last10,name_norm) VALUES(NULL,NULL,NULL),(NULL,'0000000000',NULL)`;
  } else {
    await connection`INSERT INTO mlm.blacklist(name_norm,birthdate) VALUES('synthetic member',${kind === 'blacklist-name' ? null : '1990-01-12'})`;
  }
  try {
    const result = await provisionAuthPerson(database, { userId });
    expect(result.status).toBe(blocked ? 'quarantined' : 'existing');
    expect((await connection`SELECT count(*)::int AS n FROM identity.auth_binding WHERE subject=${userId}`)[0]!.n).toBe(blocked ? 0 : 1);
    expect((await connection`SELECT user_id FROM mlm.person WHERE id=${person!.id}`)[0]!.user_id).toBe(blocked ? null : userId);
    expect((await getAuthPersonBinding(database, { userId })).status).toBe(blocked ? 'quarantined' : 'existing');
    expect(JSON.stringify(await connection`SELECT to_jsonb(p)-'user_id' AS row FROM mlm.person p WHERE id=${person!.id}`)).toBe(before);
  } finally {
    // These rows exist only inside the --network none disposable fixture.
    await connection`DELETE FROM mlm.blacklist`;
    if (kind.startsWith('affiliate-')) await connection`DELETE FROM mlm.affiliate WHERE id=${900 + index}`;
  }
});

integration('fresh canonical reads quarantine a newly restricted binding without unlinking, mutating the person or consuming grants', async () => {
  const userId = 'fresh-restriction-user', email = 'fresh-restriction@example.test';
  await connection`INSERT INTO auth.user(id,email,email_verified,name) VALUES(${userId},${email},true,'Fresh Restriction Fixture')`;
  const created = await provisionAuthPerson(database, { userId });
  expect(created.status).toBe('created');
  const original = JSON.stringify(await connection`SELECT to_jsonb(b) AS row FROM identity.auth_binding b WHERE subject=${userId}`);
  const person = JSON.stringify(await connection`SELECT to_jsonb(p) AS row FROM mlm.person p WHERE id=${created.personId!}`);
  await connection`INSERT INTO mlm.blacklist(email_norm) VALUES(${email})`;
  try {
    const conflicts = (await connection`SELECT count(*)::int AS n FROM identity.link_conflict WHERE subject=${userId}`)[0]!.n;
    expect((await getAuthPersonBinding(database, { userId })).status).toBe('quarantined');
    expect((await connection`SELECT count(*)::int AS n FROM identity.link_conflict WHERE subject=${userId}`)[0]!.n).toBe(conflicts);
    expect((await provisionAuthPerson(database, { userId })).status).toBe('quarantined');
    expect(JSON.stringify(await connection`SELECT to_jsonb(b) AS row FROM identity.auth_binding b WHERE subject=${userId}`)).toBe(original);
    expect(JSON.stringify(await connection`SELECT to_jsonb(p) AS row FROM mlm.person p WHERE id=${created.personId!}`)).toBe(person);
  } finally { await connection`DELETE FROM mlm.blacklist WHERE email_norm=${email}`; }
  expect(await getAuthPersonBinding(database, { userId })).toEqual({ ...created, status: 'existing' });
});

integration('a blacklist added after signup prevents new person creation and binding after email proof', async () => {
  const userId = 'newly-denied-user', email = 'newly-denied@example.test';
  await connection`INSERT INTO auth.user(id,email,email_verified,name) VALUES(${userId},${email},true,'Newly Denied Member')`;
  await connection`INSERT INTO mlm.blacklist(email_norm) VALUES(${email})`;
  try {
    expect((await provisionAuthPerson(database, { userId })).status).toBe('quarantined');
    expect((await connection`SELECT count(*)::int AS n FROM mlm.person WHERE email=${email}`)[0]!.n).toBe(0);
    expect((await connection`SELECT count(*)::int AS n FROM identity.auth_binding WHERE subject=${userId}`)[0]!.n).toBe(0);
  } finally { await connection`DELETE FROM mlm.blacklist WHERE email_norm=${email}`; }
});

// Simulate an administrative policy change after the binding INSERT but before
// its canonical read. The immutable binding stays intact; it grants no authority.
function restrictBeforeCanonicalRead(email: string): IdentityDatabase {
  return { transaction: (callback: (tx: IdentityTransaction) => unknown) => database.transaction(async tx => {
    const wrapped = { execute: async (query: SQL) => {
      const result = await tx.execute(query);
      if (new PgDialect().sqlToQuery(query).sql.startsWith('INSERT INTO identity.auth_binding')) {
        await tx.execute(sql`INSERT INTO mlm.blacklist(email_norm) VALUES(${email})`);
      }
      return result;
    } } as unknown as IdentityTransaction;
    return callback(wrapped);
  }) } as unknown as IdentityDatabase;
}

integration('a late eligibility denial cannot be relabelled as successful new-person provisioning', async () => {
  const userId = 'late-new-denial-user', email = 'late-new-denial@example.test';
  await connection`INSERT INTO auth.user(id,email,email_verified,name) VALUES(${userId},${email},true,'Late Denial Fixture')`;
  try {
    expect((await provisionAuthPerson(restrictBeforeCanonicalRead(email), { userId })).status).toBe('quarantined');
    expect((await getAuthPersonBinding(database, { userId })).status).toBe('quarantined');
    expect((await connection`SELECT count(*)::int AS n FROM identity.auth_binding WHERE subject=${userId}`)[0]!.n).toBe(1);
  } finally { await connection`DELETE FROM mlm.blacklist WHERE email_norm=${email}`; }
});

integration('missing eligibility SELECT privileges fail closed before any legacy binding or JWT authority can be produced', async () => {
  const userId = 'no-policy-read-user', email = 'no-policy-read@example.test';
  await connection`INSERT INTO auth.user(id,email,email_verified) VALUES(${userId},${email},true)`;
  await connection`INSERT INTO mlm.person(first_name,last_name,email,phone_number,status) VALUES('No Policy','Read',${email},'0','active')`;
  await connection.unsafe('REVOKE SELECT(email_norm,phone_last10,name_norm,birthdate) ON mlm.blacklist FROM verified_email_restricted');
  const restricted = { transaction: (callback: (tx: unknown) => unknown) => database.transaction(async tx => {
    await tx.execute(sql`SET LOCAL ROLE verified_email_restricted`); return callback(tx);
  }) } as unknown as IdentityDatabase;
  try {
    await expect(provisionAuthPerson(restricted, { userId })).rejects.toBeDefined();
    await expect(database.transaction(async tx => {
      await tx.execute(sql`SET LOCAL ROLE verified_email_restricted`); return getAuthPersonBinding(tx, { userId });
    })).rejects.toBeDefined();
    expect((await connection`SELECT count(*)::int AS n FROM identity.auth_binding WHERE subject=${userId}`)[0]!.n).toBe(0);
    expect((await connection`SELECT user_id FROM mlm.person WHERE email=${email}`)[0]!.user_id).toBeNull();
  } finally {
    await connection.unsafe('GRANT SELECT(email_norm,phone_last10,name_norm,birthdate) ON mlm.blacklist TO verified_email_restricted');
  }
});

integration('concurrent provisioning uses one person and never turns a case-variant auth email into a second claim', async () => {
  await connection`INSERT INTO auth.user(id,email,email_verified,name) VALUES('concurrent-user','concurrent@example.test',true,'Concurrent Fixture'),('case-user','NEW@example.test',true,'Case Fixture')`;
  const results = await Promise.all(Array.from({ length: 4 }, () => provisionAuthPerson(database, { userId: 'concurrent-user' })));
  expect(new Set(results.map(result => result.publicId)).size).toBe(1);
  expect(results.filter(result => result.status === 'created')).toHaveLength(1);
  expect((await connection`SELECT count(*)::int AS n FROM mlm.person WHERE user_id='concurrent-user'`)[0]!.n).toBe(1);
  expect((await provisionAuthPerson(database, { userId: 'case-user' })).status).toBe('quarantined');
  expect((await getAuthPersonBinding(database, { userId: 'case-user' })).status).toBe('quarantined');
  expect((await connection`SELECT count(*)::int AS n FROM mlm.person WHERE email='new@example.test'`)[0]!.n).toBe(1);
});

integration('legacy linking requires a distinct approved operator, verified subject and a single-use hashed grant', async () => {
  const admin = await provisionAuthPerson(database, { userId: 'admin-user' });
  await connection`UPDATE mlm.person SET is_admin=true WHERE id=${admin.personId!}`;
  await expect(approveLegacyClaim(database, { approverUserId: 'new-user', userId: 'legacy-user', personPublicId: legacyPublicId, kind: 'approved_claim' })).rejects.toBeDefined();
  const grant = await approveLegacyClaim(database, { approverUserId: 'admin-user', userId: 'legacy-user', personPublicId: legacyPublicId, kind: 'single_use_invite' });
  grantToken = grant.token;
  expect((await connection`SELECT token_hash FROM identity.legacy_claim_grant WHERE id=${grant.grantId}`)[0]!.token_hash).not.toBe(grantToken);
  expect((await claimLegacyPerson(database, { userId: 'other-user', token: grantToken })).status).toBe('quarantined');
  const linked = await claimLegacyPerson(database, { userId: 'legacy-user', token: grantToken });
  expect(linked.status).toBe('existing'); expect(linked.personId).toBe('1'); expect(linked.publicId).toBe(legacyPublicId);
  expect((await connection`SELECT consumed_at IS NOT NULL AS consumed FROM identity.legacy_claim_grant WHERE id=${grant.grantId}`)[0]!.consumed).toBe(true);
  expect(await claimLegacyPerson(database, { userId: 'legacy-user', token: grantToken })).toEqual(linked);
  expect(JSON.stringify(await connection`SELECT to_jsonb(a) AS row FROM mlm.affiliate a ORDER BY id`)).toBe(fingerprint);
});

for (const [index, kind] of ['affiliate', 'blacklist'].entries()) integration(`reviewed claims respect ${kind} restrictions before approval and after grant creation`, async () => {
  const userId = `restricted-claim-${index}`, email = `${userId}@example.test`;
  await connection`INSERT INTO auth.user(id,email,email_verified,name) VALUES(${userId},${email},true,'Restricted Claim Fixture')`;
  const [person] = await connection`INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,is_admin)
    VALUES('Restricted','Claim',${email},'0','active',true) RETURNING id::text,public_id::text`;
  if (kind === 'affiliate') await connection`INSERT INTO mlm.affiliate(id,person_id,path,status) VALUES(${950 + index},${person!.id},${'n' + (950 + index)},'active')`;
  const restrict = async (blocked: boolean) => {
    if (kind === 'affiliate') await connection`UPDATE mlm.affiliate SET status=${blocked ? 'suspended' : 'active'} WHERE id=${950 + index}`;
    else if (blocked) await connection`INSERT INTO mlm.blacklist(email_norm) VALUES(${email})`;
    else await connection`DELETE FROM mlm.blacklist WHERE email_norm=${email}`;
  };
  const input = { approverUserId: 'admin-user', userId, personPublicId: person!.public_id, kind: 'approved_claim' as const };
  try {
    await restrict(true);
    await expect(approveLegacyClaim(database, input)).rejects.toBeDefined();
    expect((await connection`SELECT count(*)::int AS n FROM identity.legacy_claim_grant WHERE subject=${userId}`)[0]!.n).toBe(0);
    await restrict(false);
    const grant = await approveLegacyClaim(database, input);
    await restrict(true);
    expect((await claimLegacyPerson(database, { userId, token: grant.token })).status).toBe('quarantined');
    expect((await connection`SELECT consumed_at FROM identity.legacy_claim_grant WHERE id=${grant.grantId}`)[0]!.consumed_at).toBeNull();
    expect((await connection`SELECT count(*)::int AS n FROM identity.auth_binding WHERE subject=${userId}`)[0]!.n).toBe(0);
    expect((await connection`SELECT user_id FROM mlm.person WHERE id=${person!.id}`)[0]!.user_id).toBeNull();
    await restrict(false);
    const linked = await claimLegacyPerson(database, { userId, token: grant.token });
    expect(linked.status).toBe('existing');
    expect(await claimLegacyPerson(database, { userId, token: grant.token })).toEqual(linked);
  } finally {
    await restrict(false);
    if (kind === 'affiliate') await connection`DELETE FROM mlm.affiliate WHERE id=${950 + index}`;
  }
});

integration('a reviewed grant remains unconsumed when the final canonical read discovers a late restriction', async () => {
  const userId = 'late-claim-denial-user', email = 'late-claim-denial@example.test';
  await connection`INSERT INTO auth.user(id,email,email_verified,name) VALUES(${userId},${email},true,'Late Claim Fixture')`;
  const [person] = await connection`INSERT INTO mlm.person(first_name,last_name,email,phone_number,status,is_admin)
    VALUES('Late','Claim',${email},'0','active',true) RETURNING public_id::text`;
  const grant = await approveLegacyClaim(database, { approverUserId: 'admin-user', userId, personPublicId: person!.public_id, kind: 'approved_claim' });
  try {
    expect((await claimLegacyPerson(restrictBeforeCanonicalRead(email), { userId, token: grant.token })).status).toBe('quarantined');
    expect((await connection`SELECT consumed_at FROM identity.legacy_claim_grant WHERE id=${grant.grantId}`)[0]!.consumed_at).toBeNull();
    expect((await getAuthPersonBinding(database, { userId })).status).toBe('quarantined');
    expect((await connection`SELECT count(*)::int AS n FROM identity.auth_binding WHERE subject=${userId}`)[0]!.n).toBe(1);
  } finally { await connection`DELETE FROM mlm.blacklist WHERE email_norm=${email}`; }
});

integration('OAuth subjects are unique, Stripe customers are account/mode scoped and conflicts never reassign people', async () => {
  await provisionAuthPerson(database, { userId: 'other-user' });
  await connection`INSERT INTO auth.account(id,user_id,account_id,provider_id) VALUES('oauth-one','new-user','synthetic-provider-subject','google')`;
  await expect(connection`INSERT INTO auth.account(id,user_id,account_id,provider_id) VALUES('oauth-two','other-user','synthetic-provider-subject','google')`).rejects.toBeDefined();
  const input = { userId: 'new-user', accountId: 'acct_syntheticA', customerId: 'cus_syntheticA', livemode: false };
  expect((await bindStripeCustomer(database, input)).status).toBe('created');
  expect((await bindStripeCustomer(database, input)).status).toBe('existing');
  expect((await bindStripeCustomer(database, { ...input, userId: 'other-user' })).status).toBe('quarantined');
  expect((await bindStripeCustomer(database, { ...input, userId: 'other-user', livemode: true })).status).toBe('created');
  expect((await bindStripeCustomer(database, { ...input, userId: 'other-user', accountId: 'acct_syntheticB' })).status).toBe('created');
  expect((await bindStripeCustomer(database, { ...input, customerId: 'cus_different' })).status).toBe('quarantined');
  expect((await connection`SELECT count(*)::int AS n FROM identity.stripe_customer`)[0]!.n).toBe(3);
});

integration('expired, revoked or newly blocked legacy claims remain quarantined and unconsumed', async () => {
  await connection`INSERT INTO auth.user(id,email,email_verified) VALUES('expiring-user','expiring@example.test',true)`;
  const people = await connection`INSERT INTO mlm.person(first_name,last_name,email,phone_number,status) VALUES('Expiry','Fixture','expiring@example.test','0','active') RETURNING public_id::text`;
  const input = { approverUserId: 'admin-user', userId: 'expiring-user', personPublicId: people[0]!.public_id, kind: 'approved_claim' as const };
  const expired = await approveLegacyClaim(database, input);
  await connection`UPDATE identity.legacy_claim_grant SET expires_at=approved_at+interval '1 microsecond' WHERE id=${expired.grantId}`;
  expect((await claimLegacyPerson(database, { userId: input.userId, token: expired.token })).status).toBe('quarantined');
  const revoked = await approveLegacyClaim(database, input);
  await connection`UPDATE identity.legacy_claim_grant SET revoked_at=now() WHERE id=${revoked.grantId}`;
  expect((await claimLegacyPerson(database, { userId: input.userId, token: revoked.token })).status).toBe('quarantined');
  const blocked = await approveLegacyClaim(database, input);
  await connection`UPDATE mlm.person SET blacklisted=true WHERE public_id=${input.personPublicId}`;
  expect((await claimLegacyPerson(database, { userId: input.userId, token: blocked.token })).status).toBe('quarantined');
  expect((await connection`SELECT count(*)::int AS n FROM identity.auth_binding WHERE subject=${input.userId}`)[0]!.n).toBe(0);
  expect((await connection`SELECT count(*)::int AS n FROM identity.legacy_claim_grant WHERE subject=${input.userId} AND consumed_at IS NOT NULL`)[0]!.n).toBe(0);
});

integration('read resolver is write-free and changed verified emails are quarantined, not silently relinked', async () => {
  const before = await connection`SELECT count(*)::int AS n FROM identity.link_conflict`;
  expect((await getAuthPersonBinding(database, { userId: 'new-user' })).status).toBe('existing');
  await connection`UPDATE auth.user SET email='changed@example.test' WHERE id='new-user'`;
  expect((await getAuthPersonBinding(database, { userId: 'new-user' })).status).toBe('quarantined');
  expect((await connection`SELECT count(*)::int AS n FROM identity.link_conflict`)[0]!.n).toBe(before[0]!.n);
  expect((await provisionAuthPerson(database, { userId: 'new-user' })).status).toBe('quarantined');
  expect((await connection`SELECT email::text FROM mlm.person WHERE user_id='new-user'`)[0]!.email).toBe('new@example.test');
});

integration('a late binding collision rolls back person writes rather than leaving an orphan', async () => {
  const before = (await connection`SELECT count(*)::int AS n FROM mlm.person`)[0]!.n;
  await expect(connection.begin(async tx => {
    const [created] = await tx`INSERT INTO mlm.person(first_name,last_name,email,phone_number) VALUES('Rollback','Fixture','rollback@example.test','0') RETURNING id`;
    await tx`INSERT INTO identity.auth_binding(subject,person_id,link_method) VALUES('legacy-user',${created!.id},'new_registration')`;
  })).rejects.toBeDefined();
  expect((await connection`SELECT count(*)::int AS n FROM mlm.person`)[0]!.n).toBe(before);
});

integration('real Better Auth + Drizzle + PostgreSQL verifies email, binds identity, signs JWT and consumes hashed phone OTP once', async () => {
  const env: AuthEnvironment = {
    BETTER_AUTH_SECRET: 'synthetic-postgres-auth-secret-at-least-32-characters', BETTER_AUTH_URL: 'https://auth.example.test',
    BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test', BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
    BETTER_AUTH_PHONE_OTP_ENABLED: 'true', BETTER_AUTH_JWT_ENABLED: 'true', BETTER_AUTH_JWT_ISSUER: 'https://auth.example.test',
    BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY: 'true',
    BETTER_AUTH_JWT_AUDIENCE: 'synthetic-postgres-members', CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-not-a-real-key',
    CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001', AUTH_EMAIL_FROM: 'auth@example.test',
    SENTDM_API_KEY: 'synthetic-not-a-real-key', SENTDM_OTP_TEMPLATE_ID: '00000000-0000-4000-8000-000000000000', SENTDM_OTP_CHANNEL: 'sms',
  };
  const messages: EmailMessage[] = [];
  const phoneCodes: string[] = [];
  const delivery: AuthDelivery = { email: async message => { messages.push(message); }, phone: async (_phone, code) => { phoneCodes.push(code); } };
  const typedDatabase = drizzle(connection, { schema: authSchema });
  const auth = betterAuth(createAuthOptions(env, drizzleAdapter(typedDatabase, { provider: 'pg', schema: authSchema, usePlural: false }), {
    provision: userId => provisionAuthPerson(database, { userId }), binding: userId => getAuthPersonBinding(database, { userId }),
    registrationAllowed: async () => true,
  }, delivery));
  const request = (path: string, body?: unknown, cookie?: string) => auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin: 'https://portal.example.test',
      'content-type': 'application/json', 'x-forwarded-for': '192.0.2.44', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const email = 'postgres-auth-flow@example.test';
  const password = 'Synthetic-Postgres-Password-123';
  const signup = await request('/sign-up/email', { email, password, name: 'Postgres Fixture' });
  expect(signup.status).toBe(200);
  const signupBody = await signup.json() as { user: { id: string } };
  const userId = signupBody.user.id;
  expect((await connection`SELECT count(*)::int AS n FROM mlm.person WHERE email=${email}`)[0]!.n).toBe(0);
  const emailCode = /\b(\d{6})\b/.exec(messages.at(-1)!.text)?.[1];
  expect(emailCode).toBeDefined();
  const emailRecords = await connection`SELECT value FROM auth.verification WHERE identifier LIKE ${'email-verification-otp-' + email}`;
  expect(emailRecords).toHaveLength(1);
  expect(emailRecords[0]!.value).toMatch(/^[a-f0-9]{64}:0$/);
  expect(emailRecords[0]!.value).not.toContain(emailCode!);
  const verified = await request('/email-otp/verify-email', { email, otp: emailCode });
  expect(verified.status).toBe(200);
  expect((await request('/email-otp/verify-email', { email, otp: emailCode })).status).toBe(400);
  // Canonical proof revokes a credential planted before mailbox verification.
  // Continue with the native session issued AFTER proof, never that password.
  expect((await request('/sign-in/email', { email, password })).status).toBe(401);
  const cookie = verified.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  expect(cookie).toContain('better-auth.session_token=');
  const bound = await getAuthPersonBinding(database, { userId });
  expect(bound.status).toBe('existing'); expect(bound.publicId).toBeDefined();
  expect((await connection`SELECT count(*)::int AS n FROM identity.auth_binding WHERE subject=${userId}`)[0]!.n).toBe(1);
  const tokenResponse = await request('/token', undefined, cookie);
  expect(tokenResponse.status).toBe(200);
  const { token } = await tokenResponse.json() as { token: string };
  const jwks = await (await request('/jwks')).json() as Parameters<typeof createLocalJWKSet>[0];
  const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer: env.BETTER_AUTH_JWT_ISSUER, audience: env.BETTER_AUTH_JWT_AUDIENCE });
  expect(protectedHeader.alg).toBe('RS256'); expect(payload.sub).toBe(userId);
  expect(payload.person_public_id).toBe(bound.publicId); expect(payload.email_verified).toBe(true); expect(payload.email).toBe(email);
  expect((await connection`SELECT count(*)::int AS n FROM auth.jwks`)[0]!.n).toBe(1);
  expect(JSON.stringify(jwks)).not.toMatch(/private_key|privateKey/);
  const bindingBeforeRestriction = JSON.stringify(await connection`SELECT to_jsonb(b) AS row FROM identity.auth_binding b WHERE subject=${userId}`);
  await connection`INSERT INTO mlm.blacklist(email_norm) VALUES(${email})`;
  try {
    const restrictedToken = await request('/token', undefined, cookie);
    expect(restrictedToken.status).toBe(403);
    expect(await restrictedToken.text()).not.toContain('person_public_id');
    expect(JSON.stringify(await connection`SELECT to_jsonb(b) AS row FROM identity.auth_binding b WHERE subject=${userId}`)).toBe(bindingBeforeRestriction);
  } finally { await connection`DELETE FROM mlm.blacklist WHERE email_norm=${email}`; }
  const phone = '+12025550157';
  await connection`UPDATE auth.user SET phone_number=${phone} WHERE id=${userId}`;
  expect((await request('/phone-number/send-otp', { phoneNumber: phone, consent: true, consentVersion: 'sms-auth-v1' }, cookie)).status).toBe(200);
  const phoneCode = phoneCodes.at(-1)!;
  const phoneRecords = await connection`SELECT value FROM auth.verification WHERE identifier LIKE 'sms-opt-in:%'`;
  expect(phoneRecords).toHaveLength(1); expect(phoneRecords[0]!.value).toMatch(/^h1_[a-f0-9]{64}:0$/);
  expect(phoneRecords[0]!.value).not.toContain(phoneCode);
  const replays = await Promise.all([1, 2].map(() => request('/phone-number/verify', { phoneNumber: phone, code: phoneCode, disableSession: true, updatePhoneNumber: true }, cookie)));
  expect(replays.filter(response => response.status === 200)).toHaveLength(1);
  expect(replays.filter(response => response.status === 400)).toHaveLength(1);
  expect((await connection`SELECT count(*)::int AS n FROM auth.verification WHERE identifier LIKE 'sms-opt-in:%'`)[0]!.n).toBe(0);
  const consent = (await connection`SELECT consent_version,consented_at,verified_at,revoked_at FROM auth.sms_opt_in WHERE user_id=${userId}`)[0]!;
  expect(consent.consent_version).toBe('sms-auth-v1'); expect(Number.isFinite(new Date(consent.consented_at).getTime())).toBe(true);
  expect(Number.isFinite(new Date(consent.verified_at).getTime())).toBe(true); expect(consent.revoked_at).toBeNull();
  expect((await connection`SELECT phone_number_verified FROM auth.user WHERE id=${userId}`)[0]!.phone_number_verified).toBe(true);
  expect((await connection`SELECT count(*)::int AS n FROM auth.rate_limit`)[0]!.n).toBeGreaterThan(0);
  expect((await getAuthPersonBinding(database, { userId })).publicId).toBe(bound.publicId);
}, 30_000);

integration('two real PostgreSQL auth replicas cannot resurrect old phone OTP A or delete resend B through a delayed wrong retry', async () => {
  const env: AuthEnvironment = {
    BETTER_AUTH_SECRET: 'synthetic-replica-auth-secret-at-least-32-characters', BETTER_AUTH_URL: 'https://auth.example.test',
    BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test', BETTER_AUTH_PHONE_OTP_ENABLED: 'true',
    BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY: 'true', BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
    CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-not-a-real-key', CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001', AUTH_EMAIL_FROM: 'auth@example.test',
    SENTDM_API_KEY: 'synthetic-not-a-real-key', SENTDM_OTP_TEMPLATE_ID: '00000000-0000-4000-8000-000000000000', SENTDM_OTP_CHANNEL: 'sms',
  };
  const phone = '+12025550159';
  await connection`INSERT INTO auth.user(id,email,email_verified,name,phone_number) VALUES('replica-user','replica@example.test',true,'Replica Fixture',${phone})`;
  await provisionAuthPerson(database, { userId: 'replica-user' });
  const codes: string[] = [];
  const messages: EmailMessage[] = [];
  const delivery: AuthDelivery = { email: async message => { messages.push(message); }, phone: async (_phone, code) => { codes.push(code); } };
  let arrived!: () => void;
  let release!: () => void;
  const paused = new Promise<void>(resolve => { arrived = resolve; });
  const unpaused = new Promise<void>(resolve => { release = resolve; });
  let pauseNextWrongRetry = true;
  const typedDatabase = drizzle(connection, { schema: authSchema });
  const factory = drizzleAdapter(typedDatabase, { provider: 'pg', schema: authSchema, usePlural: false });
  const pausableFactory: typeof factory = options => new Proxy(factory(options), {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver);
      if (property !== 'incrementOne') return method;
      return async (input: { model: string; set?: { value?: string } }) => {
        if (pauseNextWrongRetry && input.model === 'verification' && /:1$/.test(input.set?.value ?? '')) {
          pauseNextWrongRetry = false; arrived(); await unpaused;
        }
        return Reflect.apply(method, target, [input]);
      };
    },
  });
  const identity = { provision: (userId: string) => provisionAuthPerson(database, { userId }), binding: (userId: string) => getAuthPersonBinding(database, { userId }), registrationAllowed: async () => true };
  const replicaA = betterAuth(createAuthOptions(env, pausableFactory, identity, delivery));
  const replicaB = betterAuth(createAuthOptions(env, factory, identity, delivery));
  let cookie = '';
  const request = (replica: typeof replicaA, path: string, body: unknown) => replica.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: 'POST', headers: { origin: 'https://portal.example.test', 'content-type': 'application/json',
      'x-forwarded-for': replica === replicaA ? '192.0.2.45' : '192.0.2.46', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
  expect((await request(replicaA, '/email-otp/send-verification-otp', { email: 'replica@example.test', type: 'sign-in' })).status).toBe(200);
  const loginOtp = /\b(\d{6})\b/.exec(messages.at(-1)!.text)![1]!;
  const login = await request(replicaA, '/sign-in/email-otp', { email: 'replica@example.test', otp: loginOtp });
  expect(login.status).toBe(200);
  cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const consentBody = { phoneNumber: phone, consent: true, consentVersion: 'sms-auth-v1' };
  const proof = (code: string) => ({ phoneNumber: phone, code, disableSession: true, updatePhoneNumber: true });
  expect((await request(replicaA, '/phone-number/send-otp', consentBody)).status).toBe(200);
  const firstCode = codes.at(-1)!;
  const wrongCode = firstCode === '000000' ? '111111' : '000000';
  const wrong = request(replicaA, '/phone-number/verify', proof(wrongCode));
  let newCode: string;
  try {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([paused, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('replica_retry_did_not_reach_CAS')), 5000); })]);
    } finally { clearTimeout(deadline); }
    // Simulated elapsed recipient cooldown, not a production bypass. Challenge A
    // remains present while replica B rotates to B in the actual adapter hook.
    for (let attempt = 0; attempt < 3; attempt++) {
      await connection`UPDATE auth.rate_limit SET last_request=${Date.now() - 1} WHERE key=${recipientBudgetKey(env.BETTER_AUTH_SECRET!, phone)}`;
      await connection`UPDATE auth.rate_limit SET last_request=${Date.now() - 1} WHERE key=${recipientBudgetKey(env.BETTER_AUTH_SECRET!, 'sms-user:replica-user')}`;
      expect((await request(replicaB, '/phone-number/send-otp', consentBody)).status).toBe(200);
      if (codes.at(-1) !== firstCode) break;
    }
    newCode = codes.at(-1)!;
    expect(newCode).not.toBe(firstCode);
  } finally { release(); }
  expect((await wrong).status).toBe(400);
  expect((await connection`SELECT count(*)::int AS n FROM auth.verification WHERE identifier LIKE 'sms-opt-in:%'`)[0]!.n).toBe(1);
  expect((await request(replicaA, '/phone-number/verify', proof(firstCode))).status).toBe(400);
  expect((await request(replicaB, '/phone-number/verify', proof(newCode!))).status).toBe(200);
  expect((await connection`SELECT count(*)::int AS n FROM auth.verification WHERE identifier LIKE 'sms-opt-in:%'`)[0]!.n).toBe(0);
}, 30_000);
