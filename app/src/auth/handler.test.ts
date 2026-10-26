import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { createAuthOptions, type AuthIdentity } from './options';
import type { AuthDelivery, AuthEnvironment, EmailMessage } from './delivery';
import { consumePhoneOTP, otpHash } from './phone-otp';

const email = 'synthetic@example.test';
const phone = '+12025550123';
const env: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-auth-secret-with-at-least-32-characters', BETTER_AUTH_URL: 'https://auth.example.test',
  BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test', BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
  BETTER_AUTH_PHONE_OTP_ENABLED: 'true', BETTER_AUTH_JWT_ENABLED: 'true', BETTER_AUTH_JWT_ISSUER: 'https://auth.example.test',
  BETTER_AUTH_JWT_AUDIENCE: 'synthetic-members', CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-not-a-real-key',
  CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001', AUTH_EMAIL_FROM: 'auth@example.test',
  SENTDM_API_KEY: 'synthetic-not-a-real-key', SENTDM_OTP_TEMPLATE_ID: '00000000-0000-4000-8000-000000000000', SENTDM_OTP_CHANNEL: 'sms',
};

function fixture(emailVerified = true) {
  const store: MemoryDB = { user: [{ id: 'synthetic-user', email, emailVerified, name: 'Synthetic User',
    phoneNumber: phone, phoneNumberVerified: false, createdAt: new Date(), updatedAt: new Date() }],
  session: [], account: [], verification: [], rateLimit: [], jwks: [] };
  const messages: EmailMessage[] = [];
  const phoneCodes: string[] = [];
  const delivery: AuthDelivery = { email: async message => { messages.push(message); }, phone: async (_phone, code) => { phoneCodes.push(code); } };
  let bindingStatus = 'existing';
  let bindingEmail = email;
  let bindingFailed = false;
  const identity: AuthIdentity = {
    provision: async () => ({ status: emailVerified ? bindingStatus : 'verification_required' }),
    binding: async () => {
      if (bindingFailed) throw new Error('synthetic-sensitive-sql-and-token');
      return { status: bindingStatus, email: bindingEmail, publicId: '00000000-0000-4000-8000-000000000001' };
    },
  };
  const create = () => betterAuth(createAuthOptions(env, memoryAdapter(store), identity, delivery));
  let auth = create();
  const request = (path: string, body?: unknown, cookie?: string) => auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin: 'https://portal.example.test',
      'content-type': 'application/json', 'x-forwarded-for': '192.0.2.10', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { store, messages, phoneCodes, request, restart: () => { auth = create(); },
    quarantine: () => { bindingStatus = 'quarantined'; }, changeEmail: () => { bindingEmail = 'other@example.test'; },
    breakBinding: () => { bindingFailed = true; } };
}
const cookies = (response: Response) => response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');

test('real phone handler persists only HMAC, consumes once, and JWT has bound verified claims', async () => {
  const app = fixture();
  expect((await app.request('/phone-number/send-otp', { phoneNumber: phone })).status).toBe(200);
  const code = app.phoneCodes[0]!;
  expect(app.store.verification![0]!.value).toMatch(/^h1_[a-f0-9]{64}:0$/);
  expect(JSON.stringify(app.store.verification)).not.toContain(code);
  const verified = await app.request('/phone-number/verify', { phoneNumber: phone, code, disableSession: false });
  expect(verified.status).toBe(200);
  expect(app.store.verification).toHaveLength(0);
  expect((await app.request('/phone-number/verify', { phoneNumber: phone, code })).status).toBe(400);
  const tokenResponse = await app.request('/token', undefined, cookies(verified));
  expect(tokenResponse.status).toBe(200);
  expect(verified.headers.has('set-auth-jwt')).toBe(false);
  const { token } = await tokenResponse.json() as { token: string };
  const jwks = await (await app.request('/jwks')).json() as Parameters<typeof createLocalJWKSet>[0];
  const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer: env.BETTER_AUTH_JWT_ISSUER, audience: env.BETTER_AUTH_JWT_AUDIENCE });
  expect(protectedHeader.alg).toBe('RS256');
  expect(payload.sub).toBe('synthetic-user');
  expect(payload.email).toBe(email);
  expect(payload.email_verified).toBe(true);
  expect(payload.authVerified).toBe(true);
  expect(payload.person_public_id).toBe('00000000-0000-4000-8000-000000000001');
  expect(payload.exp! - payload.iat!).toBe(300);
  app.changeEmail();
  expect((await app.request('/token', undefined, cookies(verified))).status).toBe(403);
  app.breakBinding();
  const failed = await app.request('/token', undefined, cookies(verified));
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain('synthetic-sensitive');
  expect(JSON.stringify(jwks)).not.toContain('privateKey');
});

