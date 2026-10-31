import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCore } from '../src/routing.mjs';
import { containerEnvironment } from '../src/runtime-env.mjs';

const ready = { CORE_ENV: 'production', CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true',
  CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_CUTOVER_VERIFIED: 'true' };
const request = (path, init = {}, host = 'payments.core.internal') => new Request(`https://${host}${path}`, init);
const neverStart = () => assert.fail('disabled Stripe must not start a Container');

test('Stripe initiation and resume stay closed independently of other service readiness', async () => {
  for (const value of [undefined, 'false', 'TRUE', '1', true]) for (const globalReady of [true, false]) {
    const env = { ...ready, CORE_SERVICES_ENABLED: String(globalReady), STRIPE_CHECKOUT_ENABLED: value };
    for (const provider of [undefined, 'stripe', ' STRIPE ', 'unknown']) {
      const response = await dispatchCore(request('/api/payments/checkout', { method: 'POST', body: JSON.stringify({ provider }) }), env, neverStart);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'stripe_checkout_disabled');
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
    for (const path of ['/api/payments/resume?t=synthetic', '/api/payments/resume/', '/api/payments/%72esume']) {
      const response = await dispatchCore(request(path), env, neverStart);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'stripe_checkout_disabled');
    }
  }
});

test('NOWPayments and financial write restrictions are not enabled by the Stripe switch', async () => {
  for (const flag of ['false', 'true']) {
    const response = await dispatchCore(request('/api/payments/checkout', { method: 'POST', body: '{"provider":"nowpayments"}' }),
      { ...ready, STRIPE_CHECKOUT_ENABLED: flag }, neverStart);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'financial_review_required');
  }
  const webhook = await dispatchCore(request('/api/webhooks/stripe', { method: 'POST', body: '{}' }), ready, neverStart);
  assert.equal((await webhook.json()).error, 'financial_review_required');
  let calls = 0;
  const report = await dispatchCore(request('/api/admin/sales'), ready, () => ({ fetch: async () => { calls++; return Response.json({ synthetic: true }); } }));
  assert.equal(report.status, 200); assert.equal(calls, 1);
});

test('malformed and oversized checkout bodies cannot reach a payment service', async () => {
  assert.equal((await dispatchCore(request('/api/payments/checkout', { method: 'POST', body: '' }), ready, neverStart)).status, 503);
  for (const body of ['[]', 'null', '{']) {
    assert.equal((await dispatchCore(request('/api/payments/checkout', { method: 'POST', body }), ready, neverStart)).status, 400);
  }
  assert.equal((await dispatchCore(request('/api/payments/checkout', { method: 'POST', body: 'x'.repeat(256 * 1024 + 1) }), ready, neverStart)).status, 413);
});

test('payments receives only an exact, default-closed Stripe flag without provider credentials', () => {
  const secrets = { ...ready, PAYMENTS_DATABASE_URL: 'postgres://reader.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    PAYMENTS_SERVICE_TOKEN: 'synthetic', PAYMENTS_ROOT_AFFILIATE_ID: '50793', CORE_SUPER_ADMIN_EMAILS: 'owner@example.invalid',
    AUTH_JWT_ISSUER: 'https://portal.example.invalid', AUTH_JWT_AUDIENCE: 'synthetic' };
  for (const flag of [undefined, 'false', 'TRUE', '1', true, 'true']) {
    const env = containerEnvironment('payments', { ...secrets, STRIPE_CHECKOUT_ENABLED: flag, STRIPE_SECRET_KEY: 'must-not-forward' });
    assert.equal(env.STRIPE_CHECKOUT_ENABLED, flag === 'true' ? 'true' : 'false');
    assert.equal(env.STRIPE_SECRET_KEY, undefined); assert.equal(env.SERVICE_READ_ONLY, 'true');
  }
});
