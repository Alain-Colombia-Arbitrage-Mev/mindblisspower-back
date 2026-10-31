import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { containerEnvironment } from '../src/runtime-env.mjs';
import { dispatchCore, dispatchContainerOutbound, coreReady, nowpaymentsOperationalReady } from '../src/routing.mjs';
import { NOWPAYMENTS_CALLBACK, validOperationalInvoice } from '../src/nowpayments-operation.mjs';

const order = 'deadbeef-1234-5678-9abc-0123456789ab';
const env = { CORE_ENV: 'production', CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false',
  CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_SERVICES_ENABLED: 'true', AUTH_CUTOVER_VERIFIED: 'true',
  NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED: 'true', NOWPAYMENTS_OPERATIONAL_ENABLED: 'true', NOWPAYMENTS_MEMBERSHIPS_ENABLED: 'true', NOWPAYMENTS_ENGINE_ENABLED: 'true',
  STRIPE_CHECKOUT_ENABLED: 'false', PAYMENTS_SERVICE_TOKEN: 'synthetic-service-token', NOWPAYMENTS_API_KEY: 'synthetic-provider-key' };
const headers = { 'content-type': 'application/json', 'x-vp-service-token': env.PAYMENTS_SERVICE_TOKEN,
  'x-vp-id-token': 'synthetic.verified.jwt' };
const checkout = (body = { provider: 'nowpayments', package_id: 4, email: 'buyer@example.invalid' }, path = '/api/payments/checkout', extra = {}) =>
  new Request(`https://payments.core.internal${path}`, { method: 'POST', body: JSON.stringify(body), headers, ...extra });
const never = () => assert.fail('unrelated capability must remain closed');
const invoice = () => ({ price_amount: 100.00, price_currency: 'usd', order_id: order, order_description: 'Mindbliss Power membership',
  ipn_callback_url: NOWPAYMENTS_CALLBACK,
  success_url: `https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=review&order_id=${order}`,
  cancel_url: 'https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=cancelled', is_fee_paid_by_user: false });
const outbound = (body = JSON.stringify(invoice()), url = 'https://api.nowpayments.io/v1/invoice', extra = {}) => new Request(url,
  { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.NOWPAYMENTS_API_KEY }, body, ...extra });

