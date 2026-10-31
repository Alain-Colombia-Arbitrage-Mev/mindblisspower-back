import { expect, test } from 'bun:test';
import type { DBAdapter } from '@better-auth/core/db/adapter';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { hashPassword } from 'better-auth/crypto';
import { createAuthOptions } from './options';
import type { AuthEnvironment, EmailMessage } from './delivery';
import { recipientBudgetKey } from './phone-otp';

// All accounts, credentials, IPs and messages are synthetic. The real Better
// Auth handler and rate-limit adapter run without sockets or production data.
const env: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-login-registration-secret-at-least-32-characters',
  BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
  BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'false',
  CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-not-real', CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001',
  AUTH_EMAIL_FROM: 'auth@example.test',
};
const email = 'registration-redirect@example.test';
const missing = 'missing-redirect@example.test';
const password = 'Synthetic-Registration-Password-123';

function fixture(lookupUnavailable = false) {
  const store: MemoryDB = {
    user: [{ id: 'synthetic-existing-access', name: 'Synthetic Existing User', email, emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() }], account: [], session: [], verification: [], rateLimit: [], jwks: [],
  };
  const messages: EmailMessage[] = [];
  const provisions: string[] = [];
  let lookups = 0;
  const memory = memoryAdapter(store);
  const adapter = (options: Parameters<typeof memory>[0]): DBAdapter => {
    const current = memory(options);
    return { ...current, findOne: async <T>(input: Parameters<DBAdapter['findOne']>[0]): Promise<T | null> => {
      if (input.model === 'user' && input.where?.some(condition => condition.field === 'email')) {
        lookups++;
        if (lookupUnavailable) throw new Error('synthetic-sensitive-account-database-failure');
      }
      return current.findOne<T>(input);
    } };
  };
  const create = () => betterAuth(createAuthOptions(env, adapter, {
    provision: async userId => { provisions.push(userId); return { status: 'claim_required' }; },
    binding: async () => ({ status: 'claim_required' }), registrationAllowed: async () => true,
  }, { email: async message => { messages.push(message); }, phone: async () => { throw new Error('Unexpected synthetic SMS'); } }));
  let auth = create();
  const request = (path: string, body: unknown, ip = '192.0.2.61', origin = 'https://portal.example.test') =>
    auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body),
    }));
  const send = (recipient = missing, ip?: string) => request('/email-otp/send-verification-otp', { email: recipient, type: 'sign-in' }, ip);
  return { store, messages, provisions, request, send, lookups: () => lookups, restart: () => { auth = create(); } };
}

test('unknown OTP login requires registration without reserving the immediate signup message budget', async () => {
  const app = fixture();
  const response = await app.send();
  expect(response.status).toBe(400);
  expect(await response.clone().json()).toEqual({ code: 'REGISTRATION_REQUIRED', message: 'Registration required' });
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(await response.text()).not.toContain(missing);
  expect(app.messages).toHaveLength(0);
  expect(app.store.user).toHaveLength(1);
  expect(app.store.account).toHaveLength(0);
  expect(app.store.verification).toHaveLength(0);
  expect(app.store.session).toHaveLength(0);
  expect(app.provisions).toHaveLength(0);
  expect(app.store.rateLimit!.some(row => row.key === recipientBudgetKey(env.BETTER_AUTH_SECRET!, missing))).toBe(false);
  expect(JSON.stringify(app.store.rateLimit)).not.toContain(missing);

  const signup = await app.request('/sign-up/email', { email: missing, name: 'Synthetic New Member', password });
  expect(signup.status).toBe(200);
  expect(app.messages).toHaveLength(1);
  expect(app.store.user).toHaveLength(2);
  expect(app.store.user!.find(row => row.email === missing)!.emailVerified).toBe(false);
  expect(app.store.session).toHaveLength(0);
  expect(app.store.verification).toHaveLength(1);
  expect(app.store.verification![0]!.identifier).toBe(`email-verification-otp-${missing}`);
  expect(signup.headers.has('set-cookie')).toBe(false);
});

test('unknown-login probe cooldown survives restart and another IP without blocking signup', async () => {
  const app = fixture();
  expect((await app.send()).status).toBe(400);
  app.restart();
  const repeated = await app.send(missing, '192.0.2.62');
  expect(repeated.status).toBe(429);
  expect(Number(repeated.headers.get('retry-after'))).toBeGreaterThanOrEqual(299);
  expect(await repeated.text()).not.toContain('REGISTRATION_REQUIRED');
  expect(app.messages).toHaveLength(0);
  expect((await app.request('/sign-up/email', { email: missing, name: 'Synthetic New Member', password }, '192.0.2.63')).status).toBe(200);
});

test('native IP limiter bounds different unknown-email probes before user lookup', async () => {
  const app = fixture();
  for (let index = 0; index < 5; index++) expect((await app.send(`unknown-${index}@example.test`)).status).toBe(400);
  const reads = app.lookups();
  const blocked = await app.send('unknown-6@example.test');
  expect(blocked.status).toBe(429);
  expect(app.lookups()).toBe(reads);
  expect(app.messages).toHaveLength(0);
  expect(app.store.verification).toHaveLength(0);
});

