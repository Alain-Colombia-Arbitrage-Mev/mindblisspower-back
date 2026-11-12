import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { postgresAuthAdapter } from './postgres-auth-adapter';
import { createAuthOptions } from './options';
import { atomicEmailVerificationHandler, atomicEmailVerificationOptions } from './atomic-email-verification';
import { getAuthPersonBinding, provisionAuthPerson, type IdentityDatabase } from '../modules/identity';
import type { AuthEnvironment, EmailMessage } from './delivery';
import * as authSchema from '../db/schema/auth';
import * as mlmSchema from '../db/schema/mlm';
import * as identitySchema from '../db/schema/identity';

// Reuse the isolated contact/identity schema rehearsal. Never accept the host
// DATABASE_URL or an application writer, published port, or delivery credential.
const ownerURL = process.env.EMAIL_CONTACT_TEST_DATABASE_URL;
const authURL = process.env.EMAIL_CONTACT_AUTH_DATABASE_URL;
function syntheticURL(value: string | undefined, username: string) {
  const url = new URL(value || 'postgres://invalid');
  if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' || url.port !== '5432'
    || url.pathname !== '/email_contact_synthetic' || url.username !== username || url.search || url.hash) {
    throw new Error('Atomic verification requires the isolated synthetic PostgreSQL rehearsal');
  }
  return url.href;
}
const env: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-atomic-pg-verification-secret-at-least-32',
  BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
  BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'false',
  AUTH_EMAIL_PROVIDER: 'resend', AUTH_EMAIL_FROM: 'codes@example.test', RESEND_API_KEY: 'synthetic-only',
};
const cookies = (response: Response) => response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');