test('NOW operation releases only authenticated exact NOW checkout independently of broad Core networking', async () => {
  assert.equal(coreReady(env), false); assert.equal(nowpaymentsOperationalReady(env), true);
  let calls = 0;
  const input = checkout();
  const response = await dispatchCore(input, env, (service, instance) => {
    calls++; assert.equal(service, 'payments'); assert.equal(instance, 'singleton');
    return { fetch: async request => {
      assert.equal(request.redirect, 'manual'); assert.equal(request.headers.get('x-vp-id-token'), headers['x-vp-id-token']);
      assert.equal((await request.json()).provider, 'nowpayments');
      return Response.json({ provider: 'nowpayments', fulfillment_status: 'pending' });
    } };
  });
  assert.equal(response.status, 200); assert.equal(calls, 1); assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('NOW operation requires every literal flag and exact canonical auth, method and checkout request', async () => {
  for (const key of ['NOWPAYMENTS_OPERATIONAL_ENABLED', 'NOWPAYMENTS_ENGINE_ENABLED', 'NOWPAYMENTS_MEMBERSHIPS_ENABLED', 'NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED',
    'CORE_DATA_ACCESS_VERIFIED', 'AUTH_SERVICES_ENABLED', 'AUTH_CUTOVER_VERIFIED']) {
    for (const value of [undefined, false, true, 'false', 'TRUE', '1']) {
      const disabled = { ...env, [key]: value }; assert.equal(nowpaymentsOperationalReady(disabled), false);
      assert.equal((await dispatchCore(checkout(), disabled, never)).status, 503);
    }
  }
  for (const path of ['/api/payments/checkout/', '/api/payments/%63heckout', '/api//payments/checkout', '/api/payments/checkout?provider=nowpayments']) {
    assert.equal((await dispatchCore(checkout(undefined, path), env, never)).status, 503);
  }
  for (const changed of [{}, { ...headers, 'x-vp-service-token': 'wrong' }, { ...headers, 'x-vp-id-token': '' },
    { ...headers, 'x-vp-id-token': 'invalid' }, { ...headers, 'content-type': 'text/plain' }, { ...headers, 'content-encoding': 'gzip' }]) {
    assert.equal((await dispatchCore(checkout(undefined, undefined, { headers: changed }), env, never)).status, 503);
  }
  for (const provider of ['stripe', '', 'NOWPAYMENTS', ' nowpayments ', undefined]) {
    assert.equal((await dispatchCore(checkout({ provider }), env, never)).status, 503);
  }
  assert.equal((await dispatchCore(checkout({ provider: 'nowpayments', name: 'x'.repeat(17000) }), env, never)).status, 413);
  assert.equal((await dispatchCore(checkout(), { ...env, CORE_ENV: 'staging' }, never)).status, 503);
});

test('NOW operation does not open Stripe, withdrawals, admin writes, identity claims, phone auth or Engine', async () => {
  for (const path of ['/api/payments/resume', '/api/payments/activate', '/api/webhooks/stripe', '/api/admin/withdrawals/action',
    '/api/admin/nowpayments/action', '/api/member/identity/claim']) assert.equal((await dispatchCore(checkout(undefined, path), env, never)).status, 503);
  assert.equal((await dispatchCore(checkout(undefined, '/api/auth/phone-number/send-otp'), env, never)).status, 404);
  for (const host of ['core.internal', 'auth.core.internal', 'engine.core.internal', 'withdrawals.core.internal']) {
    const input = new Request(`https://${host}/api/payments/checkout`, { method: 'POST', headers, body: '{"provider":"nowpayments"}' });
    assert.equal((await dispatchCore(input, env, never)).status, 503);
  }
  assert.equal((await dispatchContainerOutbound('payments', new Request('http://engine.core.internal/health'), env, never)).status, 503);
});

test('operational invoice egress preserves validated bytes and never retries or follows redirects', async () => {
  let calls = 0;
  const raw = JSON.stringify(invoice()).replaceAll('&', '\\u0026');
  assert.equal(validOperationalInvoice(new TextEncoder().encode(raw)), true);
  const response = await dispatchContainerOutbound('payments', outbound(raw), env, never, async request => {
    calls++; assert.equal(request.url, 'https://api.nowpayments.io/v1/invoice'); assert.equal(request.redirect, 'manual');
    assert.equal(await request.text(), raw); assert.equal(request.headers.get('x-api-key'), env.NOWPAYMENTS_API_KEY);
    return Response.json({ id: '123', invoice_url: 'https://nowpayments.io/payment/?iid=123' });
  });
  assert.equal(response.status, 200); assert.equal(calls, 1);
  const failed = await dispatchContainerOutbound('payments', outbound(), env, never, async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }); });
  assert.equal(failed.status, 503); assert.equal(calls, 2);
});

test('invoice egress fails closed on changed money, user fees, callbacks, identifiers, credentials and routes', async () => {
  for (const changes of [{ price_amount: 0 }, { price_amount: -1 }, { price_amount: '100.00' }, { price_amount: 1.001 },
    { price_currency: 'eur' }, { order_id: 'not-an-order' }, { order_description: 'untrusted' }, { is_fee_paid_by_user: true },
    { ipn_callback_url: 'https://evil.invalid/api/webhooks/nowpayments' }, { success_url: 'https://evil.invalid' },
    { success_url: invoice().success_url.replace('mindblisspower.com', 'mindblisspower.com:443') },
    { success_url: invoice().success_url + '&order_id=' + order }, { cancel_url: 'https://evil.invalid' }, { payout_address: 'invalid' }]) {
    assert.equal((await dispatchContainerOutbound('payments', outbound(JSON.stringify({ ...invoice(), ...changes })), env, never, never)).status, 400);
  }
  for (const raw of ['{}', JSON.stringify(invoice()).replace('"usd"', '"usd","price_currency":"usd"'),
    JSON.stringify(invoice()).replace('"price_currency"', '"price_\\u0063urrency"')]) {
    assert.equal((await dispatchContainerOutbound('payments', outbound(raw), env, never, never)).status, 400);
  }
  assert.equal((await dispatchContainerOutbound('payments', outbound('x'.repeat(16385)), env, never, never)).status, 413);
  assert.equal((await dispatchContainerOutbound('payments', outbound(undefined, undefined, { headers: { 'content-type': 'application/json', 'x-api-key': 'wrong' } }), env, never, never)).status, 400);
  for (const url of ['http://api.nowpayments.io/v1/invoice', 'https://api.nowpayments.io/v1/invoice/', 'https://api.nowpayments.io/v1/invoice?x=1',
    'https://api.nowpayments.io/v1/payout', 'https://api.nowpayments.io/v1/%69nvoice']) {
    assert.equal((await dispatchContainerOutbound('payments', outbound(undefined, url), env, never, never)).status, 404);
  }
  for (const source of ['api', 'engine', 'withdrawals']) assert.equal((await dispatchContainerOutbound(source, outbound(), env, never, never)).status, 503);
  assert.equal((await dispatchContainerOutbound('payments', outbound(), { ...env, NOWPAYMENTS_OPERATIONAL_ENABLED: 'false' }, never, never)).status, 404);
});

