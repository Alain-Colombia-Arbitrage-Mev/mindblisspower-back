import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dispatchCore, dispatchContainerOutbound, nowpaymentsCaptureReady, coreReady, TUNNEL_PROTOCOL } from '../src/routing.mjs';
import { containerEnvironment } from '../src/runtime-env.mjs';

const order = 'deadbeef-1234-5678-9abc-0123456789ab';
const ipnPath = '/api/webhooks/nowpayments';
const statusPath = `/api/payments/nowpayments/status?order_id=${order}`;
const signature = 'a'.repeat(128);
const capture = { CORE_ENV: 'production', CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false',
  CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_SERVICES_ENABLED: 'true', AUTH_CUTOVER_VERIFIED: 'true',
  CORE_REPORTS_ENABLED: 'false', NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED: 'true', STRIPE_CHECKOUT_ENABLED: 'false' };
const request = (path, init = {}, host = 'payments.core.internal') => new Request(`https://${host}${path}`, init);
const ipn = (path = ipnPath, init = {}, host) => request(path, { method: 'POST', body: '{ "synthetic": true }\n',
  headers: { 'content-type': 'application/json', 'x-nowpayments-sig': signature }, ...init }, host);
const neverStart = () => assert.fail('capture isolation must not start another service');

test('capture independently releases only the exact IPN and authenticated-own-status transport', async () => {
  assert.equal(coreReady(capture), false); assert.equal(nowpaymentsCaptureReady(capture), true);
  const bytes = new TextEncoder().encode('{ "synthetic": true }\n');
  const input = ipn(ipnPath, { body: bytes, headers: { 'content-type': 'application/json; charset=utf-8',
    'x-nowpayments-sig': signature, authorization: 'Bearer synthetic-service', 'cf-container-target-port': '50051' } });
  let calls = 0;
  const response = await dispatchCore(input, capture, (service, instance) => {
    calls++; assert.equal(service, 'payments'); assert.equal(instance, 'singleton');
    return { fetch: async forwarded => {
      assert.deepEqual(new Uint8Array(await forwarded.arrayBuffer()), bytes);
      assert.equal(forwarded.headers.get('x-nowpayments-sig'), signature);
      assert.equal(forwarded.headers.get('authorization'), 'Bearer synthetic-service');
      assert.equal(forwarded.headers.get('cf-container-target-port'), null);
      assert.equal(forwarded.headers.get('content-length'), null);
      assert.equal(forwarded.redirect, 'manual');
      return Response.json({ received: true, mode: 'capture_only', state: 'captured', fulfillment_status: 'not_activated' });
    } };
  });
  assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const result = await dispatchCore(request(statusPath, { headers: { authorization: 'Bearer synthetic-service',
    'x-vp-id-token': 'synthetic-owner-token' } }), capture, service => {
    assert.equal(service, 'payments'); return { fetch: async forwarded => {
      assert.equal(forwarded.headers.get('x-vp-id-token'), 'synthetic-owner-token');
      assert.equal(forwarded.url, `https://payments.core.internal${statusPath}`);
      return Response.json({ state: 'pending', fulfillment_status: 'not_activated' });
    } };
  });
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'private, no-store');
});

