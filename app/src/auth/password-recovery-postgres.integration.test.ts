import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { atomicPasswordResetHandler, atomicPasswordResetOptions } from './atomic-password-reset';
import { postgresAuthAdapter } from './postgres-auth-adapter';
import { createAuthOptions } from './options';
import type { AuthEnvironment, EmailMessage } from './delivery';

// Run only via test-password-recovery-postgres.mjs --synthetic-docker. These
// dedicated DSNs are never aliases of application/PlanetScale environment vars.
const ownerURL = process.env.PASSWORD_RECOVERY_TEST_DATABASE_URL;
const authURL = process.env.PASSWORD_RECOVERY_AUTH_DATABASE_URL;
function syntheticURL(value: string | undefined, username: string) {
  const url = new URL(value || 'postgres://invalid');
  if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' || url.port !== '5432'
    || url.pathname !== '/password_recovery_synthetic' || url.username !== username || url.search || url.hash) {
    throw new Error('Password recovery integration requires its isolated synthetic PostgreSQL harness');
  }
  return url.href;
}
const env: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-pg-recovery-secret-at-least-thirty-two-characters',
  BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
  BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'false',
  CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001', CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-not-real',
  AUTH_EMAIL_FROM: 'auth@example.test',
};
const oldPassword = 'Synthetic-Old-Recovery-Password-123';
const newPassword = 'Synthetic-New-Recovery-Password-123';

