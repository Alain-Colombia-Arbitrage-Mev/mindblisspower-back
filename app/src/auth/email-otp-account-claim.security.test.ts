import { expect, test } from 'bun:test';
import type { DBAdapter } from '@better-auth/core/db/adapter';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { hashPassword } from 'better-auth/crypto';
import { createAuthOptions } from './options';
import type { AuthEnvironment, EmailMessage } from './delivery';

// Synthetic local regression for the pre-account takeover class discussed in
// Better Auth security/GHSA advisories. This is evidence about the INSTALLED
// 1.6.22 verify-email handler, not an assertion that a particular GHSA covers it.
// No provider, production credential, database socket or real message is used.
const email = 'synthetic-account-owner@example.test';
const attackerPassword = 'Synthetic-Unproven-Attacker-Password-123';
const ownerPassword = 'Synthetic-Claimed-Owner-Password-456';
const env: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-account-claim-secret-at-least-32-characters',
  BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
  BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'false',
  CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-not-a-real-provider-token',
  AUTH_EMAIL_FROM: 'auth@example.test',
};

function fixture(options: { cleanupFailure?: 'account' | 'session' } = {}) {
  const store: MemoryDB = { user: [], account: [], session: [], verification: [], rateLimit: [], jwks: [] };
  const messages: EmailMessage[] = [];
  const auth = betterAuth(createAuthOptions(env, (authOptions: Parameters<ReturnType<typeof memoryAdapter>>[0]) => {
    const adapter = memoryAdapter(store)(authOptions);
    const guarded: DBAdapter = { ...adapter,
      delete: async input => {
        if (options.cleanupFailure === 'account' && input.model === 'account') throw new Error('Synthetic private account cleanup failure');
        return adapter.delete(input);
      },
      deleteMany: async input => {
        if (options.cleanupFailure === 'session' && input.model === 'session') throw new Error('Synthetic private session cleanup failure');
        return adapter.deleteMany(input);
      },
    };
    return guarded;
  }, {
    registrationAllowed: async () => true,
    provision: async () => ({ status: 'claim_required' }), binding: async () => ({ status: 'claim_required' }),
  }, { email: async message => { messages.push(message); }, phone: async () => { throw new Error('Unexpected synthetic SMS'); } }));
  let ip = 10;
  const request = (path: string, body?: unknown, cookie = '') => auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin: 'https://portal.example.test', 'content-type': 'application/json',
      'x-forwarded-for': `192.0.2.${ip++}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const signup = (password: string) => request('/sign-up/email', { email, name: 'Synthetic Account', password });
  const code = () => messages.at(-1)!.template!.variables.OTP;
  // Only advance synthetic in-memory reservations/challenges instead of
  // waiting five minutes. Never use this operation on an application adapter.
  const advancePastCooldown = () => {
    for (const row of store.rateLimit!) row.lastRequest = Date.now() - 301_000;
    for (const row of store.verification!) row.expiresAt = new Date(Date.now() - 1000);
  };
  return { store, messages, request, signup, code, advancePastCooldown };
}
const cookies = (response: Response) => response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');

test('email verification cannot make an attacker-precreated password usable after a mailbox owner registers again', async () => {
  // Installed 1.6.22 verifyEmailOTP does not itself revoke an unproven
  // password. Our post-proof/pre-promotion callback applies the SAME public
  // native helper used by signInEmailOTP before its new session can be granted.
  const app = fixture();
  expect((await app.signup(attackerPassword)).status).toBe(200);
  app.advancePastCooldown();
  expect((await app.signup(ownerPassword)).status).toBe(409);
  expect((await app.request('/email-otp/send-verification-otp', { email, type: 'email-verification' })).status).toBe(200);
  expect((await app.request('/email-otp/verify-email', { email, otp: app.code() })).status).toBe(200);
  expect(app.store.account).toHaveLength(0);
  expect(app.store.session).toHaveLength(1);
  const attackerLogin = await app.request('/sign-in/email', { email, password: attackerPassword });
  expect(attackerLogin.status).toBe(401);
  expect(attackerLogin.headers.has('set-cookie')).toBe(false);
});

test('control: native email OTP sign-in removes an unproven pre-created password before granting the mailbox owner a session', async () => {
  const app = fixture();
  expect((await app.signup(attackerPassword)).status).toBe(200);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.account).toHaveLength(1);
  app.advancePastCooldown();
  expect((await app.request('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
  const ownerLogin = await app.request('/sign-in/email-otp', { email, otp: app.code() });
  expect(ownerLogin.status).toBe(200);
  expect(ownerLogin.headers.has('set-cookie')).toBe(true);
  expect(app.store.user![0]!.emailVerified).toBe(true);
  expect(app.store.account).toHaveLength(0);
  expect(app.store.session).toHaveLength(1);
  const attackerLogin = await app.request('/sign-in/email', { email, password: attackerPassword });
  expect(attackerLogin.status).toBe(401);
  expect(attackerLogin.headers.has('set-cookie')).toBe(false);
  expect(app.store.session).toHaveLength(1);
});

test('email proof invalidates standing unproven native session cookies but leaves another user and noncredential accounts intact', async () => {
  const app = fixture();
  expect((await app.signup(attackerPassword)).status).toBe(200);
  const owner = app.store.user![0]!;
  // Synthetic representation of sessions issued by an older/incorrect auth
  // policy. Native cookies are still used to prove actual invalidation.
  owner.emailVerified = true;
  const previous: string[] = [];
  for (let index = 0; index < 2; index++) {
    const signedIn = await app.request('/sign-in/email', { email, password: attackerPassword });
    expect(signedIn.status).toBe(200);
    previous.push(cookies(signedIn));
    expect(await (await app.request('/get-session', undefined, previous.at(-1))).json())
      .toMatchObject({ user: { id: owner.id } });
  }
  owner.emailVerified = false;
  const otherId = 'synthetic-unrelated-account-owner';
  const otherEmail = 'unrelated-account-owner@example.test';
  app.store.user!.push({ id: otherId, email: otherEmail, name: 'Synthetic Unrelated Account', emailVerified: true,
    createdAt: new Date(), updatedAt: new Date() });
  app.store.account!.push({ id: 'synthetic-unrelated-credential', userId: otherId, accountId: otherId,
    providerId: 'credential', password: await hashPassword(ownerPassword), createdAt: new Date(), updatedAt: new Date() });
  const otherLogin = await app.request('/sign-in/email', { email: otherEmail, password: ownerPassword });
  expect(otherLogin.status).toBe(200);
  const otherCookie = cookies(otherLogin);
  const externalAccount = { id: 'synthetic-preserved-oauth', userId: owner.id, accountId: 'synthetic-external-id',
    providerId: 'synthetic-oauth-provider', createdAt: new Date(), updatedAt: new Date() };
  app.store.account!.push(externalAccount);
  expect(app.store.session).toHaveLength(3);
  const verification = await app.request('/email-otp/verify-email', { email, otp: app.code() });
  expect(verification.status).toBe(200);
  expect(app.store.session).toHaveLength(2);
  expect(app.store.account!.filter(account => account.userId === owner.id)).toEqual([externalAccount]);
  for (const oldCookie of previous) expect(await (await app.request('/get-session', undefined, oldCookie)).json()).toBeNull();
  expect(await (await app.request('/get-session', undefined, otherCookie)).json()).toMatchObject({ user: { id: otherId } });
  expect(await (await app.request('/get-session', undefined, cookies(verification))).json())
    .toMatchObject({ user: { id: owner.id, emailVerified: true } });
  expect((await app.request('/sign-in/email', { email, password: attackerPassword })).status).toBe(401);
});

test('verification of an already verified account preserves its proven password and standing session', async () => {
  const app = fixture();
  expect((await app.signup(ownerPassword)).status).toBe(200);
  app.store.user![0]!.emailVerified = true;
  const originalAccount = { ...app.store.account![0]! };
  const login = await app.request('/sign-in/email', { email, password: ownerPassword });
  expect(login.status).toBe(200);
  const before = app.store.session!.map(session => session.id);
  const response = await app.request('/email-otp/verify-email', { email, otp: app.code() });
  expect(response.status).toBe(200);
  expect(app.store.account).toEqual([originalAccount]);
  expect(app.store.session).toHaveLength(2);
  for (const id of before) expect(app.store.session!.some(session => session.id === id)).toBe(true);
  expect(await (await app.request('/get-session', undefined, cookies(login))).json())
    .toMatchObject({ user: { emailVerified: true } });
  expect((await app.request('/sign-in/email', { email, password: ownerPassword })).status).toBe(200);
});

for (const invalid of ['wrong', 'expired'] as const) {
  test(`${invalid} email proof cannot clear an unproven credential or standing sessions`, async () => {
    const app = fixture();
    expect((await app.signup(attackerPassword)).status).toBe(200);
    const owner = app.store.user![0]!;
    app.store.session!.push({ id: 'synthetic-standing-unproven-session', userId: owner.id,
      token: 'synthetic-standing-unproven-token', expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date() });
    const originalAccount = { ...app.store.account![0]! };
    const originalSession = { ...app.store.session![0]! };
    const otp = invalid === 'wrong' ? (app.code() === '000000' ? '111111' : '000000') : app.code();
    if (invalid === 'expired') app.store.verification![0]!.expiresAt = new Date(Date.now() - 1000);
    const response = await app.request('/email-otp/verify-email', { email, otp });
    expect(response.status).toBe(400);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(app.store.user![0]!.emailVerified).toBe(false);
    expect(app.store.account).toEqual([originalAccount]);
    expect(app.store.session).toEqual([originalSession]);
  });
}

for (const cleanupFailure of ['account', 'session'] as const) {
  test(`${cleanupFailure} cleanup outage fails closed after proof without verified promotion or a new session`, async () => {
    const app = fixture({ cleanupFailure });
    expect((await app.signup(attackerPassword)).status).toBe(200);
    const owner = app.store.user![0]!;
    app.store.session!.push({ id: 'synthetic-standing-unproven-session', userId: owner.id,
      token: 'synthetic-standing-unproven-token', expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date() });
    const otp = app.code();
    const response = await app.request('/email-otp/verify-email', { email, otp });
    expect(response.status).toBe(500);
    expect(await response.clone().json()).toEqual({ message: 'Authentication temporarily unavailable' });
    const body = await response.text();
    expect(body).not.toContain('Synthetic private');
    expect(body).not.toContain(email);
    expect(body).not.toContain(otp);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(app.store.user![0]!.emailVerified).toBe(false);
    expect(app.store.session).toHaveLength(1);
    expect(app.store.session![0]!.id).toBe('synthetic-standing-unproven-session');
    // The adapter is intentionally nontransactional. Native proof is already
    // consumed; successful prior cleanup may remain, but promotion never does.
    expect(app.store.account).toHaveLength(cleanupFailure === 'account' ? 1 : 0);
    expect(app.store.verification).toHaveLength(0);
    expect((await app.request('/email-otp/verify-email', { email, otp })).status).toBe(400);
    expect(app.store.user![0]!.emailVerified).toBe(false);
    expect(app.store.session).toHaveLength(1);
  });
}