test('capture routes require literal flag and existing verified data/auth gates even with broad reports ready', async () => {
  for (const key of ['NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED', 'CORE_DATA_ACCESS_VERIFIED', 'AUTH_CUTOVER_VERIFIED', 'AUTH_SERVICES_ENABLED']) {
    for (const value of [undefined, 'false', 'TRUE', '1', true]) {
      const env = { ...capture, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true', CORE_REPORTS_ENABLED: 'true', [key]: value };
      assert.equal(nowpaymentsCaptureReady(env), false);
      for (const input of [ipn(), request(statusPath)]) assert.equal((await dispatchCore(input, env, neverStart)).status, 503);
    }
  }
  assert.equal((await dispatchCore(ipn(), { ...capture, CORE_ENV: 'development' }, neverStart)).status, 503);
});

test('capture cannot alias hosts, protocols, methods, paths or status ownership query parameters', async () => {
  for (const path of [ipnPath + '/', '/api/webhooks/%6eowpayments', '/api//webhooks/nowpayments', ipnPath + '?order_id=' + order]) {
    assert.equal((await dispatchCore(ipn(path), capture, neverStart)).status, 503, path);
  }
  for (const path of [statusPath + '&email=other@example.invalid', statusPath + '&order_id=' + order,
    '/api/payments/nowpayments/status', '/api/payments/nowpayments/status?order_id=invalid',
    '/api/payments/nowpayments/status?order_id=' + order.replace('d', '%64'),
    '/api/payments/nowpayments/status/?order_id=' + order]) {
    assert.equal((await dispatchCore(request(path), capture, neverStart)).status, 503, path);
  }
  for (const host of ['core.internal', 'auth.core.internal', 'withdrawals.core.internal', 'engine.core.internal']) {
    for (const input of [ipn(ipnPath, {}, host), request(statusPath, {}, host)]) {
      assert.equal((await dispatchCore(input, capture, neverStart)).status, 503);
    }
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await dispatchCore(request(ipnPath, { method }), capture, neverStart)).status, 503);
  }
  for (const method of ['POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await dispatchCore(request(statusPath, { method }), capture, neverStart)).status, 503);
  }
  assert.equal((await dispatchCore(new Request(`http://payments.core.internal${ipnPath}`, { method: 'POST' }), capture, neverStart)).status, 503);
});

test('capture rejects bad signature envelopes and bounded bodies without reading or rewriting signed JSON', async () => {
  for (const headers of [{}, { 'content-type': 'application/json' },
    { 'content-type': 'text/plain', 'x-nowpayments-sig': signature },
    { 'content-type': 'application/json', 'x-nowpayments-sig': 'bad' },
    { 'content-type': 'application/json', 'x-nowpayments-sig': signature, 'content-encoding': 'gzip' }]) {
    assert.equal((await dispatchCore(ipn(ipnPath, { headers }), capture, neverStart)).status, 400);
  }
  assert.equal((await dispatchCore(ipn(ipnPath, { body: '' }), capture, neverStart)).status, 400);
  for (const headers of [undefined, { 'content-type': 'application/json', 'x-nowpayments-sig': signature,
    'content-length': String(128 * 1024 + 1) }]) {
    const init = { body: 'x'.repeat(128 * 1024 + 1), ...(headers ? { headers } : {}) };
    assert.equal((await dispatchCore(ipn(ipnPath, init), capture, neverStart)).status, 413);
  }
});

test('capture never opens checkout, financial mutations, identity claims, Engine or unrelated reports', async () => {
  for (const path of ['/api/payments/checkout', '/api/payments/activate', '/api/admin/withdrawals/action',
    '/api/webhooks/stripe', '/api/member/identity/claim', '/api/admin/nowpayments/action']) {
    const input = request(path, { method: 'POST', body: '{"provider":"nowpayments"}' });
    assert.equal((await dispatchCore(input, capture, neverStart)).status, 503);
  }
  for (const path of ['/api/admin/sales', '/api/member/balance', '/api/nowpayments/events']) {
    assert.equal((await dispatchCore(request(path), capture, neverStart)).status, 503);
  }
  const tunnel = new Request('http://engine-grpc.core.internal/v1/engine-tunnel', { headers: {
    upgrade: 'websocket', 'sec-websocket-protocol': TUNNEL_PROTOCOL } });
  for (const input of [tunnel, new Request('http://engine.core.internal/ready')]) {
    assert.equal((await dispatchContainerOutbound('payments', input, capture, neverStart)).status, 503);
  }
});