if (!ownerURL && !authURL) {
  test.skip('atomic PostgreSQL email verification requires test-email-contact-postgres.mjs --synthetic-docker --atomic-email-verification', () => {});
} else describe('atomic email verification with real PostgreSQL and transaction-bound identity', () => {
  const owner = postgres(syntheticURL(ownerURL, 'postgres'), { max: 2, prepare: false, onnotice() {} });
  const writer = postgres(syntheticURL(authURL, 'contact_auth_fixture'), { max: 1, prepare: false, onnotice() {},
    connection: { statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 8000 } });
  const schema = { ...authSchema, ...mlmSchema, ...identitySchema };
  const database = drizzle(writer, { schema });
  const originalFetch = globalThis.fetch;
  let providerCalls = 0, sequence = 0, requestIP = 0;
  beforeAll(async () => {
    globalThis.fetch = (() => { providerCalls++; throw new Error('Synthetic verification cannot call a provider'); }) as unknown as typeof fetch;
    await owner.unsafe(`CREATE TABLE auth.email_verification_test_fault(subject text PRIMARY KEY,mode text NOT NULL);
      GRANT SELECT ON auth.email_verification_test_fault TO mindbliss_auth_core_v1;
      CREATE FUNCTION auth.email_verification_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE fault text;
      BEGIN
        SELECT mode INTO fault FROM auth.email_verification_test_fault WHERE subject=NEW.user_id;
        IF (TG_WHEN='BEFORE' AND fault='session_insert') OR (TG_WHEN='AFTER' AND fault='session_commit') THEN
          RAISE EXCEPTION 'Synthetic private email verification session failure';
        END IF;
        IF TG_WHEN='AFTER' AND fault='session_hold' THEN
          PERFORM pg_advisory_xact_lock(708251,1);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER email_verification_session_insert BEFORE INSERT ON auth.session
        FOR EACH ROW EXECUTE FUNCTION auth.email_verification_test_reject();
      CREATE CONSTRAINT TRIGGER email_verification_session_commit AFTER INSERT ON auth.session
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION auth.email_verification_test_reject();`);
  });
  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await Promise.all([writer.end({ timeout: 2 }), owner.end({ timeout: 2 })]);
    expect(providerCalls).toBe(0);
  });

  async function fixture() {
    const email = `atomic-pg-verification-${++sequence}@example.test`, messages: EmailMessage[] = [];
    let failProvision = false, failAdministrative = false, abortedAfterProvision: AbortController | null = null;
    const delivery = { email: async (message: EmailMessage) => { messages.push(message); }, phone: async () => { throw new Error('No synthetic SMS'); } };
    const identity = (selected: IdentityDatabase) => ({
      provision: async (userId: string) => {
        const result = await provisionAuthPerson(selected, { userId });
        if (['created', 'existing'].includes(result.status)) {
          if (failProvision) throw new Error('Synthetic private identity provision failure');
          abortedAfterProvision?.abort();
        }
        return result;
      },
      binding: (userId: string) => getAuthPersonBinding(selected, { userId }),
      registrationAllowed: async () => true,
      // The production identity factory isolates optional allocation the same
      // way: a failed SQL statement rolls back a savepoint, not the whole proof.
      administrativeWallet: () => selected.transaction(async transaction => {
        await transaction.execute(failAdministrative ? sql`SELECT 1/0` : sql`SELECT 1`);
      }),
    });
    const options = (selected: typeof database | Parameters<Parameters<typeof database.transaction>[0]>[0]) =>
      createAuthOptions(env, postgresAuthAdapter(selected), identity(selected), delivery);
    const create = (selected = database) => {
      const ordinary = betterAuth(options(selected));
      return atomicEmailVerificationHandler(ordinary.handler, (state, work) => selected.transaction(async transaction => {
        await transaction.execute(sql`SET LOCAL lock_timeout='2s'`);
        await transaction.execute(sql`SET LOCAL statement_timeout='5s'`);
        await transaction.execute(sql`SET LOCAL idle_in_transaction_session_timeout='8s'`);
        return work(betterAuth(atomicEmailVerificationOptions(options(transaction), state)).handler);
      }));
    };
    const handler = create();
    const requestUsing = (selected: typeof handler, path: string, body?: unknown, cookie = '', signal?: AbortSignal) => selected(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal, headers: { origin: 'https://portal.example.test', 'content-type': 'application/json',
        'x-forwarded-for': `192.0.2.${++requestIP % 250 + 1}`, ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const request = (path: string, body?: unknown, cookie = '', signal?: AbortSignal) => requestUsing(handler, path, body, cookie, signal);
    const signup = await request('/sign-up/email', { email, name: 'Synthetic Atomic PG Member', password: 'Synthetic-Atomic-PG-Password-123' });
    expect(signup.status).toBe(200); expect(messages).toHaveLength(1); expect(signup.headers.has('set-cookie')).toBe(false);
    const [created] = await owner.unsafe<{ id: string }[]>('SELECT id FROM auth."user" WHERE email=$1', [email]);
    if (!created) throw new Error('Synthetic signup account missing');
    const id = created.id;
    const code = () => messages[0]!.template!.variables.OTP;
    const verify = (otp = code(), cookie = '', signal?: AbortSignal) => request('/email-otp/verify-email', { email, otp }, cookie, signal);
    const snapshot = async () => {
      type Snapshot = { verified: boolean; sessions: number; credentials: number; codes: number; people: number; bindings: number };
      const [row] = await owner.unsafe<Snapshot[]>(`SELECT u.email_verified AS verified,
        (SELECT count(*)::int FROM auth.session WHERE user_id=u.id) AS sessions,
        (SELECT count(*)::int FROM auth.account WHERE user_id=u.id) AS credentials,
        (SELECT count(*)::int FROM auth.verification WHERE identifier=$2) AS codes,
        (SELECT count(*)::int FROM mlm.person WHERE user_id=u.id) AS people,
        (SELECT count(*)::int FROM identity.auth_binding WHERE subject=u.id) AS bindings
        FROM auth."user" u WHERE u.id=$1`, [id, `email-verification-otp-${email}`]);
      if (!row) throw new Error('Synthetic verification account missing');
      return row;
    };
    const fault = (mode: string) => owner.unsafe('INSERT INTO auth.email_verification_test_fault(subject,mode) VALUES($1,$2) ON CONFLICT(subject) DO UPDATE SET mode=excluded.mode', [id, mode]);
    const clearFault = () => owner.unsafe('DELETE FROM auth.email_verification_test_fault WHERE subject=$1', [id]);
    return { id, email, messages, code, verify, request, requestUsing, create, snapshot, fault, clearFault,
      provisionFailure(value: boolean) { failProvision = value; }, administrativeFailure(value: boolean) { failAdministrative = value; },
      abortAfterProvision(controller: AbortController) { abortedAfterProvision = controller; } };
  }
  async function unavailable(response: Response) {
    expect(response.status).toBe(503); expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('set-auth-jwt')).toBe(false);
    expect(await response.json()).toEqual({ code: 'EMAIL_VERIFICATION_UNAVAILABLE', message: 'Email verification is temporarily unavailable' });
  }
  const pending = { verified: false, sessions: 0, credentials: 1, codes: 1, people: 0, bindings: 0 };
  const verified = { verified: true, sessions: 1, credentials: 0, codes: 0, people: 1, bindings: 1 };

  test('first correct registration code commits its same-connection identity and one session; replay cannot create another', async () => {
    const app = await fixture(); expect(await app.snapshot()).toEqual(pending);
    const response = await app.verify(); expect(response.status).toBe(200);
    expect(await app.snapshot()).toEqual(verified);
    expect(await (await app.request('/get-session', undefined, cookies(response))).json()).toMatchObject({ user: { id: app.id, email: app.email, emailVerified: true } });
    expect((await app.verify()).status).toBe(400); expect(await app.snapshot()).toEqual(verified); expect(app.messages).toHaveLength(1);
  });

  for (const mode of ['session_insert', 'session_commit'] as const) {
    test(`${mode} PostgreSQL failure rolls back consumed proof, credentials, person/binding and session before a manual same-code retry`, async () => {
      const app = await fixture(); await app.fault(mode);
      await unavailable(await app.verify()); expect(await app.snapshot()).toEqual(pending);
      await app.clearFault(); const success = await app.verify(); expect(success.status).toBe(200);
      expect(await app.snapshot()).toEqual(verified); expect(app.messages).toHaveLength(1);
    });
  }

  test('an identity failure after its real provisioning savepoint rolls back the business binding and preserves first proof', async () => {
    const app = await fixture(); app.provisionFailure(true);
    await unavailable(await app.verify()); expect(await app.snapshot()).toEqual(pending);
    app.provisionFailure(false); expect((await app.verify()).status).toBe(200);
    expect(await app.snapshot()).toEqual(verified); expect(app.messages).toHaveLength(1);
  });

  test('an optional administrative SQL error is isolated and cannot poison the successful native proof transaction', async () => {
    const app = await fixture(); app.administrativeFailure(true);
    expect((await app.verify()).status).toBe(200); expect(await app.snapshot()).toEqual(verified);
    expect(app.messages).toHaveLength(1);
  });

  test('a client abort after real provisioning rolls back correct proof instead of committing a session without its browser', async () => {
    const app = await fixture(), controller = new AbortController(); app.abortAfterProvision(controller);
    await unavailable(await app.verify(app.code(), '', controller.signal)); expect(await app.snapshot()).toEqual(pending);
    expect((await app.verify()).status).toBe(200); expect(await app.snapshot()).toEqual(verified);
  });

  test('three wrong attempts commit across native instances; correct code cannot bypass the lockout', async () => {
    const app = await fixture(); const wrong = app.code() === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await app.verify(wrong)).status).toBe(400);
      const [row] = await owner.unsafe('SELECT split_part(value,\':\',2)::int AS attempts FROM auth.verification WHERE identifier=$1', [`email-verification-otp-${app.email}`]);
      expect(row?.attempts).toBe(attempt); expect(await app.snapshot()).toEqual(pending);
    }
    const response = await app.verify(); expect(response.status).toBe(403); expect(response.headers.has('set-cookie')).toBe(false);
    expect((await app.snapshot()).verified).toBe(false); expect((await app.snapshot()).sessions).toBe(0);
  });

  test('another member session or forged cookie cannot substitute for a proof belonging to the requested address', async () => {
    const first = await fixture(), second = await fixture();
    const secondResponse = await second.verify(); expect(secondResponse.status).toBe(200);
    const secondCookie = cookies(secondResponse);
    const denied = await first.request('/email-otp/verify-email', { email: 'missing-owner@example.test', otp: first.code() }, secondCookie);
    expect(denied.status).toBe(400); expect(denied.headers.has('set-cookie')).toBe(false); expect(await first.snapshot()).toEqual(pending);
    const wrong = first.code() === '000000' ? '111111' : '000000';
    const forged = await first.verify(wrong, '__Secure-better-auth.session_token=synthetic-forged-cookie');
    expect(forged.status).toBe(400); expect(forged.headers.has('set-cookie')).toBe(false); expect(await first.snapshot()).toEqual(pending);
    const correct = await first.verify(first.code(), secondCookie); expect(correct.status).toBe(200);
    expect((await correct.json() as { user: { id: string } }).user.id).toBe(first.id);
    expect(await first.snapshot()).toEqual(verified); expect(await second.snapshot()).toEqual(verified);
    expect(await (await second.request('/get-session', undefined, secondCookie)).json()).toMatchObject({ user: { id: second.id } });
  });

  test('concurrent correct verification on two bounded writer pools creates exactly one session', async () => {
    const app = await fixture();
    const otherWriter = postgres(syntheticURL(authURL, 'contact_auth_fixture'), { max: 1, prepare: false, onnotice() {},
      connection: { statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 8000 } });
    try {
      const other = app.create(drizzle(otherWriter, { schema }));
      const responses = await Promise.all([app.verify(), app.requestUsing(other, '/email-otp/verify-email', { email: app.email, otp: app.code() })]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
      expect(responses.filter(response => response.headers.has('set-cookie'))).toHaveLength(1);
      expect(await app.snapshot()).toEqual(verified); expect(app.messages).toHaveLength(1);
    } finally { await otherWriter.end({ timeout: 2 }); }
  });

  test('no successful response or cookie is released while PostgreSQL COMMIT is still blocked', async () => {
    const app = await fixture(); await app.fault('session_hold');
    let lockReady!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { lockReady = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = owner.begin(async transaction => {
      await transaction.unsafe('SELECT pg_advisory_xact_lock(708251,1)'); lockReady(); await gate;
    });
    await ready;
    let returned = false;
    const pending = app.verify().then(response => { returned = true; return response; });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await owner.unsafe("SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND usename='contact_auth_fixture' AND wait_event='advisory'");
        if (row && row.waiting > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      expect(waiting).toBe(true); expect(returned).toBe(false);
    } finally { release(); await holder; }
    const response = await pending; expect(response.status).toBe(200);
    expect(response.headers.has('set-cookie')).toBe(true); expect(await app.snapshot()).toEqual(verified);
  });
});
