import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { createAuthDelivery, type AuthEnvironment } from './delivery';
import { createAuthOptions, type AuthIdentity } from './options';
import { otpHash } from './phone-otp';

// This suite crosses the actual Better Auth HTTP handler and the actual email
// transport. All users, credentials and provider responses are synthetic; the
// injected fetch never opens a socket and the OTP exists only in test memory.
const email = 'email-flow@example.test';
const origin = 'https://portal.example.test';
const env: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-email-flow-secret-at-least-32-characters',
  BETTER_AUTH_URL: 'https://auth.example.test',
  BETTER_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
  BETTER_AUTH_PHONE_OTP_ENABLED: 'false',
  BETTER_AUTH_JWT_ENABLED: 'false',
  CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000002',
  CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-email-flow-provider-token',
  AUTH_EMAIL_FROM: 'codes@example.test',
};

type CloudflareBody = { from: string; to: string[]; subject: string; text: string };
type ProviderCall = { url: string; request: RequestInit; body: CloudflareBody };
function fixture(providerStatus: number | ((body: CloudflareBody) => Response | Promise<Response>) = 200) {
  const store: MemoryDB = {
    user: [{ id: 'synthetic-email-flow-user', name: 'Synthetic Member', email,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() }],
    session: [], account: [], verification: [], rateLimit: [], jwks: [],
  };
  const calls: ProviderCall[] = [];
  const provisioned: string[] = [];
  const identity: AuthIdentity = {
    registrationAllowed: async () => true,
    provision: async userId => { provisioned.push(userId); return { status: 'existing' }; },
    binding: async () => ({ status: 'existing', email,
      publicId: '00000000-0000-4000-8000-000000000002' }),
  };
  const delivery = createAuthDelivery(env, (async (url, request) => {
    const body = JSON.parse(request?.body as string) as CloudflareBody;
    calls.push({ url: String(url), request: request!, body });
    if (typeof providerStatus === 'function') return providerStatus(body);
    return providerStatus === 200
      ? Response.json({ success: true, errors: [], result: {
        delivered: [], queued: body.to, permanent_bounces: [],
      } })
      : Response.json({ success: false, errors: [{ message: 'synthetic-sensitive-provider-error' }] }, { status: providerStatus });
  }) as typeof fetch);
  const create = () => betterAuth(createAuthOptions(env, memoryAdapter(store), identity, delivery));
  let auth = create();
  const request = (path: string, body?: unknown, cookie?: string) => auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.21', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const code = () => {
    const match = /\b(\d{6})\b/.exec(calls.at(-1)?.body.text || '');
    if (!match?.[1]) throw new Error('Synthetic Cloudflare request has no OTP');
    return match[1];
  };
  return { store, calls, provisioned, request, code, restart: () => { auth = create(); } };
}

const requestCode = (app: ReturnType<typeof fixture>, recipient = email) => app.request('/email-otp/send-verification-otp', { email: recipient, type: 'sign-in' });
const redeemCode = (app: ReturnType<typeof fixture>, otp = app.code()) => app.request('/sign-in/email-otp', { email, otp });
const cookies = (response: Response) => response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');

async function expectNoDeliverySecrets(response: Response, code: string) {
  const browserResponse = JSON.stringify({ headers: [...response.headers], body: await response.clone().text() });
  expect(browserResponse).not.toContain(code);
  expect(browserResponse).not.toContain(env.CLOUDFLARE_EMAIL_API_TOKEN!);
  expect(browserResponse).not.toContain(env.AUTH_EMAIL_FROM!);
  expect(browserResponse).not.toContain('synthetic-sensitive-provider-error');
  expect(response.headers.has('set-auth-jwt')).toBe(false);
}