test('capture sanitizes failed upstreams and never retries an event', async () => {
  const privateDetail = 'synthetic-secret-must-not-be-reflected';
  for (const fetch of [async () => { throw new Error(privateDetail); }, async () => new Response(privateDetail, { status: 500 })]) {
    let calls = 0;
    const response = await dispatchCore(ipn(), capture, () => ({ fetch: input => { calls++; return fetch(input); } }));
    assert.equal(response.status, 503); assert.equal(calls, 1);
    assert.doesNotMatch(await response.text(), new RegExp(privateDetail));
  }
});

test('provider egress is a fixed HTTPS existing-payment lookup only, with no redirects, invoices or retries', async () => {
  const input = new Request('https://api.nowpayments.io/v1/payment/123456789', { headers: { 'x-api-key': 'synthetic' } });
  let calls = 0;
  const output = await dispatchContainerOutbound('payments', input, capture, neverStart, async forwarded => {
    calls++; assert.equal(forwarded.url, input.url); assert.equal(forwarded.redirect, 'manual');
    assert.equal(forwarded.headers.get('x-api-key'), 'synthetic'); return Response.json({ synthetic: true });
  });
  assert.equal(output.status, 200); assert.equal(calls, 1);
  for (const [url, method] of [
    ['http://api.nowpayments.io/v1/payment/123', 'GET'], ['https://api.nowpayments.io/v1/invoice', 'POST'],
    ['https://api.nowpayments.io/v1/payment/123', 'POST'], ['https://api.nowpayments.io/v1/payment/0', 'GET'],
    ['https://api.nowpayments.io/v1/payment/%31', 'GET'], ['https://api.nowpayments.io/v1/payment/123?redirect=evil', 'GET'],
    ['https://api.nowpayments.io:444/v1/payment/123', 'GET'],
  ]) assert.equal((await dispatchContainerOutbound('payments', new Request(url, { method }), capture, neverStart, neverStart)).status, 404);
  assert.throws(() => new Request('https://user@api.nowpayments.io/v1/payment/123'));
  for (const source of ['api', 'engine', 'withdrawals']) {
    assert.equal((await dispatchContainerOutbound(source, input, capture, neverStart, neverStart)).status, 503);
  }
  assert.equal((await dispatchContainerOutbound('payments', input, { ...capture, NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED: 'false' }, neverStart, neverStart)).status, 503);
  calls = 0;
  const redirected = await dispatchContainerOutbound('payments', input, capture, neverStart, async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid' } });
  });
  assert.equal(redirected.status, 503); assert.equal(calls, 1);
});

const secrets = { ...capture,
  PAYMENTS_DATABASE_URL: 'postgres://reader.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
  PAYMENTS_SERVICE_TOKEN: 'synthetic-service', PAYMENTS_ROOT_AFFILIATE_ID: '50793', CORE_SUPER_ADMIN_EMAILS: 'owner@example.invalid',
  AUTH_JWT_ISSUER: 'https://portal.example.invalid', AUTH_JWT_AUDIENCE: 'synthetic',
  NOWPAYMENTS_WEBHOOK_DATABASE_URL: 'postgres://capture.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
  NOWPAYMENTS_API_KEY: 'synthetic-api', NOWPAYMENTS_IPN_SECRET: 'synthetic-ipn',
};

