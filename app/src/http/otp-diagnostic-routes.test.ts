import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { registerOtpDiagnosticRoutes, registerOtpTraceReadiness, OTP_DIAGNOSTIC_PATH, OTP_READINESS_PATH } from './otp-diagnostic-routes';
import { createRequireAdmin } from '../server/admin-gate';
import type { Principal } from '../modules/identity/model';
import type { ApiEnvironment } from './types';
import type { OtpDiagnostic } from '../auth/otp-diagnostic';

const secret = 'synthetic-otp-routes-shared-secret-at-least32';
const env = { AUTH_OTP_TRACE_ENABLED: 'true', AUTH_BFF_SHARED_SECRET: secret, BETTER_AUTH_TRUSTED_ORIGINS: 'https://admin.example.test' };
const body = '{"email":"synthetic@example.test"}', cookie = 'better-auth.session_token=synthetic';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const diagnostic: OtpDiagnostic = { provider: 'better-auth', account_exists: true, email_verified: false, blocked: false,
  active_affiliate: true, binding_exists: true, ambiguous: false, cooldown_remaining_seconds: 12,
  recipient_ref: 'a'.repeat(64), diagnosis: 'cooldown_active', checked_at: new Date().toISOString() };
const principal: Principal = { subject: 'admin-fixture', auth_email: 'admin@example.test', email_verified: true, name: 'Synthetic',
  person_id: '7', public_id: '00000000-0000-4000-8000-000000000071', person_email: 'admin@example.test', person_status: 'active',
  blacklisted: false, user_id: 'admin-fixture', is_admin: true, access_restricted: false };
function headers(path: string, raw = body, sessionCookie = cookie, ip = '192.0.2.71') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { 'content-type': 'application/json', 'x-vp-auth-client-ip': ip, 'x-vp-auth-timestamp': timestamp,
    'x-vp-auth-signature': createHmac('sha256', secret).update(['POST', path, timestamp, ip, hash(sessionCookie), hash(raw)].join('\n')).digest('hex'),
    ...(sessionCookie ? { cookie: sessionCookie } : {}), ...(path === OTP_DIAGNOSTIC_PATH ? { origin: 'https://admin.example.test' } : {}) };
}