test('email-only Cloudflare OTP creates a real secure session only after proving the delivered code', async () => {
  const app = fixture();
  const sent = await requestCode(app);
  expect(sent.status).toBe(200);
  expect(app.calls).toHaveLength(1);
  const call = app.calls[0]!;
  expect(call.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`);
  expect(call.request.method).toBe('POST');
  expect(call.request.redirect).toBe('error');
  expect(call.request.signal).toBeInstanceOf(AbortSignal);
  expect(new Headers(call.request.headers).get('authorization')).toBe(`Bearer ${env.CLOUDFLARE_EMAIL_API_TOKEN}`);
  expect(call.body.from).toBe(env.AUTH_EMAIL_FROM!);
  expect(call.body.to).toEqual([email]);
  expect(call.body.subject).toContain('Mindbliss Power');
  expect(call.body.text).toContain('5 minutos');
  expect(app.store.session).toHaveLength(0);
  expect(app.provisioned).toHaveLength(0);
  const code = app.code();
  expect(app.store.verification).toHaveLength(1);
  expect(app.store.verification![0]!.value).toBe(`${otpHash(env.BETTER_AUTH_SECRET!, 'email-otp', code)}:0`);
  expect(JSON.stringify(app.store.verification)).not.toContain(code);
  await expectNoDeliverySecrets(sent, code);

  const verified = await redeemCode(app, code);
  expect(verified.status).toBe(200);
  expect(app.store.verification).toHaveLength(0);
  expect(app.store.session).toHaveLength(1);
  expect(app.provisioned).toEqual(['synthetic-email-flow-user']);
  const sessionCookie = verified.headers.getSetCookie().find(value => value.includes('better-auth.session_token='));
  expect(sessionCookie).toContain('HttpOnly');
  expect(sessionCookie).toContain('Secure');
  expect(sessionCookie).toContain('SameSite=Lax');
  await expectNoDeliverySecrets(verified, code);
  const session = await app.request('/get-session', undefined, cookies(verified));
  expect(session.status).toBe(200);
  expect((await session.json() as { user: { id: string; emailVerified: boolean } }).user).toMatchObject({ id: 'synthetic-email-flow-user', emailVerified: true });
  const replay = await redeemCode(app, code);
  expect(replay.status).toBe(400);
  expect(replay.headers.has('set-cookie')).toBe(false);
  expect(app.store.session).toHaveLength(1);
  expect((await app.request('/token')).status).toBe(404);
  expect((await app.request('/phone-number/send-otp', { phoneNumber: '+12025550123', consent: true, consentVersion: 'sms-auth-v1' })).status).toBe(401);
  expect(app.calls).toHaveLength(1);
});

test('only the consuming email verification flow is public; helper endpoints never expose or check a code', async () => {
  const app = fixture();
  await requestCode(app);
  const code = app.code();
  for (const path of ['/email-otp/check-verification-otp', '/email-otp/get-verification-otp', '/email-otp/create-verification-otp']) {
    const response = await app.request(path, { email, otp: code, type: 'sign-in' });
    expect(response.status).toBe(404);
    await expectNoDeliverySecrets(response, code);
  }
  expect(app.store.session).toHaveLength(0);
  expect(app.store.verification).toHaveLength(1);
  expect(app.calls).toHaveLength(1);
  expect((await redeemCode(app, code)).status).toBe(200);
});

test('email OTP wrong attempts and recipient cooldown persist across handler restart', async () => {
  const app = fixture();
  await requestCode(app);
  const code = app.code();
  const wrong = code === '000000' ? '111111' : '000000';
  expect((await redeemCode(app, wrong)).status).toBe(400);
  expect(app.store.verification![0]!.value).toMatch(/:1$/);
  app.restart();
  const blockedSend = await requestCode(app);
  expect(blockedSend.status).toBe(429);
  const retryAfter = Number(blockedSend.headers.get('retry-after'));
  expect(retryAfter).toBeGreaterThanOrEqual(299);
  expect(retryAfter).toBeLessThanOrEqual(301);
  expect(app.calls).toHaveLength(1);
  expect(app.store.session).toHaveLength(0);
  await expectNoDeliverySecrets(blockedSend, code);
  expect((await redeemCode(app, wrong)).status).toBe(400);
  expect((await redeemCode(app, wrong)).status).toBe(400);
  expect((await redeemCode(app, code)).status).toBe(403);
  expect(app.store.session).toHaveLength(0);
  expect(app.provisioned).toHaveLength(0);
});

test('an expired Cloudflare-delivered OTP cannot create a session', async () => {
  const app = fixture();
  await requestCode(app);
  app.store.verification![0]!.expiresAt = new Date(Date.now() - 1000);
  app.restart();
  const expired = await redeemCode(app);
  expect(expired.status).toBe(400);
  expect(expired.headers.has('set-cookie')).toBe(false);
  expect(app.store.session).toHaveLength(0);
  expect(app.provisioned).toHaveLength(0);
  expect(app.calls).toHaveLength(1);
  await expectNoDeliverySecrets(expired, app.code());
});

test('unknown email stays generic without Cloudflare send or automatic account creation', async () => {
  const app = fixture();
  const response = await requestCode(app, 'unknown-email-flow@example.test');
  expect(response.status).toBe(200);
  expect(app.calls).toHaveLength(0);
  expect(app.store.user).toHaveLength(1);
  expect(app.store.session).toHaveLength(0);
  expect(app.provisioned).toHaveLength(0);
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(await response.text()).not.toContain('unknown-email-flow@example.test');
});

test('Cloudflare rejection stays generic, never retries or falls back, and never automatically establishes a session', async () => {
  for (const status of [401, 429, 500]) {
    const app = fixture(status);
    const response = await requestCode(app);
    // Login deliberately remains generic for known/unknown addresses. This is
    // a request acknowledgement, not delivery confirmation or a session.
    expect(response.status).toBe(200);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(app.calls).toHaveLength(1);
    expect(app.store.session).toHaveLength(0);
    expect(app.provisioned).toHaveLength(0);
    await expectNoDeliverySecrets(response, app.code());
    expect(await (await app.request('/get-session')).json()).toBeNull();
  }
});

test('a confirmed Cloudflare rejection invalidates only its code while keeping the recipient cooldown and anti-enumeration', async () => {
  for (const status of [400, 401, 403, 404, 429]) {
    const app = fixture(status);
    app.store.verification!.push({ id: 'unrelated-generation', identifier: 'email-verification-otp-another@example.test',
      value: `${otpHash(env.BETTER_AUTH_SECRET!, 'email-otp', '123456')}:0`, expiresAt: new Date(Date.now() + 300_000),
      createdAt: new Date(), updatedAt: new Date() });
    const response = await requestCode(app);
    expect(response.status).toBe(200);
    expect((await redeemCode(app)).status).toBe(400);
    expect(app.store.verification!.map(row => row.id)).toEqual(['unrelated-generation']);
    expect((await requestCode(app)).status).toBe(429);
    expect(app.calls).toHaveLength(1);
    expect((await requestCode(app, 'unknown-email-flow@example.test')).status).toBe(200);
    expect(app.calls).toHaveLength(1);
    expect(app.store.session).toHaveLength(0);
  }
});

test('registration reports a confirmed delivery rejection without granting access and the failure does not leak into other requests', async () => {
  const app = fixture(403);
  app.store.user!.length = 0;
  const response = await app.request('/sign-up/email', { name: 'Synthetic Registration', email, password: 'Synthetic-Registration-Password-123' });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'AUTH_EMAIL_DELIVERY_UNAVAILABLE' });
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.account).toHaveLength(1);
  expect(app.store.verification).toHaveLength(0);
  expect((await app.request('/email-otp/verify-email', { email, otp: app.code() })).status).toBe(400);
  expect(app.store.session).toHaveLength(0);
  expect((await requestCode(app, 'unknown-email-flow@example.test')).status).toBe(200);
});

test('an ambiguous Cloudflare timeout or 5xx keeps a possibly delivered OTP usable without automatic retries', async () => {
  for (const failure of [500, () => { throw new DOMException('synthetic transport timeout', 'AbortError'); }]) {
    const app = fixture(failure);
    expect((await requestCode(app)).status).toBe(200);
    expect(app.store.verification).toHaveLength(1);
    expect((await redeemCode(app)).status).toBe(200);
    expect(app.store.session).toHaveLength(1);
    expect(app.calls).toHaveLength(1);
  }
});

test('simultaneous successful and rejected registrations keep delivery state isolated per request', async () => {
  const acceptedAddress = 'parallel-accepted@example.test';
  const app = fixture(async body => {
    await new Promise(resolve => setTimeout(resolve, body.to[0] === acceptedAddress ? 15 : 5));
    return body.to[0] === acceptedAddress
      ? Response.json({ success: true, errors: [], result: { delivered: [], queued: body.to, permanent_bounces: [] } })
      : Response.json({ success: false, errors: [{ code: 10102 }] }, { status: 403 });
  });
  app.store.user!.length = 0;
  const signup = (recipient: string) => app.request('/sign-up/email', {
    name: 'Synthetic Parallel Registration', email: recipient, password: 'Synthetic-Registration-Password-123',
  });
  const [rejected, accepted] = await Promise.all([signup(email), signup(acceptedAddress)]);
  expect(rejected.status).toBe(503);
  expect(accepted.status).toBe(200);
  expect(app.store.verification!.map(row => row.identifier)).toEqual([`email-verification-otp-${acceptedAddress}`]);
  expect(app.store.session).toHaveLength(0);
});

test('registration verifies its own OTP and then signs in with the original password without a second email', async () => {
  const app = fixture();
  app.store.user!.length = 0;
  const password = 'Synthetic-Registration-Password-123';
  const signup = await app.request('/sign-up/email', {
    name: 'Synthetic Registration', email, password,
    // Public registration must not turn client-provided fields into authority.
    emailVerified: true, role: 'superadmin', personId: 'attacker-selected-person',
  });
  expect(signup.status).toBe(200);
  expect((await signup.clone().json() as { token: unknown }).token).toBeNull();
  expect(signup.headers.has('set-cookie')).toBe(false);
  expect(app.store.user).toHaveLength(1);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.user![0]!.role).toBeUndefined();
  expect(app.store.user![0]!.personId).toBeUndefined();
  expect(app.store.session).toHaveLength(0);
  expect(app.calls).toHaveLength(1);
  const code = app.code();
  expect(app.store.verification![0]!.identifier).toBe(`email-verification-otp-${email}`);
  expect(JSON.stringify(app.store.account)).not.toContain(password);
  await expectNoDeliverySecrets(signup, code);

  const earlyLogin = await app.request('/sign-in/email', { email, password });
  expect(earlyLogin.status).toBe(403);
  expect(app.store.session).toHaveLength(0);
  expect(app.calls).toHaveLength(1);

  // A signup verification code is not an interchangeable login code.
  const wrongPurpose = await app.request('/sign-in/email-otp', { email, otp: code });
  expect(wrongPurpose.status).toBe(400);
  expect(app.store.session).toHaveLength(0);
  expect(app.store.verification).toHaveLength(1);

  app.restart();
  const verified = await app.request('/email-otp/verify-email', { email, otp: code });
  expect(verified.status).toBe(200);
  expect((await verified.clone().json() as { token: unknown }).token).toBeNull();
  expect(verified.headers.has('set-cookie')).toBe(false);
  expect(app.store.user![0]!.emailVerified).toBe(true);
  expect(app.store.session).toHaveLength(0);
  expect(app.store.verification).toHaveLength(0);
  expect(app.store.account![0]!.password).toBeTruthy();
  expect((await app.request('/email-otp/verify-email', { email, otp: code })).status).toBe(400);

  const login = await app.request('/sign-in/email', { email, password });
  expect(login.status).toBe(200);
  expect(app.store.session).toHaveLength(1);
  expect(app.calls).toHaveLength(1);
  const sessionCookie = login.headers.getSetCookie().find(value => value.includes('better-auth.session_token='));
  expect(sessionCookie).toContain('HttpOnly');
  expect(sessionCookie).toContain('Secure');
  expect(sessionCookie).toContain('SameSite=Lax');
  const session = await app.request('/get-session', undefined, cookies(login));
  expect((await session.json() as { user: { email: string; emailVerified: boolean } }).user)
    .toMatchObject({ email, emailVerified: true });
  await expectNoDeliverySecrets(login, code);
});

test('registration validation cannot create an account or contact Cloudflare for an invalid password or email', async () => {
  for (const input of [
    { name: 'Synthetic Registration', email, password: 'short' },
    { name: 'Synthetic Registration', email: 'not-an-email', password: 'Synthetic-Registration-Password-123' },
  ]) {
    const app = fixture();
    app.store.user!.length = 0;
    const response = await app.request('/sign-up/email', input);
    expect(response.status).toBe(400);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(app.store.user).toHaveLength(0);
    expect(app.store.account).toHaveLength(0);
    expect(app.store.verification).toHaveLength(0);
    expect(app.store.session).toHaveLength(0);
    expect(app.calls).toHaveLength(0);
    expect(app.provisioned).toHaveLength(0);
  }
});
