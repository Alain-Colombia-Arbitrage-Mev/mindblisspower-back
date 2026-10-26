import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { createAuthOptions } from './options';
import type { AuthEnvironment, EmailMessage } from './delivery';
import type { RegistrationCandidate } from './registration';
import { validContactPhone } from './registration-contacts';

const email = 'contact-registration@example.test';
const phone = '+573001234567';
const whatsapp = '+12025550123';
const env: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-registration-contact-secret-at-least-32-characters',
  BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
  BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false',
  // A forgotten flag or provider key must never re-enable registration SMS.
  BETTER_AUTH_REGISTRATION_SMS_REQUIRED: 'true',
  CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001',
  CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-not-real', AUTH_EMAIL_FROM: 'auth@example.test',
  SENTDM_API_KEY: 'synthetic-not-real', SENTDM_OTP_TEMPLATE_ID: '00000000-0000-4000-8000-000000000001', SENTDM_OTP_CHANNEL: 'sms',
};
function fixture() {
  const store: MemoryDB = { user: [], session: [], verification: [], rateLimit: [], account: [], jwks: [] };
  const emails: EmailMessage[] = [];
  const candidates: RegistrationCandidate[] = [];
  let sms = 0;
  const auth = betterAuth(createAuthOptions(env, memoryAdapter(store), {
    provision: async () => ({ status: 'verification_required' }), binding: async () => ({ status: 'claim_required' }),
    registrationAllowed: async candidate => { candidates.push(candidate); return true; },
  }, { email: async message => { emails.push(message); }, phone: async () => { sms++; } }));
  let ip = 1;
  const request = (path: string, body?: unknown, cookie = '') => auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: 'https://portal.example.test', 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${ip++}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const signup = (extra: Record<string, unknown> = {}) => request('/sign-up/email', {
    name: 'Synthetic Contact Member', email, password: 'Synthetic-Contact-Password-123', ...extra,
  });
  return { store, emails, candidates, request, signup, sms: () => sms };
}

test('canonical contacts validate country-specific possible lengths without a worldwide eight-digit minimum', () => {
  for (const value of [phone, whatsapp, '+6838888']) expect(validContactPhone(value)).toBe(true);
  for (const value of ['', '573001234567', '+9993001234567', '+5730', '+57 3001234567', '+12025550123 ext. 7', '+12025550123;ext=7', '+0123456789', '+1202555012345678']) {
    expect(validContactPhone(value)).toBe(false);
  }
});

test('phone and WhatsApp persist as unverified contacts, hidden from auth responses, without sending SMS', async () => {
  const app = fixture();
  const response = await app.signup({ contactPhone: phone, contactWhatsapp: whatsapp });
  expect(response.status).toBe(200);
  expect(app.store.user![0]).toMatchObject({ email, contactPhone: phone, contactWhatsapp: whatsapp, emailVerified: false });
  expect(app.store.user![0]!.phoneNumber).toBeUndefined();
  expect(app.store.user![0]!.phoneNumberVerified).not.toBe(true);
  expect(app.candidates[0]!.phone).toBe(phone);
  const payload = await response.json() as { token: unknown; user: Record<string, unknown> };
  expect(payload.token).toBeNull();
  expect(payload.user.contactPhone).toBeUndefined();
  expect(payload.user.contactWhatsapp).toBeUndefined();
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(app.store.session).toHaveLength(0);
  expect(app.emails).toHaveLength(1);
  expect(app.sms()).toBe(0);
});

test('contacts are optional, independent, non-unique and do not require a proof cookie or SMS consent', async () => {
  for (const extra of [{}, { contactPhone: phone }, { contactWhatsapp: whatsapp }, { contactPhone: '+6838888' },
    { contactPhone: '', contactWhatsapp: '  ' }]) {
    const app = fixture();
    expect((await app.signup(extra)).status).toBe(200);
    expect(app.sms()).toBe(0);
    expect(app.store.session).toHaveLength(0);
  }
  const app = fixture();
  expect((await app.signup({ contactPhone: phone, contactWhatsapp: phone })).status).toBe(200);
  expect((await app.signup({ email: 'another-contact@example.test', contactPhone: phone, contactWhatsapp: phone })).status).toBe(200);
  expect(app.store.user).toHaveLength(2);
});

test('malformed, noncanonical or nonstring contacts cannot be saved or trigger email delivery', async () => {
  for (const field of ['contactPhone', 'contactWhatsapp']) {
    for (const value of [null, '3001234567', '+9993001234567', '+12025550123x9', true, 573001234567, { number: phone }]) {
      const app = fixture();
      const response = await app.signup({ [field]: value });
      expect(response.status).toBe(400);
      expect(app.store.user).toHaveLength(0);
      expect(app.emails).toHaveLength(0);
      expect(app.sms()).toBe(0);
    }
  }
});

test('email proof remains mandatory and does not mark a contact phone verified or create a session', async () => {
  const app = fixture();
  expect((await app.signup({ contactPhone: phone, contactWhatsapp: whatsapp })).status).toBe(200);
  expect((await app.request('/sign-in/email', { email, password: 'Synthetic-Contact-Password-123' })).status).toBe(403);
  const otp = /\b(\d{6})\b/.exec(app.emails[0]!.text)![1]!;
  expect((await app.request('/email-otp/verify-email', { email, otp })).status).toBe(200);
  expect(app.store.user![0]!.emailVerified).toBe(true);
  expect(app.store.user![0]!.phoneNumberVerified).not.toBe(true);
  expect(app.store.session).toHaveLength(0);
  const login = await app.request('/sign-in/email', { email, password: 'Synthetic-Contact-Password-123' });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const session = await app.request('/get-session', undefined, cookie);
  const payload = await session.json() as { user: Record<string, unknown> };
  expect(payload.user.emailVerified).toBe(true);
  expect(payload.user.contactPhone).toBeUndefined();
  expect(payload.user.contactWhatsapp).toBeUndefined();
  expect(app.sms()).toBe(0);
});

test('obsolete registration SMS and telephone login stay unavailable even with stale activation flags and credentials', async () => {
  const app = fixture();
  for (const path of ['/registration/phone/send', '/registration/phone/verify', '/sign-in/phone-number']) {
    expect((await app.request(path, { email, phoneNumber: phone, code: '123456', consent: true })).status).toBe(404);
  }
  expect(app.store.user).toHaveLength(0);
  expect(app.store.verification).toHaveLength(0);
  expect(app.emails).toHaveLength(0);
  expect(app.sms()).toBe(0);
});

test('caller-supplied native authentication phone claims cannot convert a contact into verified possession', async () => {
  for (const extra of [{ phoneNumber: phone }, { phoneNumberVerified: true }, { phoneNumberVerified: false }]) {
    const app = fixture();
    expect((await app.signup({ contactPhone: phone, contactWhatsapp: whatsapp, ...extra })).status).toBe(400);
    expect(app.store.user).toHaveLength(0);
    expect(app.emails).toHaveLength(0);
    expect(app.sms()).toBe(0);
  }
});
