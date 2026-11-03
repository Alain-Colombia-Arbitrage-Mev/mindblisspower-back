import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCore } from '../src/routing.mjs';

const path = '/api/payments/nowpayments/purchases';
const order = 'deadbeef-1234-5678-9abc-0123456789ab';
const env = { CORE_ENV: 'production', CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false',
  CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_SERVICES_ENABLED: 'true', AUTH_CUTOVER_VERIFIED: 'true', CORE_REPORTS_ENABLED: 'true',
  NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED: 'true', NOWPAYMENTS_OPERATIONAL_ENABLED: 'true', NOWPAYMENTS_MEMBERSHIPS_ENABLED: 'true',
  NOWPAYMENTS_ENGINE_ENABLED: 'true', STRIPE_CHECKOUT_ENABLED: 'false', PAYMENTS_SERVICE_TOKEN: 'synthetic-service-token' };
const headers = { 'content-type': 'application/json', 'x-vp-service-token': env.PAYMENTS_SERVICE_TOKEN, 'x-vp-id-token': 'synthetic.verified.jwt' };
const request = (suffix = '', init = {}, host = 'payments.core.internal') => new Request(`https://${host}${path}${suffix}`, { headers, ...init });
const post = (suffix, body = JSON.stringify({ order_id: order }), extra = {}) => request(suffix, { method: 'POST', body, ...extra });
const never = () => assert.fail('invalid purchase capability must not start any Container');

test('purchase history and explicit local actions forward once, without opening full Core writes', async () => {
  for (const input of [request(), post('/resume'), post('/cancel')]) {
    let calls = 0;
    const output = await dispatchCore(input, env, (service, instance) => {
      calls++; assert.equal(service, 'payments'); assert.equal(instance, 'singleton');
      return { fetch: async forwarded => {
        assert.equal(forwarded.url, input.url); assert.equal(forwarded.redirect, 'manual');
        assert.equal(forwarded.headers.get('x-vp-id-token'), headers['x-vp-id-token']);
        if (forwarded.method === 'POST') assert.deepEqual(await forwarded.json(), { order_id: order });
        return Response.json({ synthetic: true });
      } };
    });
    assert.equal(output.status, 200); assert.equal(calls, 1);
    assert.equal(output.headers.get('cache-control'), 'private, no-store');
  }
});

test('history survives a checkout pause, while resume and cancellation remain explicitly gated', async () => {
  for (const key of ['NOWPAYMENTS_OPERATIONAL_ENABLED', 'NOWPAYMENTS_MEMBERSHIPS_ENABLED', 'NOWPAYMENTS_ENGINE_ENABLED', 'NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED']) {
    const paused = { ...env, [key]: 'false' };
    const history = await dispatchCore(request(), paused, () => ({ fetch: async () => Response.json({ purchases: [] }) }));
    assert.equal(history.status, 200);
    for (const suffix of ['/resume', '/cancel']) assert.equal((await dispatchCore(post(suffix), paused, never)).status, 503);
  }
  for (const key of ['CORE_REPORTS_ENABLED', 'AUTH_SERVICES_ENABLED', 'AUTH_CUTOVER_VERIFIED', 'CORE_DATA_ACCESS_VERIFIED']) {
    for (const value of [undefined, 'false', 'TRUE', '1', true]) {
      assert.equal((await dispatchCore(request(), { ...env, [key]: value }, never)).status, 503);
    }
  }
});

test('reserved purchase namespace rejects aliases, owner overrides and unrecognized operations even with broad Core ready', async () => {
  const ready = { ...env, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' };
  for (const suffix of ['/', '?email=other@example.invalid', '?', '/resume/', '/cancel/', '/unknown', '/resume?order_id=' + order]) {
    const input = suffix.includes('resume') || suffix.includes('cancel') ? post(suffix) : request(suffix);
    assert.equal((await dispatchCore(input, ready, never)).status, 503, suffix);
  }
  for (const alias of ['/api/payments/nowpayments/%70urchases', '/api//payments/nowpayments/purchases', '/api/payments/nowpayments/%2570urchases']) {
    assert.equal((await dispatchCore(new Request(`https://payments.core.internal${alias}`, { headers }), ready, never)).status, 503);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal((await dispatchCore(request('', { method, ...(method === 'POST' ? { body: '{}' } : {}) }), ready, never)).status, 503);
  }
  for (const suffix of ['/resume', '/cancel']) assert.equal((await dispatchCore(request(suffix), ready, never)).status, 503);
  for (const host of ['core.internal', 'auth.core.internal', 'withdrawals.core.internal', 'engine.core.internal']) {
    assert.equal((await dispatchCore(request('', {}, host), ready, never)).status, 503);
  }
});

test('purchase transport requires bounded signed-owner envelope and canonical one-field JSON', async () => {
  for (const changed of [{}, { ...headers, 'x-vp-service-token': 'wrong' }, { ...headers, 'x-vp-id-token': 'invalid' },
    { ...headers, 'x-vp-id-token': 'a'.repeat(16385) + '.b.c' }, { ...headers, 'x-vp-act-as': 'other@example.invalid' },
    { ...headers, 'content-encoding': 'gzip' }]) {
    assert.equal((await dispatchCore(request('', { headers: changed }), env, never)).status, 503);
    assert.equal((await dispatchCore(post('/cancel', undefined, { headers: changed }), env, never)).status, 503);
  }
  for (const body of ['', '{}', 'null', '[]', '{', JSON.stringify({ order_id: order, email: 'other@example.invalid' }),
    `{"order_id":"${order}","order_id":"${order}"}`, `{"order_\\u0069d":"${order}"}`,
    JSON.stringify({ order_id: '00000000-0000-0000-0000-000000000000' }), JSON.stringify({ order_id: order.toUpperCase() }),
    JSON.stringify({ order_id: 'invalid' })]) {
    assert.equal((await dispatchCore(post('/cancel', body), env, never)).status, 503, body);
  }
  assert.equal((await dispatchCore(post('/cancel', 'x'.repeat(1025)), env, never)).status, 413);
  assert.equal((await dispatchCore(post('/cancel', undefined, { headers: { ...headers, 'content-type': 'text/plain' } }), env, never)).status, 503);
  const http = new Request(`http://payments.core.internal${path}`, { headers });
  assert.equal((await dispatchCore(http, env, never)).status, 503);
});

test('purchase failures never expose private error details or cause an automatic retry', async () => {
  for (const input of [request(), post('/cancel'), post('/resume')]) {
    let calls = 0;
    const response = await dispatchCore(input, env, () => ({ fetch: async () => {
      calls++; return Response.json({ error: 'postgres://private', stack: 'secret' }, { status: 500, headers: { 'x-private': 'secret' } });
    } }));
    assert.equal(calls, 1); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'upstream_unavailable' });
    assert.equal(response.headers.has('x-private'), false);
  }
});

test('checkout requires a stable nonzero purchase intention identifier', async () => {
  for (const purchase_request_id of [undefined, '', 'invalid', order.toUpperCase(), '00000000-0000-0000-0000-000000000000']) {
    const input = new Request('https://payments.core.internal/api/payments/checkout', { method: 'POST', headers,
      body: JSON.stringify({ provider: 'nowpayments', package_id: 1, purchase_request_id }) });
    assert.equal((await dispatchCore(input, env, never)).status, 503);
  }
});
