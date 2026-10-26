import { beforeAll, afterAll, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createLocalJWKSet, jwtVerify } from 'jose';
import * as authSchema from '../../db/schema/auth';
import { createAuthOptions } from '../../auth/options';
import type { AuthDelivery, AuthEnvironment, EmailMessage } from '../../auth/delivery';
import { recipientBudgetKey } from '../../auth/phone-otp';
import { approveLegacyClaim, bindStripeCustomer, claimLegacyPerson, getAuthPersonBinding, provisionAuthPerson, type IdentityDatabase } from './index';

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

async function applyMigration() {
  const reserved = await connection.reserve();
  try { await reserved.unsafe(migration); }
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
  await connection.unsafe(`CREATE EXTENSION citext; CREATE EXTENSION ltree;
    CREATE ROLE app_read NOLOGIN; CREATE ROLE app_write NOLOGIN; CREATE ROLE app_admin NOLOGIN;
    CREATE SCHEMA auth; CREATE SCHEMA mlm;
    ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON TABLES TO app_read;
    CREATE TABLE auth.user(id text PRIMARY KEY,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,name text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TYPE mlm.person_status AS ENUM('pending','active','suspended','banned','deleted');
    CREATE TYPE mlm.kyc_status AS ENUM('not_started','in_review','approved','rejected','expired');
    CREATE TABLE mlm.person(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id text UNIQUE REFERENCES auth.user(id),legacy_id_person integer UNIQUE,
      first_name text NOT NULL,last_name text NOT NULL,email citext NOT NULL UNIQUE,phone_number text NOT NULL,status mlm.person_status NOT NULL DEFAULT 'pending',
      kyc_status mlm.kyc_status NOT NULL DEFAULT 'not_started',is_admin boolean NOT NULL DEFAULT false,blacklisted boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE mlm.rank(id smallint PRIMARY KEY,code text NOT NULL UNIQUE);
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,person_id bigint NOT NULL UNIQUE REFERENCES mlm.person(id),parent_id bigint REFERENCES mlm.affiliate(id),sponsor_id bigint REFERENCES mlm.affiliate(id),path ltree NOT NULL,current_rank_id smallint REFERENCES mlm.rank(id));
    INSERT INTO mlm.person(first_name,last_name,email,phone_number,status) VALUES('Legacy','Member','legacy@example.test','0','active');
    INSERT INTO mlm.rank VALUES(3,'SYNTHETIC'); INSERT INTO mlm.affiliate VALUES(71,1,NULL,NULL,'n71',3);`);
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
  const smsMigration = (await readFile(new URL('../../../../_meta/migration/75_sms_auth_opt_in.sql', import.meta.url), 'utf8'))
    .replace('REPLACE_WITH_CURATED_DATABASE', 'identity_synthetic');
  const smsConnection = await connection.reserve();
  try { await smsConnection.unsafe(smsMigration); }
  catch (error) { await smsConnection.unsafe('ROLLBACK'); throw error; }
  finally { smsConnection.release(); }
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

integration('verified signup is idempotent but an equal legacy email never claims or overwrites its person', async () => {
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
  expect((await request('/email-otp/verify-email', { email, otp: emailCode })).status).toBe(200);
  expect((await request('/email-otp/verify-email', { email, otp: emailCode })).status).toBe(400);
  const signedIn = await request('/sign-in/email', { email, password });
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
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