if (!ownerURL && !authURL) {
  test.skip('atomic PostgreSQL recovery requires test-password-recovery-postgres.mjs --synthetic-docker', () => {});
} else describe('atomic password reset against isolated PostgreSQL', () => {
  const owner = postgres(syntheticURL(ownerURL, 'postgres'), { max: 2, prepare: false, onnotice: () => {} });
  // One writer connection catches accidental global transactions whose identity
  // hooks or database rate limiter would otherwise wait for their own pool.
  const writer = postgres(syntheticURL(authURL, 'recovery_auth_fixture'), { max: 1, prepare: false,
    connection: { statement_timeout: 3000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000 }, onnotice: () => {} });
  const database = drizzle(writer);
  const previousFetch = globalThis.fetch;
  let providerCalls = 0;
  let sequence = 0;
  let requestIP = 0;
  beforeAll(() => { globalThis.fetch = (() => { providerCalls++; throw new Error('Synthetic recovery cannot call a provider'); }) as unknown as typeof fetch; });
  afterAll(async () => {
    globalThis.fetch = previousFetch;
    await Promise.all([writer.end({ timeout: 2 }), owner.end({ timeout: 2 })]);
    expect(providerCalls).toBe(0);
  });

  async function fixture(mode: 'missing' | 'existing' | 'empty' = 'existing', verified = false, lateClientError = false) {
    const id = `synthetic-recovery-pg-${++sequence}`;
    const email = `${id}@example.test`;
    await owner.unsafe('INSERT INTO auth."user"(id,email,email_verified,name) VALUES($1,$2,$3,$4)', [id, email, verified, 'Synthetic Recovery Member']);
    if (mode !== 'missing') await owner.unsafe('INSERT INTO auth.account(id,user_id,account_id,provider_id,password) VALUES($1,$2,$2,$3,$4)',
      [`${id}-credential`, id, 'credential', mode === 'empty' ? null : await hashPassword(oldPassword)]);
    const messages: EmailMessage[] = [];
    const provisioned: string[] = [];
    const identity = {
      provision: async (userId: string) => {
        // This is deliberately the same max:1 writer used by production hooks.
        // A global auth transaction would deadlock here during sign-in/signup.
        await writer.unsafe('SELECT id FROM auth."user" WHERE id=$1', [userId]);
        provisioned.push(userId); return { status: 'existing' };
      }, binding: async () => ({ status: 'claim_required' }), registrationAllowed: async () => true,
    };
    const delivery = { email: async (message: EmailMessage) => { messages.push(message); },
      phone: async () => { throw new Error('Synthetic recovery cannot send SMS'); } };
    const options = (db: Parameters<typeof postgresAuthAdapter>[0] = database, afterHash?: () => Promise<void>) => {
      const result = createAuthOptions(env, postgresAuthAdapter(db), identity, delivery);
      if (lateClientError || afterHash) result.emailAndPassword = { ...result.emailAndPassword!, onPasswordReset: async () => {
        await afterHash?.();
        if (lateClientError) throw new APIError('BAD_REQUEST', { message: 'Synthetic private hook after password update' });
      } };
      return result;
    };
    function create(selectedDatabase = database, afterHash?: () => Promise<void>) {
      const raw = betterAuth(options(selectedDatabase, afterHash));
      return atomicPasswordResetHandler(raw.handler, (state, work) => selectedDatabase.transaction(async tx => {
        const transactional = betterAuth(atomicPasswordResetOptions(options(tx, afterHash), state));
        return work(transactional.handler);
      }));
    }
    let handler = create();
    const requestUsing = async (selectedHandler: typeof handler, path: string, body?: unknown, cookie = '') => selectedHandler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { origin: 'https://portal.example.test', 'content-type': 'application/json',
        'x-forwarded-for': `192.0.2.${++requestIP % 250 + 1}`, ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const request = (path: string, body?: unknown, cookie = '') => requestUsing(handler, path, body, cookie);
    const send = () => request('/email-otp/request-password-reset', { email });
    const code = () => /\b([0-9]{6})\b/.exec(messages.at(-1)!.text)![1]!;
    const reset = (otp = code(), password = newPassword) => request('/email-otp/reset-password', { email, otp, password });
    const fault = (mode: string) => owner.unsafe('INSERT INTO auth.recovery_test_fault(user_id,mode) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode', [id, mode]);
    const clearFault = () => owner.unsafe('DELETE FROM auth.recovery_test_fault WHERE user_id=$1', [id]);
    const seedSession = async () => owner.unsafe('INSERT INTO auth.session(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval \'1 hour\')',
      [`${id}-standing-session`, id, `${id}-standing-token`]);
    const snapshot = async () => ({
      user: await owner.unsafe('SELECT id,email,email_verified,name FROM auth."user" WHERE id=$1', [id]),
      credential: await owner.unsafe('SELECT id,user_id,provider_id,account_id,password FROM auth.account WHERE user_id=$1 ORDER BY id', [id]),
      session: await owner.unsafe('SELECT id,user_id,token FROM auth.session WHERE user_id=$1 ORDER BY id', [id]),
      challenge: await owner.unsafe('SELECT id,identifier,value,expires_at FROM auth.verification WHERE identifier=$1 ORDER BY id', [`forget-password-otp-${email}`]),
    });
    const resetUsing = (selectedDatabase: typeof database, afterHash?: () => Promise<void>) => {
      const selectedHandler = create(selectedDatabase, afterHash);
      return (otp = code(), password = newPassword) => requestUsing(selectedHandler, '/email-otp/reset-password', { email, otp, password });
    };
    return { id, email, request, send, reset, resetUsing, code, messages, provisioned, fault, clearFault, seedSession, snapshot,
      restart: () => { handler = create(); } };
  }
  const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  async function noResetSession(response: Response) {
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('set-auth-jwt')).toBe(false);
    expect(await response.clone().json()).toEqual({ success: true });
  }

  for (const mode of ['missing', 'existing', 'empty'] as const) {
    test(`commits ${mode} password, proof and session revocation together without email/identity reassignment`, async () => {
      const app = await fixture(mode);
      await app.seedSession();
      expect((await app.send()).status).toBe(200);
      const before = await app.snapshot();
      const response = await app.reset();
      expect(response.status).toBe(200); await noResetSession(response);
      const after = await app.snapshot();
      expect([...after.user]).toEqual([{ ...before.user[0]!, email_verified: true }]);
      expect(after.credential).toHaveLength(1);
      expect(after.credential[0]).toMatchObject({ user_id: app.id, provider_id: 'credential', account_id: app.id });
      if (mode !== 'missing') expect(after.credential[0]!.id).toBe(before.credential[0]!.id);
      expect(await verifyPassword({ hash: String(after.credential[0]!.password), password: newPassword })).toBe(true);
      expect(await verifyPassword({ hash: String(after.credential[0]!.password), password: oldPassword })).toBe(false);
      expect(after.session).toHaveLength(0); expect(after.challenge).toHaveLength(0);
      expect(app.provisioned).toHaveLength(0); expect(app.messages).toHaveLength(1);
      expect((await app.reset()).status).toBe(400);
    });

    for (const failure of ['session_delete', 'email_proof', 'commit']) {
      test(`${failure} failure rolls back ${mode} credential, OTP, email proof and every prior session`, async () => {
        const app = await fixture(mode);
        await app.seedSession();
        expect((await app.send()).status).toBe(200);
        const before = await app.snapshot();
        await app.fault(failure);
        const response = await app.reset();
        expect(response.status).toBe(500);
        expect(response.headers.has('set-cookie')).toBe(false);
        expect(await response.text()).not.toContain('Synthetic private');
        expect(await app.snapshot()).toEqual(before);
        expect(app.provisioned).toHaveLength(0);
        await app.clearFault(); app.restart();
        // No resend, rate-limit deletion or replacement OTP is necessary after
        // a database failure: the original unspent challenge is restored.
        const retried = await app.reset();
        expect(retried.status).toBe(200); await noResetSession(retried);
        const recovered = await app.snapshot();
        expect(recovered.session).toHaveLength(0); expect(recovered.challenge).toHaveLength(0);
        expect(recovered.user[0]!.email).toBe(app.email); expect(recovered.user[0]!.email_verified).toBe(true);
        expect(await verifyPassword({ hash: String(recovered.credential[0]!.password), password: newPassword })).toBe(true);
        expect(app.messages).toHaveLength(1);
      });
    }
  }

  test('wrong OTP 4xx commits all three attempts across handler restarts instead of resetting its budget', async () => {
    const app = await fixture(); await app.seedSession(); expect((await app.send()).status).toBe(200);
    const before = await app.snapshot(); const correct = app.code(); const wrong = correct === '000000' ? '111111' : '000000';
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await app.reset(wrong)).status).toBe(400); app.restart();
      const current = await app.snapshot();
      expect(current.challenge).toHaveLength(1); expect(current.challenge[0]!.value).toMatch(new RegExp(`:${attempt}$`));
      expect(current.user).toEqual(before.user); expect(current.credential).toEqual(before.credential); expect(current.session).toEqual(before.session);
    }
    expect((await app.reset(correct)).status).toBe(403);
    expect((await app.snapshot()).challenge).toHaveLength(0);
    expect((await app.reset(correct)).status).toBe(400);
  });

  test('expired OTP rejection commits cleanup and never changes credential, proof or sessions', async () => {
    const app = await fixture(); await app.seedSession(); expect((await app.send()).status).toBe(200);
    await owner.unsafe('UPDATE auth.verification SET expires_at=now()-interval \'1 second\' WHERE identifier=$1', [`forget-password-otp-${app.email}`]);
    const before = await app.snapshot(); expect((await app.reset()).status).toBe(400);
    const after = await app.snapshot(); expect(after.challenge).toHaveLength(0);
    expect(after.user).toEqual(before.user); expect(after.credential).toEqual(before.credential); expect(after.session).toEqual(before.session);
  });

  test('a client-looking error from an existing post-hash hook rolls back rather than committing the new password', async () => {
    const app = await fixture('existing', false, true); await app.seedSession(); expect((await app.send()).status).toBe(200);
    const before = await app.snapshot(); const response = await app.reset();
    expect(response.status).toBe(500); expect(response.headers.has('set-cookie')).toBe(false);
    expect(await response.text()).not.toContain('Synthetic private');
    expect(await app.snapshot()).toEqual(before);
  });

  test('concurrent replay across handler instances commits exactly one reset', async () => {
    const app = await fixture(); await app.seedSession(); expect((await app.send()).status).toBe(200);
    const first = app.reset(); app.restart();
    const responses = await Promise.all([first, app.reset()]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
    const current = await app.snapshot(); expect(current.credential).toHaveLength(1); expect(current.challenge).toHaveLength(0); expect(current.session).toHaveLength(0);
  });

  test('two independent writer pools overlap on the same OTP and only the committed winner can change the password', async () => {
    const connection = { statement_timeout: 5000, lock_timeout: 4000, idle_in_transaction_session_timeout: 8000 };
    const firstWriter = postgres(syntheticURL(authURL, 'recovery_auth_fixture'), { max: 1, prepare: false, onnotice: () => {},
      connection: { ...connection, application_name: 'synthetic-recovery-race-a' } });
    const secondWriter = postgres(syntheticURL(authURL, 'recovery_auth_fixture'), { max: 1, prepare: false, onnotice: () => {},
      connection: { ...connection, application_name: 'synthetic-recovery-race-b' } });
    let releaseFirst!: () => void;
    let reachedFirstHash!: () => void;
    const holdFirst = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstHashReached = new Promise<void>(resolve => { reachedFirstHash = resolve; });
    let firstHashUpdates = 0; let secondHashUpdates = 0;
    let firstResponse: Promise<Response> | undefined; let secondResponse: Promise<Response> | undefined;
    try {
      const app = await fixture(); await app.seedSession(); expect((await app.send()).status).toBe(200);
      const before = await app.snapshot();
      const winnerPassword = 'Synthetic-Race-Winner-Password-123';
      const loserPassword = 'Synthetic-Race-Loser-Password-123';
      const firstReset = app.resetUsing(drizzle(firstWriter), async () => {
        firstHashUpdates++; reachedFirstHash(); await holdFirst;
      });
      const secondReset = app.resetUsing(drizzle(secondWriter), async () => { secondHashUpdates++; });
      firstResponse = firstReset(app.code(), winnerPassword);
      await Promise.race([firstHashReached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Synthetic race did not reach its first hash gate')), 2500))]);
      // Other connections cannot see uncommitted hash/OTP/proof/session writes.
      expect(await app.snapshot()).toEqual(before);
      secondResponse = secondReset(app.code(), loserPassword);
      let overlapping = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const activity = await owner.unsafe("SELECT pid,wait_event_type FROM pg_stat_activity WHERE application_name=$1 AND state='active'", ['synthetic-recovery-race-b']);
        if (activity.some(row => row.wait_event_type === 'Lock')) { overlapping = true; break; }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      expect(overlapping).toBe(true);
      expect(firstHashUpdates).toBe(1); expect(secondHashUpdates).toBe(0);
      releaseFirst();
      const [winner, loser] = await Promise.all([firstResponse, secondResponse]);
      expect(winner.status).toBe(200); await noResetSession(winner);
      expect(loser.status).toBe(400); expect(loser.headers.has('set-cookie')).toBe(false);
      expect(firstHashUpdates).toBe(1); expect(secondHashUpdates).toBe(0);
      const after = await app.snapshot();
      expect(after.credential).toHaveLength(1); expect(after.credential[0]!.id).toBe(before.credential[0]!.id);
      expect(await verifyPassword({ hash: String(after.credential[0]!.password), password: winnerPassword })).toBe(true);
      expect(await verifyPassword({ hash: String(after.credential[0]!.password), password: loserPassword })).toBe(false);
      expect(await verifyPassword({ hash: String(after.credential[0]!.password), password: oldPassword })).toBe(false);
      expect(after.user[0]!.email).toBe(app.email); expect(after.user[0]!.email_verified).toBe(true);
      expect(after.challenge).toHaveLength(0); expect(after.session).toHaveLength(0);
      expect(app.messages).toHaveLength(1); expect(app.provisioned).toHaveLength(0);
    } finally {
      releaseFirst();
      await Promise.allSettled([firstResponse, secondResponse].filter((response): response is Promise<Response> => response !== undefined));
      await Promise.all([firstWriter.end({ timeout: 2 }), secondWriter.end({ timeout: 2 })]);
    }
  });

  test('real old native session cookies stop working, unrelated account stays signed in and login hooks do not deadlock max:1 pool', async () => {
    const app = await fixture('existing', true); const other = await fixture('existing', true);
    const login = async (email: string) => app.request('/sign-in/email', { email, password: oldPassword });
    const oldLogins = await Promise.all([login(app.email), login(app.email)]);
    for (const response of oldLogins) expect(response.status).toBe(200);
    const unrelatedLogin = await login(other.email); expect(unrelatedLogin.status).toBe(200);
    const unrelatedBefore = await other.snapshot();
    expect((await app.send()).status).toBe(200); expect((await app.reset()).status).toBe(200);
    app.restart();
    for (const response of oldLogins) {
      const session = await app.request('/get-session', undefined, cookies(response));
      expect(session.status).toBe(200); expect(await session.json()).toBeNull();
    }
    expect(await other.snapshot()).toEqual(unrelatedBefore);
    const otherSession = await app.request('/get-session', undefined, cookies(unrelatedLogin));
    expect(await otherSession.json()).toMatchObject({ user: { id: other.id, email: other.email } });
    expect((await login(app.email)).status).toBe(401);
    const replacementLogin = await app.request('/sign-in/email', { email: app.email, password: newPassword });
    expect(replacementLogin.status).toBe(200); expect(app.provisioned).toContain(app.id);
  });

  test('ordinary signup and email OTP proof remain outside the reset transaction and preserve max:1 identity hooks', async () => {
    const app = await fixture(); const email = `synthetic-signup-pg-${++sequence}@example.test`;
    const response = await app.request('/sign-up/email', { name: 'Synthetic New Member', email, password: oldPassword });
    expect(response.status).toBe(200); expect(response.headers.has('set-cookie')).toBe(false);
    const otp = app.code();
    const verified = await app.request('/email-otp/verify-email', { email, otp });
    expect(verified.status).toBe(200);
    expect(app.provisioned.length).toBeGreaterThan(0);
    const session = await app.request('/get-session', undefined, cookies(verified));
    expect(await session.json()).toMatchObject({ user: { email, emailVerified: true } });
    const credentials = await owner.unsafe('SELECT a.password FROM auth.account a JOIN auth."user" u ON u.id=a.user_id WHERE u.email=$1', [email]);
    expect(credentials.every(row => row.password === null)).toBe(true);
  });
});
