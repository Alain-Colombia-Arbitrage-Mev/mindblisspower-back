import { expect, test } from 'bun:test';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { createAuthOptions } from './options';
import { createAuthDelivery, type AuthEnvironment, type EmailMessage } from './delivery';
import { recipientBudgetKey } from './phone-otp';

const address = 'new-member@example.test';
const phone = '+12025550120';
const baseEnv: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-registration-secret-at-least-32-characters', BETTER_AUTH_URL: 'https://auth.example.test',
  BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test', BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
  BETTER_AUTH_REGISTRATION_SMS_REQUIRED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false',
  AUTH_BFF_SHARED_SECRET: 'synthetic-bff-secret-at-least-32-characters',
  CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-not-real', CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001', AUTH_EMAIL_FROM: 'auth@example.test',
  SENTDM_API_KEY: 'synthetic-not-real', SENTDM_OTP_TEMPLATE_ID: '00000000-0000-4000-8000-000000000001', SENTDM_OTP_CHANNEL: 'sms',
};
const sendBody = (email = address, phoneNumber = phone) => ({ email, phoneNumber, consent: true, consentVersion: 'registration-phone-v1' });
function fixture(changes: AuthEnvironment = {}, options: { deliveryFails?: boolean; userInsertFails?: boolean; storageFails?: boolean } = {}) {
  const env = { ...baseEnv, ...changes };
  const store: MemoryDB = { user: [], session: [], verification: [], rateLimit: [], account: [], jwks: [], smsOptIn: [] };
  const messages: EmailMessage[] = [];
  const codes: string[] = [];
  const operations: string[] = [];
  const allowedPhones: string[] = [];
  let provisioned = 0;
  const transport = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    codes.push(body.template.parameters.code);
    if (options.deliveryFails) throw new Error('synthetic-provider-private');
    return Response.json({ success: true, data: { status: 'QUEUED', template_id: env.SENTDM_OTP_TEMPLATE_ID,
      recipients: [{ message_id: 'synthetic-message', to: body.to[0], channel: 'sms' }] } });
  }) as typeof fetch;
  const delivery = createAuthDelivery(env, transport);
  const adapter = (configuration: BetterAuthOptions) => {
    const base = memoryAdapter(store)(configuration);
    const wrapped = { ...base,
      findOne: async (input: Parameters<typeof base.findOne>[0]) => {
        operations.push(`find:${input.model}`);
        if (options.storageFails && input.model === 'verification') throw new Error('synthetic-storage-private');
        return base.findOne(input);
      },
      create: async (input: Parameters<typeof base.create>[0]) => {
        if (options.userInsertFails && input.model === 'user') throw new Error('synthetic-user-insert-private');
        return base.create(input);
      },
      // Keep fault injection inside Better Auth's transaction callback as well.
      // These handler tests use only the in-memory adapter, never PostgreSQL.
      transaction: async (callback: Parameters<typeof base.transaction>[0]) => callback(wrapped),
    } as typeof base;
    return wrapped;
  };
  const auth = betterAuth(createAuthOptions(env, adapter, {
    provision: async () => { provisioned++; return { status: 'verification_required' }; },
    binding: async () => ({ status: 'claim_required' }),
    registrationAllowed: async candidate => { allowedPhones.push(candidate.phone || ''); return true; },
  }, { email: async message => { messages.push(message); }, phone: delivery.phone }));
  const request = (path: string, body?: unknown, cookie = '', origin = 'https://portal.example.test', ip = '192.0.2.12') =>
    auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-vp-auth-client-ip': ip, ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const verify = (flowId: string, code: string, email = address, phoneNumber = phone) =>
    request('/registration/phone/verify', { email, phoneNumber, flowId, code });
  const prove = async (email = address, phoneNumber = phone) => {
    const sent = await request('/registration/phone/send', sendBody(email, phoneNumber));
    expect(sent.status).toBe(200);
    const { flowId } = await sent.json() as { flowId: string };
    const response = await verify(flowId, codes.at(-1)!, email, phoneNumber);
    expect(response.status).toBe(200);
    const result = await response.json() as { proof: string };
    return { ...result, cookie: `__Secure-vp_registration_phone=${result.proof}; vp_registration_phone_expected=${phoneNumber}`, flowId };
  };
  let signupIp = 50;
  const signup = (cookie = '', email = address, extra: Record<string, unknown> = {}) => request('/sign-up/email', {
    email, name: 'Synthetic Member', password: 'Synthetic-Password-123', ...extra,
  }, cookie, undefined, `192.0.2.${signupIp++}`);
  return { store, messages, codes, request, verify, prove, signup, operations, allowedPhones, provisioned: () => provisioned };
}

