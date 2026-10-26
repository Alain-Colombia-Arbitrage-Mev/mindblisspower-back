import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { authProxyContext } from './auth-proxy-context';

test('signed BFF IP context rejects forged, stale or changed requests before auth', async () => {
  const secret = 'synthetic-auth-proxy-secret-longer-than-32';
  const app = new Hono();
  let calls = 0;
  app.use('/api/auth/*', authProxyContext(secret));
  app.all('/api/auth/*', c => { calls++; return c.json({ ok: true }); });
  const body = '{"email":"synthetic@example.test"}';
  const time = String(Math.floor(Date.now() / 1000));
  const cookie = 'better-auth.session_token=synthetic';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const signature = createHmac('sha256', secret).update(['POST', '/api/auth/sign-in/email', time, '192.0.2.10', hash(cookie), hash(body)].join('\n')).digest('hex');
  const headers = { 'x-vp-auth-client-ip': '192.0.2.10', 'x-vp-auth-timestamp': time, 'x-vp-auth-signature': signature, cookie };
  expect((await app.request('/api/auth/sign-in/email', { method: 'POST', headers, body })).status).toBe(200);
  for (const mutation of [{ 'x-vp-auth-client-ip': '192.0.2.11' }, { 'x-vp-auth-timestamp': '1000000000' }, { cookie: 'different=session' }, { 'x-vp-auth-signature': 'a'.repeat(64) }]) {
    expect((await app.request('/api/auth/sign-in/email', { method: 'POST', headers: { ...headers, ...mutation }, body })).status).toBe(403);
  }
  expect((await app.request('/api/auth/sign-in/email', { method: 'POST', headers, body: '{}' })).status).toBe(403);
  expect((await app.request('/api/auth/jwks')).status).toBe(200);
  expect(calls).toBe(2);
});
