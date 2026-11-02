import { expect, test } from 'bun:test';
import type { DBAdapter } from '@better-auth/core/db/adapter';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { createAuthOptions } from './options';
import { AuthEmailDeliveryError, type AuthEnvironment, type EmailMessage } from './delivery';
import { otpHash } from './phone-otp';

// Real installed Better Auth 1.6.22 HTTP handlers; synthetic in-memory accounts
// and delivery only. No sockets, real messages, legacy rows or production data.
const email = 'recovery-member@example.test';
const missing = 'unknown-recovery@example.test';
const userId = 'synthetic-recovery-subject';
const oldPassword = 'Synthetic-Previous-Password-123';
const password = 'Synthetic-Replacement-Password-123';
const env: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-recovery-secret-with-at-least-32-characters',
  BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
  BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'false',
  CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001', CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-not-real',
  AUTH_EMAIL_FROM: 'auth@example.test',
};

function fixture(options: { missing?: boolean; verified?: boolean; deliveryRejected?: boolean;
  deliveryAmbiguous?: boolean; revocationFails?: boolean } = {}) {
  const store: MemoryDB = {
    user: options.missing ? [] : [{ id: userId, email, name: 'Synthetic Existing Member',
      emailVerified: options.verified === true, createdAt: new Date(), updatedAt: new Date() }],
    account: [], session: [], verification: [], rateLimit: [], jwks: [],
  };
  const messages: EmailMessage[] = [];
  const provisioned: string[] = [];
  const bound: string[] = [];
  const create = () => betterAuth(createAuthOptions(env, (authOptions: Parameters<ReturnType<typeof memoryAdapter>>[0]) => {
    const adapter = memoryAdapter(store)(authOptions);
    const wrapped: DBAdapter = { ...adapter, deleteMany: async input => {
      if (options.revocationFails && input.model === 'session') throw new Error('Synthetic private revocation failure');
      return adapter.deleteMany(input);
    } };
    return wrapped;
  }, {
    provision: async subject => { provisioned.push(subject); return { status: 'existing' }; },
    binding: async subject => { bound.push(subject); return { status: 'claim_required' }; },
    registrationAllowed: async () => false,
  }, {
    email: async message => {
      messages.push(message);
      if (options.deliveryRejected || options.deliveryAmbiguous) throw new AuthEmailDeliveryError(options.deliveryRejected === true);
    },
    phone: async () => { throw new Error('Synthetic recovery must not send SMS'); },
  }));
  let auth = create();
  const request = (path: string, body: unknown, ip = '192.0.2.71') => auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://portal.example.test',
      'x-forwarded-for': ip }, body: JSON.stringify(body),
  }));
  const send = (address = email) => request('/email-otp/request-password-reset', { email: address });
  const code = () => /\b([0-9]{6})\b/.exec(messages.at(-1)!.text)![1]!;
  const reset = (otp = code(), replacement = password, address = email) => request('/email-otp/reset-password', {
    email: address, otp, password: replacement,
  });
  const seedCredential = async (hash?: string | null) => store.account!.push({
    id: 'synthetic-existing-credential', userId, accountId: userId, providerId: 'credential',
    password: hash === undefined ? await hashPassword(oldPassword) : hash,
    createdAt: new Date(), updatedAt: new Date(),
  });
  const seedSession = () => store.session!.push({ id: 'synthetic-standing-session', userId,
    token: 'synthetic-standing-session-token', expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(), updatedAt: new Date() });
  return { store, messages, provisioned, bound, request, send, code, reset, seedCredential, seedSession,
    restart: () => { auth = create(); } };
}

async function expectNoSession(response: Response) {
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(response.headers.has('set-auth-jwt')).toBe(false);
  expect(await response.clone().json()).toEqual({ success: true });
}