const secrets = { ...env, PAYMENTS_DATABASE_URL: 'postgres://reader.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
  NOWPAYMENTS_WEBHOOK_DATABASE_URL: 'postgres://capture.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
  NOWPAYMENTS_OPERATIONAL_DATABASE_URL: 'postgres://operational.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
  CORE_SUPER_ADMIN_EMAILS: 'admin@example.invalid', PAYMENTS_ROOT_AFFILIATE_ID: '1', AUTH_JWT_ISSUER: 'https://issuer.example.invalid',
  AUTH_JWT_AUDIENCE: 'audience', NOWPAYMENTS_IPN_SECRET: 'synthetic-ipn' };

test('operational runtime uses a third isolated writer without upgrading the business reader or jobs', () => {
  const values = containerEnvironment('payments', { ...secrets, SERVICE_READ_ONLY: 'false', STRIPE_SECRET_KEY: 'must-not-forward' });
  assert.equal(values.NOWPAYMENTS_OPERATIONAL_ENABLED, 'true'); assert.equal(values.NOWPAYMENTS_MEMBERSHIPS_ENABLED, 'true');
  assert.equal(values.NOWPAYMENTS_ENGINE_ENABLED, 'true');
  assert.equal(values.NOWPAYMENTS_OPERATIONAL_DATABASE_URL, secrets.NOWPAYMENTS_OPERATIONAL_DATABASE_URL);
  assert.equal(values.DATABASE_URL, secrets.PAYMENTS_DATABASE_URL); assert.equal(values.SERVICE_READ_ONLY, 'true');
  assert.equal(values.NOWPAYMENTS_IPN_URL, NOWPAYMENTS_CALLBACK); assert.equal(values.STRIPE_SECRET_KEY, undefined);
  assert.equal(values.PAYMENTS_RECONCILE_INTERVAL_MIN, '0'); assert.equal(values.COMMS_ENABLED, 'false');
  for (const change of [undefined, '', secrets.PAYMENTS_DATABASE_URL, secrets.NOWPAYMENTS_WEBHOOK_DATABASE_URL,
    'postgres://postgres:synthetic@db.example.invalid/app?sslmode=verify-full',
    'postgres://operational.branch:synthetic@other.invalid/app?sslmode=verify-full',
    'postgres://operational.branch:synthetic@db.example.invalid/other?sslmode=verify-full',
    'postgres://operational.branch:synthetic@db.example.invalid/app?sslmode=disable']) {
    assert.throws(() => containerEnvironment('payments', { ...secrets, NOWPAYMENTS_OPERATIONAL_DATABASE_URL: change }), error => !error.message.includes('synthetic'));
  }
  const disabled = { ...secrets, NOWPAYMENTS_OPERATIONAL_ENABLED: 'false' };
  Object.defineProperty(disabled, 'NOWPAYMENTS_OPERATIONAL_DATABASE_URL', { get() { assert.fail('disabled operation read writer secret'); } });
  assert.equal(containerEnvironment('payments', disabled).NOWPAYMENTS_OPERATIONAL_ENABLED, 'false');
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  for (const name of ['production', 'staging']) assert.equal(config.env[name].vars.NOWPAYMENTS_OPERATIONAL_ENABLED, String(name === 'production'));
});
