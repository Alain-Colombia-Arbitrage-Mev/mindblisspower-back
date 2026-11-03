import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCore, dispatchContainerOutbound, authReady, coreReady } from '../src/routing.mjs';

const ready = Object.freeze({
  CORE_ENV: 'production', CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false',
  CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_SERVICES_ENABLED: 'true', AUTH_CUTOVER_VERIFIED: 'true',
});
const paths = ['/api/auth/email-otp/request-password-reset', '/api/auth/email-otp/reset-password'];
const request = (path, init = {}, origin = 'https://auth.core.internal') =>
  new Request(`${origin}${path}`, { method: 'POST', ...init });
const neverResolve = () => assert.fail('a rejected recovery request resolved a Container');

test('only the two exact OTP recovery POSTs reach API independently of broad Core networking', async () => {
  assert.equal(authReady(ready), true);
  assert.equal(coreReady(ready), false);
  for (const CORE_ENV of ['staging', 'production']) for (const path of paths) {
    let calls = 0;
    const response = await dispatchCore(request(path, { body: '{}' }), { ...ready, CORE_ENV }, (service, instance) => {
      calls++;
      assert.equal(service, 'api'); assert.equal(instance, 'singleton');
      return { fetch: async forwarded => {
        assert.equal(forwarded.url, `https://auth.core.internal${path}`);
        assert.equal(forwarded.method, 'POST');
        return Response.json({ synthetic: true });
      } };
    });
    assert.equal(response.status, 200); assert.equal(calls, 1);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('recovery requires literal verified auth/data/cutover gates and a reviewed environment', async () => {
  for (const key of ['AUTH_SERVICES_ENABLED', 'CORE_DATA_ACCESS_VERIFIED', 'AUTH_CUTOVER_VERIFIED']) {
    for (const value of [undefined, null, false, true, 'false', 'TRUE', '1', 'true ']) for (const path of paths) {
      const response = await dispatchCore(request(path), { ...ready, [key]: value }, neverResolve);
      assert.equal(response.status, 503, `${key}:${String(value)}:${path}`);
      assert.equal((await response.json()).error, 'core_not_ready');
    }
  }
  for (const CORE_ENV of [undefined, '', 'development', 'Production']) for (const path of paths) {
    assert.equal((await dispatchCore(request(path), { ...ready, CORE_ENV }, neverResolve)).status, 503);
  }
});

test('recovery rejects query, method, protocol, host, port, fragment and encoded path aliases before resolution', async () => {
  // Reports readiness must not provide an alternative path for these writes.
  const env = { ...ready, CORE_REPORTS_ENABLED: 'true' };
  for (const path of paths) {
    for (const suffix of ['/', '/extra', '?purpose=reset', '?email=other%40example.invalid']) {
      assert.equal((await dispatchCore(request(`${path}${suffix}`), env, neverResolve)).status, 503, path + suffix);
    }
    for (const alias of [path.replace('email-otp', 'email%2dotp'), path.replace('email-otp', '%65mail-otp'),
      path.replace('email-otp', 'email%252dotp'), path.replace('/email-otp/', '/email-otp%2f'),
      path.replace('/auth/', '//auth/'), path.replace('/email-otp/', '/EMAIL-OTP/')]) {
      assert.equal((await dispatchCore(request(alias), env, neverResolve)).status, 503, alias);
    }
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.equal((await dispatchCore(request(path, { method }), env, neverResolve)).status, 503, method);
    }
    for (const origin of ['http://auth.core.internal', 'https://core.internal', 'https://payments.core.internal',
      'https://withdrawals.core.internal', 'https://engine.core.internal']) {
      assert.equal((await dispatchCore(request(path, {}, origin), env, neverResolve)).status, 503, origin);
    }
    for (const origin of ['https://auth.core.internal:444', 'https://auth.core.internal.attacker.invalid', 'https://attacker.invalid']) {
      assert.equal((await dispatchCore(request(path, {}, origin), env, neverResolve)).status, 404, origin);
    }
    assert.equal((await dispatchCore(request(`${path}#fragment`), env, neverResolve)).status, 404);
    assert.equal((await dispatchCore(request(path, { headers: { upgrade: 'websocket' } }), env, neverResolve)).status, 405);
  }
});

test('OTP recovery does not open phone, email changes, credential writes, generic reset links or token writes', async () => {
  const blocked = ['/api/auth/request-password-reset', '/api/auth/reset-password', '/api/auth/set-password',
    '/api/auth/change-password', '/api/auth/change-email', '/api/auth/email-otp/change-email',
    '/api/auth/email-otp/check-verification-otp', '/api/auth/token', '/api/auth/admin/set-user-password',
    '/api/member/identity/claim'];
  for (const path of blocked) {
    const response = await dispatchCore(request(path), ready, neverResolve);
    assert.equal(response.status, 503, path);
  }
  for (const path of ['/api/auth/phone-number/request-password-reset', '/api/auth/phone-number/reset-password',
    '/api/auth/sign-in/phone-number', '/api/auth/registration/phone']) {
    assert.equal((await dispatchCore(request(path), ready, neverResolve)).status, 404, path);
  }
  for (const source of ['api', 'payments', 'withdrawals', 'engine']) for (const path of paths) {
    assert.equal((await dispatchContainerOutbound(source, request(path), ready, neverResolve)).status, 503);
  }
});

test('recovery forwards signed bytes and proxy context unchanged once, with redirects manual and secure cookies intact', async () => {
  for (const path of paths) {
    const body = '{ "email": "synthetic@example.invalid", "otp": "synthetic-only", "password": "not-a-real-credential" }\n';
    const input = request(path, { body, headers: {
      'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)),
      'x-vp-auth-signature': 'synthetic-signature', 'x-vp-auth-timestamp': 'synthetic-timestamp',
      'x-vp-auth-client-ip': '192.0.2.11', 'x-vp-auth-nonce': 'synthetic-nonce',
      cookie: '__Secure-session=synthetic', origin: 'https://portal.example.invalid',
      host: 'do-not-use-as-origin.invalid', 'cf-container-target-port': '50051',
    } });
    let calls = 0;
    const response = await dispatchCore(input, ready, (service, instance) => {
      calls++; assert.equal(service, 'api'); assert.equal(instance, 'singleton');
      return { fetch: async forwarded => {
        assert.equal(await forwarded.text(), body);
        assert.equal(forwarded.redirect, 'manual'); assert.equal(forwarded.signal.aborted, false);
        for (const [key, value] of Object.entries({
          'x-vp-auth-signature': 'synthetic-signature', 'x-vp-auth-timestamp': 'synthetic-timestamp',
          'x-vp-auth-client-ip': '192.0.2.11', 'x-vp-auth-nonce': 'synthetic-nonce',
          cookie: '__Secure-session=synthetic', origin: 'https://portal.example.invalid',
        })) assert.equal(forwarded.headers.get(key), value);
        for (const key of ['host', 'content-length', 'cf-container-target-port']) assert.equal(forwarded.headers.get(key), null);
        const headers = new Headers({ location: 'https://portal.example.invalid/login' });
        headers.append('set-cookie', '__Secure-session=synthetic; HttpOnly; Secure; SameSite=Lax');
        headers.append('set-cookie', '__Secure-other=synthetic; HttpOnly; Secure; SameSite=Lax');
        return new Response(null, { status: 302, headers });
      } };
    });
    assert.equal(calls, 1); assert.equal(response.status, 302);
    assert.equal(response.headers.getSetCookie().length, 2);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('recovery rejects oversized or invalid length bodies before resolving and sanitizes single-call upstream failures', async () => {
  for (const path of paths) {
    for (const [body, headers] of [['x'.repeat(256 * 1024 + 1), {}], ['{}', { 'content-length': String(256 * 1024 + 1) }],
      ['{}', { 'content-length': '-1' }], ['{}', { 'content-length': '1.5' }]]) {
      assert.equal((await dispatchCore(request(path, { body, headers }), ready, neverResolve)).status, 413);
    }
    for (const mode of ['throw', '500']) {
      let calls = 0;
      const response = await dispatchCore(request(path, { body: '{}' }), ready, () => ({ fetch: async () => {
        calls++;
        if (mode === 'throw') throw new Error('synthetic-private-context-must-not-escape');
        return new Response('synthetic-private-context-must-not-escape', { status: 500 });
      } }));
      assert.equal(calls, 1); assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'upstream_unavailable' });
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
  }
});