test('registration SMS is off by default and existing email signup remains unchanged', async () => {
  const app = fixture({ BETTER_AUTH_REGISTRATION_SMS_REQUIRED: undefined });
  expect((await app.request('/registration/phone/send', sendBody())).status).toBe(404);
  expect((await app.signup()).status).toBe(200);
  expect(app.codes).toHaveLength(0);
  expect(app.store.user![0]!.phoneNumberVerified).not.toBe(true);
});

test('SMS proof is opaque, purpose/email/phone bound and never creates identity, session or JWT', async () => {
  const app = fixture();
  const sent = await app.request('/registration/phone/send', sendBody(' NEW-MEMBER@example.test '));
  expect(sent.status).toBe(200);
  expect(sent.headers.get('cache-control')).toBe('no-store');
  const result = await sent.json() as { ok: boolean; flowId: string; resendAfter: number; expiresIn: number };
  expect(result).toEqual({ ok: true, flowId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), resendAfter: 60, expiresIn: 300 });
  expect(app.store.verification![0]!.value).toMatch(/^h1_[a-f0-9]{64}:0$/);
  expect(app.store.verification![0]!.value).not.toContain(app.codes[0]!);
  expect(app.operations.some(value => value === 'find:user')).toBe(false);
  const verified = await app.verify(result.flowId, app.codes[0]!);
  expect(verified.status).toBe(200);
  expect(verified.headers.has('set-cookie')).toBe(false);
  const proof = await verified.json() as { proof: string; ok: boolean; verified: boolean; purpose: string; email: string; phoneNumber: string };
  expect(proof).toEqual({ ok: true, verified: true, purpose: 'registration', email: address, phoneNumber: phone,
    proof: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  expect(JSON.stringify(app.store.verification)).not.toContain(proof.proof);
  expect(app.store.user).toHaveLength(0); expect(app.store.session).toHaveLength(0);
  expect(app.provisioned()).toBe(0);
});

test('signup requires server cookie proof before policy checks; caller flags cannot bypass it', async () => {
  const app = fixture();
  for (const cookie of ['', '__Secure-vp_registration_phone=not-a-proof', 'vp_registration_phone=' + 'a'.repeat(43)]) {
    expect((await app.signup(cookie, address, { phoneNumber: phone, phoneNumberVerified: true })).status).not.toBe(200);
  }
  expect(app.allowedPhones).toHaveLength(0); expect(app.store.user).toHaveLength(0);
  const { cookie } = await app.prove();
  // Better Auth input:false rejects caller-supplied phone fields altogether;
  // the BFF forwards the expected phone only in its signed upstream cookie.
  expect((await app.signup(cookie, address, { phoneNumber: '+12025550999', phoneNumberVerified: false })).status).toBe(400);
  const created = await app.signup(cookie);
  expect(created.status).toBe(200);
  expect(app.allowedPhones).toEqual([phone]);
  expect(app.store.user![0]).toMatchObject({ email: address, phoneNumber: phone, phoneNumberVerified: true, emailVerified: false });
  expect(app.store.session).toHaveLength(0);
  expect(app.messages).toHaveLength(1);
});

test('changing submitted email or expected phone rejects an otherwise valid proof without spending it', async () => {
  const app = fixture(); const { cookie } = await app.prove();
  expect((await app.signup(cookie, 'different@example.test')).status).toBe(400);
  expect((await app.signup(cookie.replace(phone, '+12025550121'))).status).toBe(400);
  expect((await app.signup(cookie.replace('vp_registration_phone_expected=', 'untrusted='))).status).toBe(403);
  expect((await app.signup(cookie)).status).toBe(200);
});

test('OTP owner binding rejects changed email, phone and flow; the original remains usable', async () => {
  const app = fixture();
  const sent = await app.request('/registration/phone/send', sendBody());
  const { flowId } = await sent.json() as { flowId: string }; const code = app.codes[0]!;
  expect((await app.verify(flowId, code, 'different@example.test')).status).toBe(400);
  expect((await app.verify(flowId, code, address, '+12025550121')).status).toBe(400);
  expect((await app.verify('b'.repeat(43), code)).status).toBe(400);
  expect((await app.verify(flowId, code)).status).toBe(200);
});

test('parallel OTP redemptions and parallel signup consume their proof exactly once', async () => {
  const app = fixture();
  const { flowId } = await (await app.request('/registration/phone/send', sendBody())).json() as { flowId: string };
  const attempts = await Promise.all([app.verify(flowId, app.codes[0]!), app.verify(flowId, app.codes[0]!)]);
  expect(attempts.map(response => response.status).sort()).toEqual([200, 400]);
  const { proof } = await attempts.find(response => response.status === 200)!.json() as { proof: string };
  const cookie = `__Secure-vp_registration_phone=${proof}; vp_registration_phone_expected=${phone}`;
  const registrations = await Promise.all([app.signup(cookie), app.signup(cookie)]);
  expect(registrations.filter(response => response.status === 200)).toHaveLength(1);
  expect(app.store.user).toHaveLength(1);
  expect(app.store.verification!.filter(row => String(row.identifier).startsWith('registration-proof:'))).toHaveLength(0);
  expect((await app.signup(cookie, 'other@example.test')).status).toBe(400);
});

test('OTP expires in five minutes; consumed verification grants a fresh five-minute signup proof', async () => {
  const app = fixture();
  const { flowId } = await (await app.request('/registration/phone/send', sendBody())).json() as { flowId: string };
  app.store.verification![0]!.expiresAt = new Date(Date.now() - 1);
  expect((await app.verify(flowId, app.codes[0]!)).status).toBe(400);
  const another = fixture();
  const { flowId: anotherFlow } = await (await another.request('/registration/phone/send', sendBody())).json() as { flowId: string };
  another.store.verification![0]!.expiresAt = new Date(Date.now() + 2_000);
  const beforeVerify = Date.now();
  const verified = await another.verify(anotherFlow, another.codes[0]!);
  expect(verified.status).toBe(200);
  const { proof } = await verified.json() as { proof: string };
  const proofExpiry = (another.store.verification![0]!.expiresAt as Date).getTime();
  expect(proofExpiry).toBeGreaterThanOrEqual(beforeVerify + 300_000);
  expect(proofExpiry).toBeLessThanOrEqual(Date.now() + 300_000);
  const cookie = `__Secure-vp_registration_phone=${proof}; vp_registration_phone_expected=${phone}`;
  another.store.verification![0]!.expiresAt = new Date(Date.now() - 1);
  expect((await another.signup(cookie)).status).toBe(400);
});

test('three wrong OTPs lock the challenge and parallel failures cannot reset attempts', async () => {
  const app = fixture();
  const { flowId } = await (await app.request('/registration/phone/send', sendBody())).json() as { flowId: string };
  const wrong = app.codes[0] === '000000' ? '000001' : '000000';
  const attempts = await Promise.all([1, 2, 3].map(() => app.verify(flowId, wrong)));
  expect(attempts.every(response => response.status === 400)).toBe(true);
  expect((await app.verify(flowId, app.codes[0]!)).status).toBe(400);
  expect(app.store.verification).toHaveLength(0);
});

test('resend cooldown is global to phone and email, regardless of changed IP or destination', async () => {
  const app = fixture();
  expect((await app.request('/registration/phone/send', sendBody())).status).toBe(200);
  expect((await app.request('/registration/phone/send', sendBody('other@example.test'), '', undefined, '192.0.2.13')).status).toBe(429);
  expect((await app.request('/registration/phone/send', sendBody(address, '+12025550121'))).status).toBe(429);
  expect(app.codes).toHaveLength(1);
});

test('one IP cannot evade the persistent send budget by rotating phones and emails', async () => {
  const app = fixture();
  for (let index = 0; index < 5; index++) {
    expect((await app.request('/registration/phone/send', sendBody(`rotating-${index}@example.test`, `+1202555013${index}`))).status).toBe(200);
  }
  expect((await app.request('/registration/phone/send', sendBody('rotating-6@example.test', '+12025550136'))).status).toBe(429);
  expect(app.codes).toHaveLength(5);
  expect(JSON.stringify(app.store.rateLimit)).not.toContain(address);
  expect(JSON.stringify(app.store.rateLimit!.filter(row => String(row.key).startsWith('auth-recipient:')))).not.toContain('192.0.2.12');
});

test('SMS consent/version, strict payloads and canonical international phone are mandatory', async () => {
  const app = fixture();
  for (const body of [{ ...sendBody(), consent: false }, { ...sendBody(), consentVersion: 'marketing-v1' },
    { ...sendBody(), phoneNumber: '2025550120' }, { ...sendBody(), userId: 'target' }, { ...sendBody(), phoneNumberVerified: true }]) {
    expect((await app.request('/registration/phone/send', body)).status).toBe(400);
  }
  expect(app.codes).toHaveLength(0); expect(app.store.verification).toHaveLength(0);
});

test('account-wide 100-per-day SMS cap survives changes of phone, email and IP', async () => {
  const app = fixture();
  expect((await app.request('/registration/phone/send', sendBody())).status).toBe(200);
  const globalKey = recipientBudgetKey(baseEnv.BETTER_AUTH_SECRET!, 'registration:send-global');
  const global = app.store.rateLimit!.find(row => row.key === globalKey)!;
  expect(global.count).toBe(1);
  expect(Number(global.lastRequest)).toBeGreaterThan(Date.now() + 86_390_000);
  global.count = 100;
  expect((await app.request('/registration/phone/send', sendBody('rotated@example.test', '+12025550190'), '', undefined, '192.0.2.190')).status).toBe(429);
  expect(app.codes).toHaveLength(1);
});

test('provider failure is redacted, does not retry or leave a redeemable challenge', async () => {
  const app = fixture({}, { deliveryFails: true });
  const response = await app.request('/registration/phone/send', sendBody());
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('synthetic-provider-private');
  expect(app.codes).toHaveLength(1); expect(app.store.verification).toHaveLength(0);
  expect(app.store.user).toHaveLength(0);
});

test('incomplete SMS configuration fails SMS and signup only, while email login still works', async () => {
  for (const change of [{ SENTDM_API_KEY: '' }, { SENTDM_OTP_TEMPLATE_ID: 'invalid' }, { SENTDM_OTP_CHANNEL: 'whatsapp' }]) {
    const app = fixture(change);
    const sent = await app.request('/registration/phone/send', sendBody());
    expect(sent.status).toBe(503);
    expect((await sent.json() as { code: string }).code).toBe('REGISTRATION_PHONE_UNAVAILABLE');
    expect((await app.signup()).status).toBe(503);
    app.store.user!.push({ id: 'existing', email: address, name: 'Existing', emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    expect((await app.request('/email-otp/send-verification-otp', { email: address, type: 'sign-in' })).status).toBe(200);
    const otp = /\b(\d{6})\b/.exec(app.messages.at(-1)!.text)![1]!;
    expect((await app.request('/sign-in/email-otp', { email: address, otp })).status).toBe(200);
    expect(app.codes).toHaveLength(0);
  }
});

test('failed user insertion never restores a spent proof or leaks the storage failure', async () => {
  const app = fixture({}, { userInsertFails: true }); const { cookie } = await app.prove();
  const response = await app.signup(cookie);
  expect(response.status).not.toBe(200); expect(await response.text()).not.toContain('synthetic-user-insert-private');
  expect(app.store.verification!.filter(row => String(row.identifier).startsWith('registration-proof:'))).toHaveLength(0);
  expect((await app.signup(cookie)).status).toBe(400);
});

test('storage errors are redacted and never become reusable verification or account creation', async () => {
  const app = fixture({}, { storageFails: true });
  const { flowId } = await (await app.request('/registration/phone/send', sendBody())).json() as { flowId: string };
  const verified = await app.verify(flowId, app.codes[0]!);
  expect(verified.status).toBe(503); expect(await verified.text()).not.toContain('synthetic-storage-private');
  expect(app.store.user).toHaveLength(0); expect(app.store.session).toHaveLength(0);
});

test('only explicit local HTTP uses the unprefixed proof cookie; duplicate cookies are rejected', async () => {
  const app = fixture({ BETTER_AUTH_URL: 'http://127.0.0.1:3000' }); const { cookie } = await app.prove();
  expect((await app.signup(cookie)).status).toBe(403);
  const localCookie = cookie.replace('__Secure-vp_registration_phone=', 'vp_registration_phone=');
  expect((await app.signup(`${localCookie}; vp_registration_phone=${'x'.repeat(43)}`)).status).toBe(403);
  expect((await app.signup(`${localCookie}; vp_registration_phone_expected=${phone}`)).status).toBe(403);
  expect((await app.signup(localCookie)).status).toBe(200);
});

test('registration SMS accepts trusted origins and IP context only and never exposes phone login', async () => {
  const app = fixture();
  expect((await app.request('/registration/phone/send', sendBody(), '', 'https://evil.example.test')).status).toBe(403);
  expect((await app.request('/registration/phone/send', sendBody(), '', undefined, '')).status).toBe(503);
  expect((await app.request('/sign-in/phone-number', { phoneNumber: phone, password: 'Synthetic-Password-123' })).status).toBe(404);
  expect((await app.request('/phone-number/send-otp', { phoneNumber: phone })).status).not.toBe(200);
  expect(app.codes).toHaveLength(0);
});