test('phone OTP attempt budget persists across handler restart and locks the correct code', async () => {
  const app = fixture();
  await app.request('/phone-number/send-otp', { phoneNumber: phone });
  const code = app.phoneCodes[0]!;
  const wrong = code === '000000' ? '111111' : '000000';
  expect((await app.request('/phone-number/verify', { phoneNumber: phone, code: wrong })).status).toBe(400);
  expect(app.store.verification![0]!.value).toMatch(/:1$/);
  app.restart();
  for (let attempt = 0; attempt < 2; attempt++) expect((await app.request('/phone-number/verify', { phoneNumber: phone, code: wrong })).status).toBe(400);
  expect((await app.request('/phone-number/verify', { phoneNumber: phone, code })).status).toBe(400);
  expect(app.store.verification).toHaveLength(0);
});

test('three concurrent phone failures spend all attempts of the same generation', async () => {
  const secret = env.BETTER_AUTH_SECRET!;
  type Challenge = { id: string; identifier: string; value: string; expiresAt: Date };
  let row: Challenge | null = { id: 'synthetic-concurrent-generation', identifier: phone,
    value: `h1_${otpHash(secret, `phone:${phone}`, '123456')}:0`, expiresAt: new Date(Date.now() + 300_000) };
  let initialReads = 0;
  let release!: () => void;
  const allRead = new Promise<void>(resolve => { release = resolve; });
  type Condition = { field: keyof Challenge; value: unknown; operator?: string };
  const matches = (where: Condition[]) => row !== null && where.every(condition => condition.operator === 'gt'
    ? (row![condition.field] as Date) > (condition.value as Date) : row![condition.field] === condition.value);
  const adapter = {
    findMany: async () => {
      const copy = row ? { ...row } : null;
      initialReads++;
      if (initialReads === 3) release();
      if (initialReads <= 3) await allRead;
      return copy ? [copy] : [];
    },
    findOne: async ({ where }: { where: Condition[] }) => matches(where) ? { ...row! } : null,
    incrementOne: async ({ where, set }: { where: Condition[]; set: { value: string } }) => {
      if (!matches(where)) return null;
      row = { ...row!, ...set };
      return { ...row };
    },
    consumeOne: async ({ where }: { where: Condition[] }) => {
      if (!matches(where)) return null;
      const consumed = row;
      row = null;
      return consumed;
    },
  };
  const ctx = { context: { adapter } } as unknown as NonNullable<Parameters<typeof consumePhoneOTP>[3]>;
  expect(await Promise.all(Array.from({ length: 3 }, () => consumePhoneOTP(secret, phone, '000000', ctx)))).toEqual([false, false, false]);
  expect(row).toBeNull();
  expect(await consumePhoneOTP(secret, phone, '123456', ctx)).toBe(false);
});

test('expired phone OTP and parallel replay are rejected by the real handler', async () => {
  const expired = fixture();
  await expired.request('/phone-number/send-otp', { phoneNumber: phone });
  expired.store.verification![0]!.expiresAt = new Date(Date.now() - 1000);
  expect((await expired.request('/phone-number/verify', { phoneNumber: phone, code: expired.phoneCodes[0] })).status).toBe(400);
  const app = fixture();
  await app.request('/phone-number/send-otp', { phoneNumber: phone });
  const responses = await Promise.all([1, 2].map(() => app.request('/phone-number/verify', { phoneNumber: phone, code: app.phoneCodes[0], disableSession: true })));
  expect(responses.filter(response => response.status === 200)).toHaveLength(1);
  expect(responses.filter(response => response.status === 400)).toHaveLength(1);
});

test('SMS proof never verifies an email, and unsafe phone-reset routes are not exposed', async () => {
  const app = fixture(false);
  await app.request('/phone-number/send-otp', { phoneNumber: phone });
  expect((await app.request('/phone-number/verify', { phoneNumber: phone, code: app.phoneCodes[0], disableSession: true })).status).toBe(200);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.user![0]!.phoneNumberVerified).toBe(true);
  expect(app.store.session).toHaveLength(0);
  expect((await app.request('/phone-number/request-password-reset', { phoneNumber: phone })).status).toBe(404);
  expect((await app.request('/phone-number/reset-password', { phoneNumber: phone, otp: '000000', newPassword: 'Synthetic-Password-123' })).status).toBe(404);
});

test('recipient cooldown survives handler restart and rejects resend before replacing OTP', async () => {
  const app = fixture();
  await app.request('/phone-number/send-otp', { phoneNumber: phone });
  const initial = app.store.verification![0]!.value;
  app.restart();
  expect((await app.request('/phone-number/send-otp', { phoneNumber: phone })).status).toBe(429);
  expect(app.phoneCodes).toHaveLength(1);
  expect(app.store.verification![0]!.value).toBe(initial);
  expect(JSON.stringify(app.store.rateLimit)).not.toContain(phone);
});

test('allowed phone resend invalidates all old codes instead of exposing an older row after consumption', async () => {
  const app = fixture();
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const row of app.store.rateLimit!) row.lastRequest = Date.now() - 120_000;
    expect((await app.request('/phone-number/send-otp', { phoneNumber: phone })).status).toBe(200);
    expect(app.store.verification).toHaveLength(1);
  }
  expect((await app.request('/phone-number/verify', { phoneNumber: phone, code: app.phoneCodes.at(-1), disableSession: true })).status).toBe(200);
  expect(app.store.verification).toHaveLength(0);
  expect((await app.request('/phone-number/verify', { phoneNumber: phone, code: app.phoneCodes[0], disableSession: true })).status).toBe(400);
});

