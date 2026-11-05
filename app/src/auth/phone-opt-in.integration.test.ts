import { expect, test } from 'bun:test';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { createAuthOptions } from './options';
import { SMS_CONSENT_VERSION } from './phone-opt-in';
import type { AuthEnvironment, EmailMessage } from './delivery';

const phone = '+12025550120';
const email = 'sms-opt-in@example.test';
const env: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-sms-opt-in-secret-at-least-32-characters', BETTER_AUTH_URL: 'https://auth.example.test',
  BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test', BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
  BETTER_AUTH_PHONE_OTP_ENABLED: 'true', BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY: 'true',
  CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-not-real', CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001', AUTH_EMAIL_FROM: 'auth@example.test',
  SENTDM_API_KEY: 'synthetic-not-real', SENTDM_OTP_TEMPLATE_ID: '00000000-0000-4000-8000-000000000001', SENTDM_OTP_CHANNEL: 'sms',
};
const consent = (destination = phone) => ({ phoneNumber: destination, consent: true, consentVersion: SMS_CONSENT_VERSION });
const proof = (code: string, destination = phone) => ({ phoneNumber: destination, code, updatePhoneNumber: true, disableSession: true });
function fixture(changes: AuthEnvironment = {}, options: { missingTable?: boolean; deliveryFails?: boolean } = {}) {
  const store: MemoryDB = { user: [{ id: 'sms-user', email, name: 'Synthetic Member', emailVerified: true,
    phoneNumber: null, phoneNumberVerified: false, createdAt: new Date(), updatedAt: new Date() }],
  session: [], verification: [], rateLimit: [], account: [], jwks: [], smsOptIn: [] };
  const messages: EmailMessage[] = [];
  const codes: string[] = [];
  let consentReads = 0;
  let duringUserUpdate: (() => Promise<void>) | undefined;
  const adapter = (configuration: BetterAuthOptions) => {
    const base = memoryAdapter(store)(configuration);
    return { ...base,
      findOne: async (input: Parameters<typeof base.findOne>[0]) => {
        if (input.model === 'smsOptIn') {
          consentReads++;
          if (options.missingTable) throw new Error('synthetic-private-db-and-phone');
        }
        return base.findOne(input);
      },
      update: async (input: Parameters<typeof base.update>[0]) => {
        if (input.model === 'user' && (input.update as { phoneNumberVerified?: boolean }).phoneNumberVerified && duringUserUpdate) {
          const effect = duringUserUpdate; duringUserUpdate = undefined; await effect();
        }
        return base.update(input);
      },
    } as typeof base;
  };
  const auth = betterAuth(createAuthOptions({ ...env, ...changes }, adapter, {
    provision: async () => ({ status: 'claim_required' }), binding: async () => ({ status: 'claim_required' }), registrationAllowed: async () => true,
  }, { email: async message => { messages.push(message); }, phone: async (_destination, code) => {
    codes.push(code); if (options.deliveryFails) throw new Error(`synthetic-private-provider-${code}`);
  } }));
  let cookie = '';
  const request = (path: string, body?: unknown, customCookie = cookie, origin = 'https://portal.example.test') =>
    auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...(customCookie ? { cookie: customCookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const login = async (address = email) => {
    expect((await request('/email-otp/send-verification-otp', { email: address, type: 'sign-in' }, '')).status).toBe(200);
    const otp = /\b(\d{6})\b/.exec(messages.at(-1)!.text)![1]!;
    const response = await request('/sign-in/email-otp', { email: address, otp }, '');
    expect(response.status).toBe(200);
    cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    return cookie;
  };
  return { store, codes, request, login, consentReads: () => consentReads,
    duringUserUpdate: (effect: () => Promise<void>) => { duringUserUpdate = effect; } };
}

test('SMS opt-in requires a real verified-email session, never a user ID supplied by the caller', async () => {
  const app = fixture();
  expect((await app.request('/phone-number/opt-in')).status).toBe(401);
  expect((await app.request('/phone-number/send-otp', consent())).status).toBe(401);
  await app.login();
  app.store.user![0]!.emailVerified = false;
  expect((await app.request('/phone-number/opt-in')).status).toBe(403);
  expect((await app.request('/phone-number/send-otp', consent())).status).toBe(403);
  expect(app.codes).toHaveLength(0);
  expect(app.store.smsOptIn).toHaveLength(0);
});

test('explicit current consent is required; it is not marketing consent or a registration requirement', async () => {
  const app = fixture(); await app.login();
  for (const body of [{ phoneNumber: phone }, { ...consent(), consent: false }, { ...consent(), consent: 'true' },
    { ...consent(), consentVersion: 'old-version' }, { ...consent(), marketing: true }, { ...consent(), userId: 'other-user' }]) {
    expect((await app.request('/phone-number/send-otp', body)).status).toBe(400);
  }
  expect(app.codes).toHaveLength(0);
  expect(app.store.smsOptIn).toHaveLength(0);
  const status = await app.request('/phone-number/opt-in');
  expect(status.headers.get('cache-control')).toBe('no-store');
  expect(await status.json()).toEqual({ available: true,
    consentVersion: SMS_CONSENT_VERSION, optedIn: false, phoneNumber: null, phoneNumberVerified: false });
});

test('successful challenge records consent only after possession proof and revocation is independent of phone proof', async () => {
  const app = fixture(); await app.login();
  expect(await (await app.request('/phone-number/send-otp', consent())).json()).toEqual({ ok: true, resendAfter: 60 });
  expect(app.store.smsOptIn![0]!.consentedAt).toBeInstanceOf(Date);
  expect(app.store.smsOptIn![0]!.verifiedAt).toBeNull();
  expect((await (await app.request('/phone-number/opt-in')).json() as { optedIn: boolean }).optedIn).toBe(false);
  const verified = await app.request('/phone-number/verify', proof(app.codes[0]!));
  expect(await verified.json()).toEqual({ ok: true, phoneNumberVerified: true, optedIn: true });
  expect(verified.headers.has('set-cookie')).toBe(false);
  expect(app.store.session).toHaveLength(1);
  expect(await (await app.request('/phone-number/opt-in')).json()).toEqual({ available: true, consentVersion: SMS_CONSENT_VERSION,
    optedIn: true, phoneNumber: phone, phoneNumberVerified: true });
  expect(await (await app.request('/phone-number/revoke-consent', {})).json()).toEqual({ ok: true, optedIn: false });
  expect((await (await app.request('/phone-number/opt-in')).json() as { optedIn: boolean }).optedIn).toBe(false);
  expect(app.store.smsOptIn![0]!.revokedAt).toBeInstanceOf(Date);
  expect(app.store.user![0]!.phoneNumberVerified).toBe(true);
  expect(app.store.user![0]!.emailVerified).toBe(true);
});

test('revoking an unverified challenge invalidates it and a delayed verifier cannot restore consent', async () => {
  const app = fixture(); await app.login();
  await app.request('/phone-number/send-otp', consent());
  const code = app.codes[0]!;
  expect((await app.request('/phone-number/revoke-consent', {})).status).toBe(200);
  expect((await app.request('/phone-number/verify', proof(code))).status).toBe(400);
  expect(app.store.verification).toHaveLength(0);
  expect(app.store.smsOptIn![0]!.verifiedAt).toBeNull();
});

test('revocation during verification wins the consent compare-and-swap', async () => {
  const app = fixture(); await app.login();
  await app.request('/phone-number/send-otp', consent());
  app.duringUserUpdate(async () => { expect((await app.request('/phone-number/revoke-consent', {})).status).toBe(200); });
  expect((await app.request('/phone-number/verify', proof(app.codes[0]!))).status).toBe(400);
  expect(app.store.smsOptIn![0]!.verifiedAt).toBeNull();
  expect(app.store.smsOptIn![0]!.revokedAt).toBeInstanceOf(Date);
});

test('codes and recipients are bound to the initiating account, not reusable by another session', async () => {
  const app = fixture(); await app.login();
  await app.request('/phone-number/send-otp', consent());
  app.store.user!.push({ ...app.store.user![0], id: 'second-user', email: 'second@example.test' });
  await app.login('second@example.test');
  expect((await app.request('/phone-number/verify', proof(app.codes[0]!))).status).toBe(400);
  expect(app.store.user!.find(user => user.id === 'second-user')!.phoneNumberVerified).toBe(false);
  expect(app.store.smsOptIn![0]!.userId).toBe('sms-user');
});

test('an existing phone belonging to another account cannot be claimed', async () => {
  const app = fixture(); await app.login();
  app.store.user!.push({ ...app.store.user![0], id: 'phone-owner', email: 'owner@example.test', phoneNumber: phone, phoneNumberVerified: true });
  expect((await app.request('/phone-number/send-otp', consent())).status).toBe(400);
  expect(app.codes).toHaveLength(0);
  expect(app.store.smsOptIn).toHaveLength(0);
});

test('changing destination cannot bypass the account send budget', async () => {
  const app = fixture(); await app.login();
  expect((await app.request('/phone-number/send-otp', consent())).status).toBe(200);
  expect((await app.request('/phone-number/send-otp', consent('+12025550121'))).status).toBe(429);
  expect(app.codes).toHaveLength(1);
});

test('schema-not-ready does not query a new table or break established email authentication', async () => {
  const app = fixture({ BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY: 'false' }, { missingTable: true }); await app.login();
  expect(await (await app.request('/phone-number/opt-in')).json()).toEqual({ available: false, consentVersion: SMS_CONSENT_VERSION,
    optedIn: false, phoneNumber: null, phoneNumberVerified: false });
  expect((await app.request('/phone-number/send-otp', consent())).status).toBe(404);
  expect(app.consentReads()).toBe(0);
  expect((await app.request('/get-session')).status).toBe(200);
  expect(app.codes).toHaveLength(0);
});

test('missing migration after a readiness misconfiguration fails only SMS and redacts storage errors', async () => {
  const app = fixture({}, { missingTable: true }); await app.login();
  const response = await app.request('/phone-number/opt-in');
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('synthetic-private');
  expect((await app.request('/get-session')).status).toBe(200);
  expect(app.codes).toHaveLength(0);
});

test('disabled SMS or a WhatsApp-only configuration cannot silently switch channels', async () => {
  for (const configuration of [{ BETTER_AUTH_PHONE_OTP_ENABLED: 'false' }, { SENTDM_OTP_CHANNEL: 'whatsapp' }, { SENTDM_API_KEY: '' },
    { SENTDM_OTP_TEMPLATE_ID: 'not-an-approved-uuid' }, { SENTDM_OTP_PARAMETER: 'unsafe\nparameter' }]) {
    const app = fixture(configuration); await app.login();
    expect((await (await app.request('/phone-number/opt-in')).json() as { available: boolean }).available).toBe(false);
    expect((await app.request('/phone-number/send-otp', consent())).status).toBe(404);
    expect(app.codes).toHaveLength(0);
  }
});

test('provider failure is not confirmation, never retries, and invalidates the undelivered challenge', async () => {
  const app = fixture({}, { deliveryFails: true }); await app.login();
  const response = await app.request('/phone-number/send-otp', consent());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('synthetic-private');
  expect(app.codes).toHaveLength(1);
  expect(app.store.verification).toHaveLength(0);
  expect((await app.request('/phone-number/verify', proof(app.codes[0]!))).status).toBe(400);
  expect(app.store.smsOptIn![0]!.verifiedAt).toBeNull();
});

test('SMS cannot create a login session, reset a password, mutate email proof or accept another origin', async () => {
  const app = fixture(); await app.login();
  for (const path of ['/sign-in/phone-number', '/phone-number/request-password-reset', '/phone-number/reset-password']) {
    expect((await app.request(path, { phoneNumber: phone, code: '123456', password: 'Synthetic-Password-123' })).status).toBe(404);
  }
  expect((await app.request('/phone-number/send-otp', consent(), undefined, 'https://evil.example.test')).status).toBe(403);
  expect((await app.request('/phone-number/verify', { ...proof('123456'), disableSession: false })).status).toBe(400);
  expect((await app.request('/update-user', { phoneNumber: phone, phoneNumberVerified: true })).status).toBe(400);
  expect(app.codes).toHaveLength(0);
  expect(app.store.session).toHaveLength(1);
});
