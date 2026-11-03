import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { verifyPassword } from 'better-auth/crypto';
import { createAuthOptions } from './options';
import { createAuthDelivery, type AuthEnvironment } from './delivery';
import { otpHash } from './phone-otp';
import { AUTH_OTP_RESEND_ALIASES } from './email-templates';

// Real installed Better Auth handlers and Resend transport with an in-memory
// adapter and injected HTTP responses. No database sockets or real messages.
const email = 'resend-flow-member@example.test';
const env: AuthEnvironment = { AUTH_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_synthetic_flow_not_real', AUTH_EMAIL_FROM: 'auth@example.test',
  BETTER_AUTH_SECRET: 'synthetic-resend-flow-secret-at-least-32-characters', BETTER_AUTH_URL: 'https://auth.example.test',
  BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test', BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
  BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'false' };
const acknowledgement = { id: '00000000-0000-4000-8000-000000000072' };
type Body = { from: string; to: string[]; subject: string; template: { id: string; variables: { OTP: string } } };
function fixture(status = 200, missing = false, transportFailure = false) {
  const store: MemoryDB = { user: missing ? [] : [{ id: 'synthetic-resend-flow-user', email, name: 'Synthetic Resend Member', emailVerified: false,
    createdAt: new Date(), updatedAt: new Date() }], account: [], session: [], verification: [], rateLimit: [], jwks: [] };
  const messages: Body[] = [];
  const provisions: string[] = [];
  const delivery = createAuthDelivery(env, (async (url, request) => {
    expect(url).toBe('https://api.resend.com/emails');
    const payload = JSON.parse(request?.body as string);
    expect(payload).not.toHaveProperty('html');
    expect(payload).not.toHaveProperty('text');
    messages.push(payload);
    if (transportFailure) throw new DOMException('Synthetic ambiguous Resend timeout', 'AbortError');
    return Response.json(status === 200 ? acknowledgement : { name: 'validation_error', message: 'Synthetic private provider failure' }, { status });
  }) as typeof fetch, () => {});
  const auth = betterAuth(createAuthOptions(env, memoryAdapter(store), {
    provision: async subject => { provisions.push(subject); return { status: 'claim_required' }; },
    binding: async () => ({ status: 'claim_required' }), registrationAllowed: async () => true,
  }, delivery));
  let nextIP = 100;
  const request = (path: string, body: unknown) => auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: 'POST', headers: { origin: 'https://portal.example.test', 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${nextIP++}` },
    body: JSON.stringify(body),
  }));
  const send = (recipient = email) => request('/email-otp/send-verification-otp', { email: recipient, type: 'sign-in' });
  const code = () => messages.at(-1)!.template.variables.OTP;
  return { store, messages, provisions, request, send, code };
}

test('Resend-backed login keeps native OTP proof, purpose, storage and session rules unchanged', async () => {
  const app = fixture();
  const sent = await app.send();
  expect(sent.status).toBe(200);
  expect(await sent.clone().json()).toEqual({ success: true });
  expect(sent.headers.has('set-cookie')).toBe(false);
  expect(app.messages).toHaveLength(1);
  expect(app.messages[0]!).toMatchObject({ from: env.AUTH_EMAIL_FROM, to: [email] });
  expect(app.messages[0]!.template.id).toBe(AUTH_OTP_RESEND_ALIASES['sign-in']);
  const otp = app.code();
  expect(app.store.verification![0]!.value).toBe(`${otpHash(env.BETTER_AUTH_SECRET!, 'email-otp', otp)}:0`);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.session).toHaveLength(0);
  expect(app.provisions).toHaveLength(0);
  const signedIn = await app.request('/sign-in/email-otp', { email, otp });
  expect(signedIn.status).toBe(200);
  expect(app.store.user![0]!.emailVerified).toBe(true);
  expect(app.store.session).toHaveLength(1);
  expect(app.store.verification).toHaveLength(0);
  expect(app.provisions).toEqual(['synthetic-resend-flow-user']);
  expect((await app.request('/sign-in/email-otp', { email, otp })).status).toBe(400);
  expect(app.messages).toHaveLength(1);
  const acknowledgementBody = await sent.text();
  for (const value of [otp, env.RESEND_API_KEY!, acknowledgement.id]) expect(acknowledgementBody).not.toContain(value);
});

test('Resend recovery creates a credential only after its native recovery OTP and never signs in', async () => {
  const app = fixture();
  const password = 'Synthetic-Resend-Recovery-Password-123';
  const sent = await app.request('/email-otp/request-password-reset', { email });
  expect(sent.status).toBe(200);
  expect(app.messages).toHaveLength(1);
  expect(app.store.verification![0]!.identifier).toBe(`forget-password-otp-${email}`);
  expect(app.messages[0]!.subject).toContain('restablecer');
  expect(app.messages[0]!.template.id).toBe(AUTH_OTP_RESEND_ALIASES['forget-password']);
  expect(app.store.account).toHaveLength(0);
  const reset = await app.request('/email-otp/reset-password', { email, otp: app.code(), password });
  expect(reset.status).toBe(200);
  expect(await reset.json()).toEqual({ success: true });
  expect(reset.headers.has('set-cookie')).toBe(false);
  expect(app.store.account).toHaveLength(1);
  expect(await verifyPassword({ hash: String(app.store.account![0]!.password), password })).toBe(true);
  expect(app.store.user![0]!.emailVerified).toBe(true);
  expect(app.store.session).toHaveLength(0);
  expect(app.provisions).toHaveLength(0);
});

test('confirmed Resend rejection preserves generic recovery privacy and recipient cooldown without fallback', async () => {
  const app = fixture(422);
  const sent = await app.send();
  expect(sent.status).toBe(200);
  expect(await sent.json()).toEqual({ success: true });
  expect(app.messages).toHaveLength(1);
  expect(app.store.verification).toHaveLength(0);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.session).toHaveLength(0);
  expect((await app.send()).status).toBe(429);
  expect(app.messages).toHaveLength(1);
  expect((await app.request('/sign-in/email-otp', { email, otp: app.code() })).status).toBe(400);
  const unknown = 'missing-resend-flow@example.test';
  const reset = await app.request('/email-otp/request-password-reset', { email: unknown });
  expect(reset.status).toBe(200);
  expect(await reset.json()).toEqual({ success: true });
  expect(app.messages).toHaveLength(1);
  expect(app.store.user).toHaveLength(1);
  expect(app.store.account).toHaveLength(0);
});

test('confirmed Resend registration failure leaves an unverified account without a session', async () => {
  const app = fixture(403, true);
  const response = await app.request('/sign-up/email', { email, name: 'Synthetic Registration', password: 'Synthetic-Registration-Password-123' });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'AUTH_EMAIL_DELIVERY_UNAVAILABLE' });
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(app.store.user).toHaveLength(1);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.session).toHaveLength(0);
  expect(app.store.verification).toHaveLength(0);
  expect(app.messages).toHaveLength(1);
  expect(app.messages[0]!.template.id).toBe(AUTH_OTP_RESEND_ALIASES['email-verification']);
});

test('native verification sends its fixed hosted alias but only redeeming the stored code verifies email', async () => {
  const app = fixture();
  const sent = await app.request('/email-otp/send-verification-otp', { email, type: 'email-verification' });
  expect(sent.status).toBe(200);
  expect(app.messages).toHaveLength(1);
  expect(app.messages[0]!.template.id).toBe(AUTH_OTP_RESEND_ALIASES['email-verification']);
  const otp = app.code();
  expect(otp).toMatch(/^[0-9]{6}$/);
  expect(app.store.verification![0]!.identifier).toBe(`email-verification-otp-${email}`);
  expect(app.store.verification![0]!.value).toBe(`${otpHash(env.BETTER_AUTH_SECRET!, 'email-otp', otp)}:0`);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.session).toHaveLength(0);
  const verified = await app.request('/email-otp/verify-email', { email, otp });
  expect(verified.status).toBe(200);
  expect(app.store.user![0]!.emailVerified).toBe(true);
  expect(app.store.session).toHaveLength(1);
  expect(app.messages).toHaveLength(1);
});

test('request-supplied hosted templates cannot override Better Auth purpose, recipient or generated code', async () => {
  const app = fixture();
  const sent = await app.request('/email-otp/send-verification-otp', { email, type: 'sign-in',
    template: { id: 'unapproved-template', variables: { OTP: 'injected-code', EMAIL: 'other@example.test' } } });
  expect(sent.status).toBe(200);
  expect(app.messages).toHaveLength(1);
  expect(app.messages[0]!.to).toEqual([email]);
  expect(app.messages[0]!.template).toEqual({ id: AUTH_OTP_RESEND_ALIASES['sign-in'], variables: { OTP: app.code() } });
  expect(app.code()).toMatch(/^[0-9]{6}$/);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.session).toHaveLength(0);
});

test('ambiguous Resend timeout or 5xx retains a potentially delivered code and never resends automatically', async () => {
  for (const transport of [false, true]) {
    const app = fixture(503, false, transport);
    expect((await app.send()).status).toBe(200);
    expect(app.store.verification).toHaveLength(1);
    expect((await app.request('/sign-in/email-otp', { email, otp: app.code() })).status).toBe(200);
    expect(app.store.user![0]!.emailVerified).toBe(true);
    expect(app.store.session).toHaveLength(1);
    expect(app.messages).toHaveLength(1);
  }
});

test('unknown Resend OTP login still requires registration without generating or sending a code', async () => {
  const app = fixture();
  const response = await app.send('missing-resend-flow@example.test');
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'REGISTRATION_REQUIRED' });
  expect(app.messages).toHaveLength(0);
  expect(app.store.user).toHaveLength(1);
  expect(app.store.verification).toHaveLength(0);
  expect(app.store.session).toHaveLength(0);
  expect(app.provisions).toHaveLength(0);
});

test('all three native hosted OTP purposes reject the two other consuming endpoints without spending their own challenge', async () => {
  const password = 'Synthetic-Cross-Purpose-Password-123';
  const purposes = ['sign-in', 'email-verification', 'forget-password'] as const;
  const destinations = {
    'sign-in': '/sign-in/email-otp',
    'email-verification': '/email-otp/verify-email',
    'forget-password': '/email-otp/reset-password',
  };
  for (const source of purposes) {
    const app = fixture();
    const sent = source === 'forget-password'
      ? await app.request('/email-otp/request-password-reset', { email })
      : await app.request('/email-otp/send-verification-otp', { email, type: source });
    expect(sent.status).toBe(200);
    expect(app.messages).toHaveLength(1);
    expect(app.messages[0]!.template.id).toBe(AUTH_OTP_RESEND_ALIASES[source]);
    const otp = app.code();
    const stored = app.store.verification![0]!.value;
    for (const target of purposes.filter(type => type !== source)) {
      const crossed = await app.request(destinations[target], { email, otp,
        ...(target === 'forget-password' ? { password } : {}) });
      expect(crossed.status).toBe(400);
      expect(app.store.user![0]!.emailVerified).toBe(false);
      expect(app.store.account).toHaveLength(0);
      expect(app.store.session).toHaveLength(0);
      expect(app.store.verification).toHaveLength(1);
      expect(app.store.verification![0]!.value).toBe(stored);
      expect(app.messages).toHaveLength(1);
    }
    const correct = await app.request(destinations[source], { email, otp,
      ...(source === 'forget-password' ? { password } : {}) });
    expect(correct.status).toBe(200);
    expect(app.store.verification).toHaveLength(0);
    expect(app.store.user![0]!.emailVerified).toBe(true);
    expect(app.store.session).toHaveLength(source === 'forget-password' ? 0 : 1);
    expect(app.store.account).toHaveLength(source === 'forget-password' ? 1 : 0);
    expect(app.messages).toHaveLength(1);
  }
});

test('an expired hosted registration-verification code cannot verify the pending account or create a session', async () => {
  const app = fixture();
  expect((await app.request('/email-otp/send-verification-otp', { email, type: 'email-verification' })).status).toBe(200);
  app.store.verification![0]!.expiresAt = new Date(Date.now() - 1000);
  const response = await app.request('/email-otp/verify-email', { email, otp: app.code() });
  expect(response.status).toBe(400);
  expect(response.headers.has('set-cookie')).toBe(false);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.account).toHaveLength(0);
  expect(app.store.session).toHaveLength(0);
  expect(app.messages).toHaveLength(1);
});