test('capture passes only dedicated NOW credentials and a separate same-target writer to read-only Payments', () => {
  const env = containerEnvironment('payments', { ...secrets, NOWPAYMENTS_MEMBERSHIPS_ENABLED: 'true',
    NOWPAYMENTS_ENV: 'sandbox', SERVICE_READ_ONLY: 'false', STRIPE_SECRET_KEY: 'must-not-forward' });
  assert.equal(env.DATABASE_URL, secrets.PAYMENTS_DATABASE_URL);
  assert.equal(env.NOWPAYMENTS_WEBHOOK_DATABASE_URL, secrets.NOWPAYMENTS_WEBHOOK_DATABASE_URL);
  assert.equal(env.NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED, 'true'); assert.equal(env.NOWPAYMENTS_ENV, 'production');
  assert.equal(env.NOWPAYMENTS_MEMBERSHIPS_ENABLED, 'false'); assert.equal(env.SERVICE_READ_ONLY, 'true');
  assert.equal(env.STRIPE_CHECKOUT_ENABLED, 'false'); assert.equal(env.STRIPE_SECRET_KEY, undefined);
  assert.equal(env.PAYMENTS_CART_REMINDER_ENABLED, 'false'); assert.equal(env.PAYMENTS_RECONCILE_INTERVAL_MIN, '0');
  assert.equal(env.COMMS_ENABLED, 'false'); assert.equal(env.NOWPAYMENTS_PUBLIC_KEY, undefined);
  for (const flag of [undefined, 'false', 'TRUE', '1', true]) {
    const disabled = { ...secrets, NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED: flag };
    for (const key of ['NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET', 'NOWPAYMENTS_WEBHOOK_DATABASE_URL']) {
      Object.defineProperty(disabled, key, { get() { assert.fail('disabled capture must not read provider secrets'); } });
    }
    const values = containerEnvironment('payments', disabled);
    assert.equal(values.NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED, 'false');
    assert.equal(values.NOWPAYMENTS_API_KEY, undefined); assert.equal(values.NOWPAYMENTS_WEBHOOK_DATABASE_URL, undefined);
  }
});

test('capture missing credentials or a shared, privileged, different-target or insecure writer fails closed', () => {
  for (const change of [
    { NOWPAYMENTS_API_KEY: '' }, { NOWPAYMENTS_IPN_SECRET: '' }, { NOWPAYMENTS_WEBHOOK_DATABASE_URL: '' },
    { NOWPAYMENTS_API_KEY: 'synthetic\r\ninjected' }, { NOWPAYMENTS_IPN_SECRET: 'x'.repeat(4097) },
    { NOWPAYMENTS_WEBHOOK_DATABASE_URL: secrets.PAYMENTS_DATABASE_URL },
    { NOWPAYMENTS_WEBHOOK_DATABASE_URL: 'postgres://postgres:synthetic@db.example.invalid/app?sslmode=verify-full' },
    { NOWPAYMENTS_WEBHOOK_DATABASE_URL: 'postgres://capture.branch:synthetic@different.invalid/app?sslmode=verify-full' },
    { NOWPAYMENTS_WEBHOOK_DATABASE_URL: 'postgres://capture.branch:synthetic@db.example.invalid/other?sslmode=verify-full' },
    { NOWPAYMENTS_WEBHOOK_DATABASE_URL: 'postgres://capture.branch:synthetic@db.example.invalid/app?sslmode=disable' },
    { NOWPAYMENTS_WEBHOOK_DATABASE_URL: secrets.NOWPAYMENTS_WEBHOOK_DATABASE_URL + '&options=unsafe' },
  ]) assert.throws(() => containerEnvironment('payments', { ...secrets, ...change }), error => !/postgres:|synthetic/.test(error.message));
});

test('checked-in release keeps general services closed and intercepts the provider by exact host', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  for (const name of ['staging', 'production']) {
    assert.equal(config.env[name].vars.NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED, String(name === 'production'));
    assert.equal(config.env[name].vars.NOWPAYMENTS_MEMBERSHIPS_ENABLED, String(name === 'production'));
    assert.equal(config.env[name].vars.STRIPE_CHECKOUT_ENABLED, 'false');
    assert.equal(config.env[name].vars.CORE_SERVICES_ENABLED, 'false');
    assert.equal(config.env[name].vars.CORE_NETWORK_VERIFIED, 'false');
  }
  const worker = readFileSync(new URL('../src/worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /\['payments', CorePayments, \['engine\.core\.internal', 'auth\.core\.internal', 'api\.nowpayments\.io'\]\]/);
});