test('email OTP handler stores HMAC, rejects replay and cannot mint JWT for quarantined binding', async () => {
  const app = fixture();
  expect((await app.request('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
  const code = /\b(\d{6})\b/.exec(app.messages[0]!.text)![1]!;
  expect(JSON.stringify(app.store.verification)).not.toContain(code);
  expect(app.store.verification![0]!.value).toMatch(/^[a-f0-9]{64}:0$/);
  const verified = await app.request('/sign-in/email-otp', { email, otp: code });
  expect(verified.status).toBe(200);
  expect((await app.request('/sign-in/email-otp', { email, otp: code })).status).toBe(400);
  app.quarantine();
  expect((await app.request('/token', undefined, cookies(verified))).status).toBe(403);
});

test('email reset uses a single-use hashed OTP and revokes existing auth sessions', async () => {
  const app = fixture();
  expect((await app.request('/email-otp/request-password-reset', { email })).status).toBe(200);
  const code = /\b(\d{6})\b/.exec(app.messages[0]!.text)![1]!;
  expect(app.store.verification![0]!.value).toMatch(/^[a-f0-9]{64}:0$/);
  app.store.session!.push({ id: 'synthetic-old-session', userId: 'synthetic-user', token: 'synthetic-old-token',
    expiresAt: new Date(Date.now() + 60000), createdAt: new Date(), updatedAt: new Date() });
  const reset = await app.request('/email-otp/reset-password', { email, otp: code, password: 'Synthetic-Reset-Password-123' });
  expect(reset.status).toBe(200);
  expect(app.store.session).toHaveLength(0);
  expect(app.store.account).toHaveLength(1);
  expect(app.store.account![0]!.password).not.toContain('Synthetic-Reset-Password-123');
  expect((await app.request('/email-otp/reset-password', { email, otp: code, password: 'Synthetic-Reset-Password-123' })).status).toBe(400);
});

test('new email code invalidates its older code and unknown email OTP cannot auto-register a member', async () => {
  const app = fixture();
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const row of app.store.rateLimit!) row.lastRequest = Date.now() - 120_000;
    expect((await app.request('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
    expect(app.store.verification).toHaveLength(1);
  }
  const lastCode = /\b(\d{6})\b/.exec(app.messages.at(-1)!.text)![1]!;
  expect((await app.request('/sign-in/email-otp', { email, otp: lastCode })).status).toBe(200);
  expect(app.store.verification).toHaveLength(0);
  const count = app.messages.length;
  expect((await app.request('/email-otp/send-verification-otp', { email: 'unknown@example.test', type: 'sign-in' })).status).toBe(200);
  expect(app.messages).toHaveLength(count);
  expect(app.store.user).toHaveLength(1);
});

test('email signup stays unverified without session until its independently delivered OTP is proved', async () => {
  const app = fixture(false);
  app.store.user!.length = 0;
  const response = await app.request('/sign-up/email', { name: 'Synthetic Member', email, password: 'Synthetic-Signup-Password-123' });
  expect(response.status).toBe(200);
  expect(app.store.user).toHaveLength(1);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.session).toHaveLength(0);
  expect(app.messages).toHaveLength(1);
  const otp = /\b(\d{6})\b/.exec(app.messages[0]!.text)![1]!;
  expect(app.store.verification![0]!.value).toMatch(/^[a-f0-9]{64}:0$/);
  expect((await app.request('/email-otp/verify-email', { email, otp })).status).toBe(200);
  expect(app.store.user![0]!.emailVerified).toBe(true);
  expect(app.store.session).toHaveLength(0);
});

test('email wrong attempts cannot request a concurrent new generation before expiry across restart', async () => {
  const app = fixture();
  await app.request('/email-otp/send-verification-otp', { email, type: 'sign-in' });
  const code = /\b(\d{6})\b/.exec(app.messages[0]!.text)![1]!;
  const wrong = code === '000000' ? '111111' : '000000';
  expect((await app.request('/sign-in/email-otp', { email, otp: wrong })).status).toBe(400);
  app.restart();
  expect((await app.request('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(429);
  expect(app.messages).toHaveLength(1);
  const expiry = app.store.verification![0]!.expiresAt.getTime();
  expect(app.store.rateLimit!.some(row => row.key.startsWith('auth-recipient:') && row.lastRequest > expiry)).toBe(true);
  expect((await app.request('/sign-in/email-otp', { email, otp: code })).status).toBe(200);
});

test('password login cannot send an OTP before checking a password', async () => {
  const app = fixture();
  expect((await app.request('/sign-in/phone-number', { phoneNumber: phone, password: 'incorrect-synthetic-password' })).status).toBe(403);
  expect(app.phoneCodes).toHaveLength(0);
  expect(app.store.verification).toHaveLength(0);
});