for (const credential of ['missing', 'existing', 'empty'] as const) {
  test(`email OTP creates or replaces a ${credential} password credential without replacing identity or signing in`, async () => {
    const app = fixture({ verified: credential === 'existing' });
    if (credential !== 'missing') await app.seedCredential(credential === 'empty' ? null : undefined);
    app.seedSession();
    const original = { ...app.store.user![0]! };
    const sent = await app.send(`  ${email.toUpperCase()}  `);
    expect(sent.status).toBe(200);
    await expectNoSession(sent);
    expect(app.messages).toHaveLength(1);
    expect(app.messages[0]!.to).toBe(email);
    expect(app.messages[0]!.subject).toContain('restablecer');
    expect(app.store.account).toHaveLength(credential === 'missing' ? 0 : 1);
    const otp = app.code();
    expect(app.store.verification![0]!.value).toBe(`${otpHash(env.BETTER_AUTH_SECRET!, 'email-otp', otp)}:0`);
    expect(JSON.stringify(app.store.verification)).not.toContain(otp);
    const replacement = `  ${password}  `;
    const reset = await app.reset(otp, replacement, ` ${email.toUpperCase()} `);
    expect(reset.status).toBe(200);
    await expectNoSession(reset);
    expect(app.store.account).toHaveLength(1);
    const account = app.store.account![0]!;
    expect(account.userId).toBe(userId);
    expect(account.accountId).toBe(userId);
    expect(account.providerId).toBe('credential');
    if (credential !== 'missing') expect(account.id).toBe('synthetic-existing-credential');
    expect(await verifyPassword({ hash: String(account.password), password: replacement })).toBe(true);
    expect(await verifyPassword({ hash: String(account.password), password })).toBe(false);
    expect(await verifyPassword({ hash: String(account.password), password: oldPassword })).toBe(false);
    expect(app.store.user![0]!).toMatchObject({ id: original.id, name: original.name, email: original.email, emailVerified: true });
    expect(app.store.session).toHaveLength(0);
    expect(app.store.verification).toHaveLength(0);
    expect(app.provisioned).toHaveLength(0);
    expect(app.bound).toHaveLength(0);
    expect((await app.reset(otp, password)).status).toBe(400);
  });
}

test('unknown email has the same request acknowledgement but never creates a user, credential or identity', async () => {
  const known = fixture();
  const unknown = fixture({ missing: true });
  const knownResponse = await known.send();
  const unknownResponse = await unknown.send(missing);
  expect(knownResponse.status).toBe(200);
  expect(unknownResponse.status).toBe(200);
  expect(await unknownResponse.json()).toEqual(await knownResponse.json());
  expect(unknown.messages).toHaveLength(0);
  expect(unknown.store.verification).toHaveLength(0);
  expect((await unknown.reset('000000', password, missing)).status).toBe(400);
  for (const rows of [unknown.store.user, unknown.store.account, unknown.store.session, unknown.provisioned, unknown.bound]) expect(rows).toHaveLength(0);
});

test('invalid request/reset inputs are rejected before a valid challenge or password is modified', async () => {
  const app = fixture();
  await app.seedCredential();
  expect((await app.send()).status).toBe(200);
  const otp = app.code();
  const originalChallenge = JSON.stringify(app.store.verification);
  const originalCredential = JSON.stringify(app.store.account);
  let inputIP = 80;
  for (const body of [
    { email: 'not-an-email' }, { email: 71 }, { email, newEmail: missing },
    { email: `${'a'.repeat(255)}@example.test` },
  ]) expect((await app.request('/email-otp/request-password-reset', body, `192.0.2.${inputIP++}`)).status).toBe(400);
  for (const body of [
    { email, otp, password: 'too-short' }, { email, otp, password: 'x'.repeat(129) },
    { email, otp, password: 71 }, { email, otp: ` ${otp}`, password },
    { email, otp: '１２３４５６', password }, { email, otp: '12345', password },
    { email: 'not-an-email', otp, password }, { email, otp, password, newEmail: missing },
  ]) {
    const response = await app.request('/email-otp/reset-password', body, `192.0.2.${inputIP++}`);
    expect(response.status).toBe(400);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(JSON.stringify(app.store.verification)).toBe(originalChallenge);
    expect(JSON.stringify(app.store.account)).toBe(originalCredential);
  }
  expect(app.messages).toHaveLength(1);
  expect((await app.reset(otp)).status).toBe(200);
});

