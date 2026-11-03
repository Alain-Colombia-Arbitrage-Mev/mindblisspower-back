import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { hashPassword } from 'better-auth/crypto';
import { secureSessionHandler } from './secure-session-handler';
import { createAuthOptions } from './options';
import type { DBAdapter } from '@better-auth/core/db/adapter';

test('only POST password login creates a guarded auth instance; other routes retain native lifecycle', async () => {
  let delegated = 0;
  const handler = secureSessionHandler(async () => { delegated++; return Response.json({ original: true }); },
    () => { throw new Error('must not build scoped options'); }, {} as never);
  for (const [path, method] of [['/sign-in/email', 'GET'], ['/sign-in/email-otp', 'POST'], ['/sign-up/email', 'POST'],
    ['/email-otp/reset-password', 'POST'], ['/get-session', 'GET'], ['/sign-out', 'POST']]) {
    const result = await handler(new Request(`https://auth.example.test/api/auth${path}`, { method }));
    expect(await result.json()).toEqual({ original: true });
  }
  expect(delegated).toBe(6);
});

test('scoped login setup failures are secret-free and never clear/install cookies', async () => {
  const handler = secureSessionHandler(async () => { throw new Error('not fallback'); },
    () => { throw new Error('Synthetic private database diagnostics'); }, {} as never);
  const result = await handler(new Request('https://auth.example.test/api/auth/sign-in/email', { method: 'POST' }));
  expect(result.status).toBe(500);
  expect(result.headers.has('set-cookie')).toBe(false);
  expect(result.headers.has('set-auth-jwt')).toBe(false);
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(await result.text()).not.toContain('Synthetic');
});

async function logoutFixture() {
  const password = 'Synthetic-Logout-Password-123';
  const store: MemoryDB = { user: [{ id: 'logout-member', name: 'Synthetic Logout', email: 'logout@example.test',
    emailVerified: true, createdAt: new Date(), updatedAt: new Date() }],
    account: [{ id: 'logout-credential', userId: 'logout-member', accountId: 'logout-member', providerId: 'credential',
      password: await hashPassword(password), createdAt: new Date(), updatedAt: new Date() }],
    session: [], verification: [], rateLimit: [], jwks: [] };
  let rejectDelete = false;
  let attempts = 0;
  const options = createAuthOptions({ BETTER_AUTH_SECRET: 'synthetic-logout-secret-with-at-least-thirty-two-characters',
    BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'false', BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'false' },
  (configuration: Parameters<ReturnType<typeof memoryAdapter>>[0]) => {
    const base = memoryAdapter(store)(configuration);
    const adapter: DBAdapter = { ...base, deleteMany: async input => {
      if (input.model === 'session') { attempts++; if (rejectDelete) throw new Error('Synthetic private logout database error'); }
      return base.deleteMany(input);
    } };
    return adapter;
  }, { provision: async () => ({ status: 'existing' }), binding: async () => ({ status: 'claim_required' }) },
  { email: async () => { throw new Error('No real messages'); }, phone: async () => { throw new Error('No SMS'); } });
  // Better Auth disables origin checks implicitly in test mode. Exercise the
  // real production protection explicitly instead of inheriting that shortcut.
  options.advanced = { ...options.advanced, disableOriginCheck: false, disableCSRFCheck: false };
  const native = betterAuth(options);
  const request = (path: string, body?: unknown, cookie = '', origin = 'https://portal.example.test') => native.handler(new Request(
    `https://auth.example.test/api/auth${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const signedIn = await request('/sign-in/email', { email: 'logout@example.test', password });
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  expect(cookie.length).toBeGreaterThan(0);
  return { store, request, cookie, reject: (value: boolean) => { rejectDelete = value; }, attempts: () => attempts };
}

test('logout rejects failed persistent revocation without pretending success; same cookie can retry safely', async () => {
  const app = await logoutFixture(); app.reject(true);
  const failed = await app.request('/sign-out', {}, app.cookie);
  expect(failed.status).toBe(503);
  expect(failed.headers.has('set-cookie')).toBe(false);
  expect(await failed.text()).not.toContain('Synthetic');
  expect(app.store.session).toHaveLength(1);
  expect(await (await app.request('/get-session', undefined, app.cookie)).json()).toMatchObject({ user: { id: 'logout-member' } });
  app.reject(false);
  const retried = await app.request('/sign-out', {}, app.cookie);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toEqual({ success: true });
  expect(app.store.session).toHaveLength(0);
  expect(await (await app.request('/get-session', undefined, app.cookie)).json()).toBeNull();
});

test('cross-origin logout and an invalid signed cookie cannot delete an authenticated session', async () => {
  const app = await logoutFixture();
  const foreign = await app.request('/sign-out', {}, app.cookie, 'https://untrusted.example.test');
  expect(foreign.status).toBe(403);
  expect(app.attempts()).toBe(0);
  expect(app.store.session).toHaveLength(1);
  const invalid = await app.request('/sign-out', {}, '__Secure-better-auth.session_token=synthetic.invalid');
  expect(invalid.status).toBe(200);
  expect(app.attempts()).toBe(0);
  expect(app.store.session).toHaveLength(1);
});
