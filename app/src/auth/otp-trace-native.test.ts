import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { createAuthOptions } from './options';
import { createAuthDelivery } from './delivery';
import { otpTraceHandler, traceMessageRef, traceRecipientRef, type OtpTraceEvent } from './otp-trace';
import { otpHash } from './phone-otp';

// Real installed native handlers; memory-only identities and mock provider.
// No actual OTP, credential, HTTP provider or database connection is used.
test('native send, cooldown, code consumption and unknown account retain auth outcomes while emitting safe metadata', async () => {
  const email = 'native-trace@example.test', secret = 'synthetic-native-trace-secret-with-at-least32';
  const config = { AUTH_OTP_TRACE_ENABLED: 'true', AUTH_BFF_SHARED_SECRET: secret,
    BETTER_AUTH_SECRET: 'synthetic-auth-key-at-least-32-characters', BETTER_AUTH_URL: 'https://auth.example.test',
    BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test', BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false',
    AUTH_EMAIL_PROVIDER: 'resend', AUTH_EMAIL_FROM: 'otp@example.test', RESEND_API_KEY: 're_synthetic_no_provider' };
  const store: MemoryDB = { user: [{ id: 'synthetic-subject', email, emailVerified: false, name: 'Synthetic', createdAt: new Date(), updatedAt: new Date() }],
    account: [], session: [], verification: [], rateLimit: [], jwks: [] };
  const providerId = 'abcdef12-0000-4000-8000-000000000071'; let sends = 0, code = '';
  const delivery = createAuthDelivery(config, (async (url, init) => {
    expect(url).toBe('https://api.resend.com/emails'); sends++;
    const payload = JSON.parse(init!.body as string) as { text?: string; template?: { variables: { OTP: string } } };
    code = payload.template?.variables.OTP ?? /\b(\d{6})\b/.exec(payload.text || '')![1]!;
    return Response.json({ id: providerId });
  }) as typeof fetch, () => {});
  const native = betterAuth(createAuthOptions(config, memoryAdapter(store), { provision: async () => ({ status: 'existing' }),
    binding: async () => ({ status: 'existing' }), registrationAllowed: async () => true }, delivery));
  const events: OtpTraceEvent[] = [];
  const handler = otpTraceHandler(native.handler, config, (async (_url, init) => {
    const raw = init!.body as string; expect(raw).not.toContain(email); expect(raw).not.toContain(providerId);
    events.push(JSON.parse(raw)); return Response.json({ recorded: true });
  }) as typeof fetch);
  const call = (path: string, body: unknown) => handler(new Request(`${config.BETTER_AUTH_URL}/api/auth${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://portal.example.test', 'x-vp-auth-client-ip': '192.0.2.71' }, body: JSON.stringify(body) }));
  expect((await call('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
  expect(sends).toBe(1); expect(code).toMatch(/^\d{6}$/);
  expect(store.verification![0]!.value).toBe(`${otpHash(config.BETTER_AUTH_SECRET, 'email-otp', code)}:0`);
  expect((await call('/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(429);
  const verified = await call('/sign-in/email-otp', { email, otp: code });
  expect(verified.status).toBe(200); expect(verified.headers.get('set-cookie')).toContain('better-auth.session_token');
  expect(store.session).toHaveLength(1); expect(store.user![0]!.emailVerified).toBe(true);
  const unknown = await call('/email-otp/send-verification-otp', { email: 'unknown-native@example.test', type: 'sign-in' });
  expect(unknown.status).toBe(400); expect((await unknown.json() as { code: string }).code).toBe('REGISTRATION_REQUIRED');
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(sends).toBe(1);
  expect(events.some(event => event.stage === 'registration_required')).toBe(true);
  expect(events.some(event => event.stage === 'throttled')).toBe(true);
  expect(events.some(event => event.stage === 'validation_succeeded')).toBe(true);
  expect(events.find(event => event.stage === 'send_accepted')?.message_ref).toBe(traceMessageRef(secret, providerId));
  expect(events.find(event => event.stage === 'send_accepted')?.recipient_ref).toBe(traceRecipientRef(secret, email));
});

for (const status of [422, 503]) {
  test(`MAIN login delivery HTTP${status} keeps explicit503, challenge policy and private trace classification`, async () => {
    const email = 'main-trace-failure@example.test', secret = 'synthetic-main-trace-failure-at-least32';
    const config = { AUTH_OTP_TRACE_ENABLED: 'true', AUTH_BFF_SHARED_SECRET: secret,
      BETTER_AUTH_SECRET: 'synthetic-main-auth-key-at-least32-characters', BETTER_AUTH_URL: 'https://auth.example.test',
      BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test', BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
      BETTER_AUTH_PHONE_OTP_ENABLED: 'false', AUTH_EMAIL_PROVIDER: 'resend', AUTH_EMAIL_FROM: 'otp@example.test',
      RESEND_API_KEY: 're_synthetic_main_no_provider' };
    const store: MemoryDB = { user: [{ id: 'synthetic-main-pending-user', email, emailVerified: false,
      name: 'Cuenta pendiente', createdAt: new Date(), updatedAt: new Date() }],
      account: [], session: [], verification: [], rateLimit: [], jwks: [] };
    let sends = 0, provisions = 0;
    const delivery = createAuthDelivery(config, (async url => {
      expect(url).toBe('https://api.resend.com/emails'); sends++;
      return Response.json({ message: 'private-provider-message' }, { status });
    }) as typeof fetch, () => {});
    const native = betterAuth(createAuthOptions(config, memoryAdapter(store), {
      provision: async () => { provisions++; return { status: 'claim_required' }; },
      binding: async () => ({ status: 'claim_required' }), registrationAllowed: async () => true,
    }, delivery));
    const events: OtpTraceEvent[] = [];
    const handler = otpTraceHandler(native.handler, config, (async (_url, init) => {
      const raw = init!.body as string;
      expect(raw).not.toContain(email); expect(raw).not.toContain('private-provider-message');
      events.push(JSON.parse(raw)); return Response.json({ recorded: true });
    }) as typeof fetch);
    const send = () => handler(new Request(`${config.BETTER_AUTH_URL}/api/auth/email-otp/send-verification-otp`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://portal.example.test',
        'x-vp-auth-client-ip': '192.0.2.72' }, body: JSON.stringify({ email, type: 'sign-in' }),
    }));
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'AUTH_EMAIL_DELIVERY_UNAVAILABLE',
      message: 'Email verification is temporarily unavailable. Request a new code later.' });
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('set-auth-jwt')).toBe(false);
    expect(store.verification).toHaveLength(status === 422 ? 0 : 1);
    expect(store.user![0]!.emailVerified).toBe(false);
    expect(store.account).toHaveLength(0); expect(store.session).toHaveLength(0); expect(provisions).toBe(0);
    expect((await send()).status).toBe(429); expect(sends).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(events.some(event => event.stage === (status === 422 ? 'send_rejected' : 'send_unknown') && event.http_status === status)).toBe(true);
    expect(events.some(event => event.stage === 'request_failed' && event.http_status === 503)).toBe(true);
    expect(events.some(event => event.stage === 'throttled' && event.http_status === 429)).toBe(true);
    expect(events.some(event => event.stage === 'validation_succeeded')).toBe(false);
  });
}