test('a sign-in code cannot reset a password, and a recovery code cannot sign in', async () => {
  const app = fixture();
  const signIn = await app.request('/email-otp/send-verification-otp', { email, type: 'sign-in' });
  expect(signIn.status).toBe(200);
  expect((await app.reset(app.code())).status).toBe(400);
  expect(app.store.account).toHaveLength(0);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  const recovery = fixture();
  expect((await recovery.send()).status).toBe(200);
  expect((await recovery.request('/sign-in/email-otp', { email, otp: recovery.code() })).status).toBe(400);
  expect(recovery.store.session).toHaveLength(0);
  expect(recovery.store.user![0]!.emailVerified).toBe(false);
  expect((await recovery.reset()).status).toBe(200);
});

test('wrong recovery codes exhaust their persistent attempt budget without changing credentials or verification', async () => {
  const app = fixture();
  await app.seedCredential();
  const original = JSON.stringify(app.store.account);
  expect((await app.send()).status).toBe(200);
  const otp = app.code();
  const wrong = otp === '000000' ? '111111' : '000000';
  expect((await app.reset(wrong)).status).toBe(400);
  app.restart();
  for (let attempt = 0; attempt < 2; attempt++) expect((await app.reset(wrong)).status).toBe(400);
  expect([400, 403]).toContain((await app.reset(otp)).status);
  expect(JSON.stringify(app.store.account)).toBe(original);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.provisioned).toHaveLength(0);
  expect(app.store.session).toHaveLength(0);
});

test('expired and concurrently replayed recovery challenges cannot be reused', async () => {
  const expired = fixture();
  await expired.send();
  expired.store.verification![0]!.expiresAt = new Date(Date.now() - 1000);
  expect((await expired.reset()).status).toBe(400);
  expect(expired.store.account).toHaveLength(0);
  const app = fixture();
  await app.send();
  const otp = app.code();
  const outcomes = await Promise.all([app.reset(otp), app.reset(otp)]);
  expect(outcomes.filter(response => response.status === 200)).toHaveLength(1);
  expect(outcomes.filter(response => response.status === 400)).toHaveLength(1);
  expect(app.store.account).toHaveLength(1);
  expect(app.store.session).toHaveLength(0);
});

test('recovery resend respects the shared persistent recipient cooldown across handler restart', async () => {
  const app = fixture();
  expect((await app.send()).status).toBe(200);
  const challenge = JSON.stringify(app.store.verification);
  app.restart();
  const resent = await app.send();
  expect(resent.status).toBe(429);
  expect(Number(resent.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(app.messages).toHaveLength(1);
  expect(JSON.stringify(app.store.verification)).toBe(challenge);
  expect((await app.request('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(429);
  expect((await app.reset()).status).toBe(200);
});

test('provider rejection or ambiguity uses the generic acknowledgement without claiming email proof', async () => {
  for (const confirmedRejected of [true, false]) {
    const app = fixture({ deliveryRejected: confirmedRejected, deliveryAmbiguous: !confirmedRejected });
    const response = await app.send();
    // Like unknown recipients, native sender failures receive only a generic
    // acknowledgement. Neither is a promise of delivery or proof of ownership.
    // Ambiguous failures retain a code in case the mailbox actually receives it.
    expect(response.status).toBe(200);
    await expectNoSession(response);
    expect(await response.clone().text()).not.toContain(app.code());
    expect(app.store.account).toHaveLength(0);
    expect(app.store.session).toHaveLength(0);
    expect(app.store.user![0]!.emailVerified).toBe(false);
    expect(app.store.verification).toHaveLength(confirmedRejected ? 0 : 1);
    expect(app.provisioned).toHaveLength(0);
    expect(app.bound).toHaveLength(0);
  }
});

test('installed native reset failure boundaries are explicit: session failure is not claimed to roll back credential updates', async () => {
  const app = fixture({ revocationFails: true, verified: true });
  await app.seedCredential();
  app.seedSession();
  expect((await app.send()).status).toBe(200);
  const response = await app.reset();
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('Synthetic private');
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(app.store.verification).toHaveLength(0);
  // Better Auth 1.6.22's reset is sequential, and our adapter deliberately
  // remains transaction:false. This test documents rather than hides that
  // dependency boundary; the UI must not claim a successful reset on error.
  expect(await verifyPassword({ hash: String(app.store.account![0]!.password), password })).toBe(true);
  expect(app.store.session).toHaveLength(1);
  expect(app.provisioned).toHaveLength(0);
});
