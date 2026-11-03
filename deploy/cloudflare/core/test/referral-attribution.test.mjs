import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCore } from '../src/routing.mjs';

const path = '/api/payments/referral-attribution';
const env = { CORE_ENV: 'production', CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false',
  CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_SERVICES_ENABLED: 'true', AUTH_CUTOVER_VERIFIED: 'true', CORE_REPORTS_ENABLED: 'true',
  NOWPAYMENTS_OPERATIONAL_ENABLED: 'false', STRIPE_CHECKOUT_ENABLED: 'false', PAYMENTS_SERVICE_TOKEN: 'synthetic-service-token' };
const headers = { 'content-type': 'application/json', 'x-vp-service-token': env.PAYMENTS_SERVICE_TOKEN, 'x-vp-id-token': 'synthetic.verified.jwt' };
const body = JSON.stringify({ email: 'member@example.test', ref: 'MP123', preferred_side: 'R' });
const get = (suffix = '?email=member%40example.test', extra = {}) => new Request(`https://payments.core.internal${path}${suffix}`, { headers, ...extra });
const post = (source = body, extra = {}) => get('', { method: 'POST', body: source, ...extra });
const never = () => assert.fail('invalid referral capability must not start any Container');

test('verified referral metadata works with financial services paused, forwards exactly once, no-store', async () => {
  for (const request of [get(), post()]) {
    let calls = 0;
    const response = await dispatchCore(request, env, (service, instance) => {
      calls++; assert.equal(service, 'payments'); assert.equal(instance, 'singleton');
      return { fetch: async forwarded => {
        assert.equal(forwarded.url, request.url); assert.equal(forwarded.redirect, 'manual');
        assert.equal(forwarded.headers.get('x-vp-id-token'), headers['x-vp-id-token']);
        if (forwarded.method === 'POST') assert.equal(await forwarded.text(), body);
        return Response.json({ ok: true, ref: 'MP123', preferred_side: 'R', positioned: false });
      } };
    });
    assert.equal(calls, 1); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('referral capability requires all auth/report gates independently of broad Core readiness', async () => {
  for (const key of ['CORE_REPORTS_ENABLED', 'AUTH_SERVICES_ENABLED', 'AUTH_CUTOVER_VERIFIED', 'CORE_DATA_ACCESS_VERIFIED']) {
    for (const value of [undefined, 'false', 'TRUE', true, '1']) {
      for (const request of [get(), post()]) assert.equal((await dispatchCore(request,
        { ...env, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true', [key]: value }, never)).status, 503);
    }
  }
});

test('referral namespace rejects aliases, owner selectors, verbs and malformed payloads', async () => {
  const ready = { ...env, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' };
  for (const suffix of ['', '/', '?', '?%65mail=member%40example.test', '?email=member%40example.test&email=other%40example.test',
    '?email=member%40example.test&subject=other', '?email=MEMBER%40example.test', '?email=', '/other']) {
    assert.equal((await dispatchCore(get(suffix), ready, never)).status, 503, suffix);
  }
  for (const method of ['HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) assert.equal((await dispatchCore(get('', { method }), ready, never)).status, 503);
  for (const alias of ['/api//payments/referral-attribution', '/api/payments/%72eferral-attribution', '/api/payments/%2572eferral-attribution']) {
    assert.equal((await dispatchCore(new Request(`https://payments.core.internal${alias}?email=member%40example.test`, { headers }), ready, never)).status, 503);
  }
  for (const source of ['', '{}', 'null', '[]', body + '{}', body.replace('"ref":', '"ref":"MP9","ref":'),
    body.replace('"ref"', '"r\\u0065f"'), body.replace('"R"', '"left"'), body.replace('"MP123"', '""'),
    body.replace('"MP123"', '"MP 123"'), body.replace('"MP123"', '"' + 'a'.repeat(65) + '"'),
    JSON.stringify({ email: 'member@example.test', ref: 'MP123', preferred_side: 'R', subject: 'another' })]) {
    assert.equal((await dispatchCore(post(source), ready, never)).status, 503, source);
  }
});

test('referral transport rejects missing proof, ActAs, wrong host, large body and upstream diagnostics', async () => {
  for (const changed of [{}, { ...headers, 'x-vp-service-token': 'wrong' }, { ...headers, 'x-vp-id-token': 'invalid' },
    { ...headers, 'x-vp-act-as': '' }, { ...headers, 'content-encoding': 'gzip' }]) {
    for (const request of [get(undefined, { headers: changed }), post(body, { headers: changed })]) {
      assert.equal((await dispatchCore(request, env, never)).status, 503);
    }
  }
  for (const host of ['core.internal', 'auth.core.internal', 'engine.core.internal', 'withdrawals.core.internal']) {
    assert.equal((await dispatchCore(new Request(`https://${host}${path}?email=member%40example.test`, { headers }), env, never)).status, 503);
  }
  assert.equal((await dispatchCore(post('x'.repeat(1025)), env, never)).status, 413);
  let calls = 0;
  const response = await dispatchCore(post(), env, () => ({ fetch: async () => { calls++; return new Response('private-db-diagnostic', { status: 500 }); } }));
  assert.equal(response.status, 503); assert.equal(calls, 1); assert.doesNotMatch(await response.text(), /private-db-diagnostic/);
});