for (const verified of [true, false]) {
  test(`existing ${verified ? 'verified' : 'pending/unverified'} access still receives OTP without registration or network grants`, async () => {
    const app = fixture();
    app.store.user![0]!.emailVerified = verified;
    const response = await app.send(email);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('REGISTRATION_REQUIRED');
    expect(app.messages).toHaveLength(1);
    expect(app.store.user![0]!.emailVerified).toBe(verified);
    expect(app.store.session).toHaveLength(0);
    expect(app.provisions).toHaveLength(0);
    expect(app.store.verification).toHaveLength(1);
    expect((await app.send(email, '192.0.2.62')).status).toBe(429);
  });
}

test('lookup outage fails closed as sanitized503, never a registration redirect or a real message', async () => {
  for (const path of ['/email-otp/send-verification-otp', '/sign-in/email']) {
    const app = fixture(true);
    const response = await app.request(path, { email: missing, type: 'sign-in', password });
    expect(response.status).toBe(503);
    expect(await response.clone().json()).toEqual({ code: 'AUTH_ACCESS_LOOKUP_UNAVAILABLE', message: 'Authentication temporarily unavailable' });
    const body = await response.text();
    expect(body).not.toContain('REGISTRATION_REQUIRED');
    expect(body).not.toContain('synthetic-sensitive');
    expect(body).not.toContain(missing);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(app.messages).toHaveLength(0);
    expect(app.store.verification).toHaveLength(0);
    expect(app.store.session).toHaveLength(0);
    expect(app.provisions).toHaveLength(0);
  }
});

test('malformed login inputs never produce registration-required or send a code', async () => {
  for (const [path, body] of [
    ['/email-otp/send-verification-otp', { email: 'invalid', type: 'sign-in' }],
    ['/email-otp/send-verification-otp', { email: ` ${missing} `, type: 'sign-in' }],
    ['/email-otp/send-verification-otp', { email: 71, type: 'sign-in' }],
    ['/email-otp/send-verification-otp', { email: missing, type: 'invalid' }],
    ['/sign-in/email', { email: 'invalid', password }],
    ['/sign-in/email', { email: ` ${missing} `, password }],
    ['/sign-in/email', { email: missing }],
    ['/sign-in/email', { email: missing, password: '' }],
    ['/sign-in/email', { email: missing, password: 71 }],
  ] as const) {
    const app = fixture();
    const response = await app.request(path, body);
    expect([400, 401]).toContain(response.status);
    expect(await response.text()).not.toContain('REGISTRATION_REQUIRED');
    expect(app.messages).toHaveLength(0);
    expect(app.store.verification).toHaveLength(0);
    expect(app.store.session).toHaveLength(0);
  }
});

test('password login only redirects a genuinely missing account, never a wrong password or missing credential for an existing one', async () => {
  const app = fixture();
  const missingResponse = await app.request('/sign-in/email', { email: missing, password });
  expect(missingResponse.status).toBe(400);
  expect(await missingResponse.json()).toMatchObject({ code: 'REGISTRATION_REQUIRED' });
  const noCredential = await app.request('/sign-in/email', { email, password });
  expect(noCredential.status).toBe(401);
  expect(await noCredential.json()).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
  app.store.account!.push({ id: 'synthetic-existing-credential', userId: 'synthetic-existing-access',
    accountId: 'synthetic-existing-access', providerId: 'credential', password: await hashPassword(password),
    createdAt: new Date(), updatedAt: new Date() });
  const wrong = await app.request('/sign-in/email', { email, password: 'incorrect-synthetic-password' }, '192.0.2.62');
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toMatchObject({ code: 'INVALID_EMAIL_OR_PASSWORD' });
  const signedIn = await app.request('/sign-in/email', { email, password }, '192.0.2.63');
  expect(signedIn.status).toBe(200);
  expect(app.store.session).toHaveLength(1);
  expect(app.messages).toHaveLength(0);
});

test('password and OTP absence probes have separate persistent budgets but neither consumes the signup email budget', async () => {
  const app = fixture();
  expect((await app.send()).status).toBe(400);
  expect((await app.request('/sign-in/email', { email: missing, password })).status).toBe(400);
  expect((await app.request('/sign-in/email', { email: missing, password }, '192.0.2.62')).status).toBe(429);
  expect((await app.request('/sign-up/email', { email: missing, name: 'Synthetic New Member', password }, '192.0.2.63')).status).toBe(200);
  expect(app.messages).toHaveLength(1);
});

test('unknown password reset and verification stay generic, never registration-required', async () => {
  for (const type of ['forget-password', 'email-verification']) {
    const app = fixture();
    const response = await app.request('/email-otp/send-verification-otp', { email: missing, type });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('REGISTRATION_REQUIRED');
    expect(app.messages).toHaveLength(0);
    expect(app.store.user).toHaveLength(1);
    expect(app.store.session).toHaveLength(0);
  }
});