test('only signed full-path requests with native session and live canonical admin reach read-only lookup', async () => {
  const app = new Hono<ApiEnvironment>(); let calls = 0, lookups = 0; let current: Principal = principal;
  app.use('/api/*', async (c, next) => { c.set('session', { user: { id: principal.subject } } as never); await next(); });
  registerOtpDiagnosticRoutes(app, env, async input => { calls++; expect(input).toEqual({ email: 'synthetic@example.test' }); return diagnostic; },
    createRequireAdmin(async subject => { lookups++; expect(subject).toBe(principal.subject); return current; }));
  const first = await app.request(OTP_DIAGNOSTIC_PATH, { method: 'POST', headers: headers(OTP_DIAGNOSTIC_PATH), body });
  expect(first.status).toBe(200); expect(await first.json()).toEqual(diagnostic);
  expect(first.headers.get('cache-control')).toBe('private, no-store');
  for (const path of ['/api/auth/otp-diagnostic', '/api/admin/auth/other']) {
    expect((await app.request(OTP_DIAGNOSTIC_PATH, { method: 'POST', headers: headers(path), body })).status).toBe(403);
  }
  expect((await app.request(OTP_DIAGNOSTIC_PATH, { method: 'POST', headers: { ...headers(OTP_DIAGNOSTIC_PATH), cookie: 'tampered' }, body })).status).toBe(403);
  expect((await app.request(`${OTP_DIAGNOSTIC_PATH}?email=ignored`, { method: 'POST', headers: headers(OTP_DIAGNOSTIC_PATH), body })).status).toBe(400);
  expect((await app.request(OTP_DIAGNOSTIC_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(403);
  for (const origin of ['', 'null', 'https://evil.example.test', 'https://admin.example.test.evil.test',
    'https://admin.example.test/', 'https://admin.example.test/path', 'http://admin.example.test']) {
    expect((await app.request(OTP_DIAGNOSTIC_PATH, { method: 'POST', headers: { ...headers(OTP_DIAGNOSTIC_PATH), origin }, body })).status).toBe(403);
  }
  current = { ...principal, is_admin: false };
  expect((await app.request(OTP_DIAGNOSTIC_PATH, { method: 'POST', headers: headers(OTP_DIAGNOSTIC_PATH), body })).status).toBe(403);
  expect(calls).toBe(1); expect(lookups).toBe(2);
});

test('missing/expired/restricted admin, absent proxy config and query/database errors are generic private failures', async () => {
  for (const [user, row, expected] of [[undefined, principal, 401], [principal.subject, { ...principal, access_restricted: true }, 403],
    [principal.subject, null, 403]] as const) {
    const app = new Hono<ApiEnvironment>();
    app.use('/api/*', async (c, next) => { c.set('session', { user: { id: user } } as never); await next(); });
    registerOtpDiagnosticRoutes(app, env, async () => { throw Error('Must not reach metadata'); }, createRequireAdmin(async () => row));
    const response = await app.request(OTP_DIAGNOSTIC_PATH, { method: 'POST', headers: headers(OTP_DIAGNOSTIC_PATH), body });
    expect(response.status).toBe(expected); expect(response.headers.get('cache-control')).toBe('private, no-store');
  }
  const pass = async (_c: unknown, next: () => Promise<void>) => { await next(); };
  for (const configuration of [{}, { AUTH_BFF_SHARED_SECRET: 'short' }]) {
    const app = new Hono<ApiEnvironment>(); registerOtpDiagnosticRoutes(app, configuration, async () => diagnostic, pass);
    expect((await app.request(OTP_DIAGNOSTIC_PATH, { method: 'POST', headers: headers(OTP_DIAGNOSTIC_PATH), body })).status).toBe(503);
  }
  const app = new Hono<ApiEnvironment>();
  registerOtpDiagnosticRoutes(app, env, async () => { throw Error('private-sql-params'); }, pass);
  const failure = await app.request(OTP_DIAGNOSTIC_PATH, { method: 'POST', headers: headers(OTP_DIAGNOSTIC_PATH), body });
  expect(failure.status).toBe(503); expect(await failure.text()).toBe('{"error":"otp_diagnostic_unavailable"}');
});

test('diagnostic accepts strict bounded JSON only; invalid bodies never reach lookup', async () => {
  const app = new Hono<ApiEnvironment>(); let calls = 0;
  registerOtpDiagnosticRoutes(app, env, async () => { calls++; return diagnostic; }, async (_c, next) => { await next(); });
  for (const raw of ['{}', '{"email":9}', '{"email":"not-email"}', '{"email":"synthetic@example.test","otp":"654321"}', 'malformed']) {
    expect((await app.request(OTP_DIAGNOSTIC_PATH, { method: 'POST', headers: headers(OTP_DIAGNOSTIC_PATH, raw), body: raw })).status).toBe(400);
  }
  const huge = 'x'.repeat(1025);
  expect((await app.request(OTP_DIAGNOSTIC_PATH, { method: 'POST', headers: headers(OTP_DIAGNOSTIC_PATH, huge), body: huge })).status).toBe(413);
  expect((await app.request(OTP_DIAGNOSTIC_PATH, { method: 'POST', headers: { ...headers(OTP_DIAGNOSTIC_PATH), 'content-type': 'text/plain' }, body })).status).toBe(400);
  expect(calls).toBe(0);
});

test('readiness probes only exact signed private authority, no session/DB/provider and strict sink ACK', async () => {
  const app = new Hono<ApiEnvironment>(); let probes = 0;
  registerOtpTraceReadiness(app, env, (async (url, init) => {
    probes++; expect(url).toBe('https://observability.core.internal/v1/probe'); expect(init!.body).toBe('{}');
    expect(init!.credentials).toBe('omit'); expect(init!.redirect).toBe('error');
    const received = new Headers(init!.headers), timestamp = received.get('x-vp-observation-timestamp')!;
    expect(received.get('x-vp-observation-signature')).toBe(createHmac('sha256', secret)
      .update(['POST', '/v1/probe', timestamp, hash('{}')].join('\n')).digest('hex'));
    return Response.json({ recorded: true });
  }) as typeof fetch);
  app.use('/api/*', () => { throw Error('Never use auth or DB'); });
  const signed = headers(OTP_READINESS_PATH, '{}', '', '127.0.0.1');
  const good = await app.request(OTP_READINESS_PATH, { method: 'POST', headers: signed, body: '{}' });
  expect(good.status).toBe(200); expect(await good.json()).toEqual({ ready: true });
  expect(good.headers.get('cache-control')).toBe('private, no-store');
  for (const changed of [{ cookie: '' }, { authorization: 'Bearer synthetic' }, { 'x-vp-auth-client-ip': '192.0.2.71' },
    { 'x-vp-auth-signature': 'a'.repeat(64) }, { 'x-vp-auth-timestamp': '1000000000' }, { 'content-type': 'text/plain' }]) {
    const modified = new Headers(signed); for (const [key, value] of Object.entries(changed)) if (value !== undefined) modified.set(key, value);
    expect((await app.request(OTP_READINESS_PATH, { method: 'POST', headers: modified, body: '{}' })).status).toBe(503);
  }
  for (const raw of ['', '[]', ' {}', '{ }', '{"email":"synthetic@example.test"}']) {
    expect((await app.request(OTP_READINESS_PATH, { method: 'POST', headers: headers(OTP_READINESS_PATH, raw, '', '127.0.0.1'), body: raw })).status).toBe(503);
  }
  expect((await app.request(`${OTP_READINESS_PATH}?extra=1`, { method: 'POST', headers: signed, body: '{}' })).status).toBe(503);
  expect(probes).toBe(1);
});

test('readiness remains disabled independently of email monitoring and never claims readiness on bad ACK', async () => {
  for (const flag of [undefined, 'false', 'TRUE', 'true ']) {
    const app = new Hono<ApiEnvironment>();
    registerOtpTraceReadiness(app, { ...env, AUTH_OTP_TRACE_ENABLED: flag, AUTH_OBSERVABILITY_ENABLED: 'true' }, (() => { throw Error('No probe'); }) as unknown as typeof fetch);
    expect((await app.request(OTP_READINESS_PATH, { method: 'POST', headers: headers(OTP_READINESS_PATH, '{}', '', '127.0.0.1'), body: '{}' })).status).toBe(503);
  }
  for (const response of [Response.json({ recorded: false }), Response.json({ recorded: true, extra: true }), Response.json({ recorded: true }, { status: 202 })]) {
    const app = new Hono<ApiEnvironment>(); registerOtpTraceReadiness(app, env, (async () => response) as unknown as typeof fetch);
    const result = await app.request(OTP_READINESS_PATH, { method: 'POST', headers: headers(OTP_READINESS_PATH, '{}', '', '127.0.0.1'), body: '{}' });
    expect(result.status).toBe(503); expect(await result.json()).toEqual({ error: 'otp_trace_unavailable' });
  }
});
