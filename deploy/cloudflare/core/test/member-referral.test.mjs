import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCore } from '../src/routing.mjs';
import { memberReferralRequest } from '../src/member-referral.mjs';
import { containerEnvironment } from '../src/runtime-env.mjs';

const origin = 'https://app.mindblisspower.com', path = '/api/member/referral', capture = '/api/member/referral-attribution';
const ready = { CORE_ENV: 'production', CORE_SERVICES_ENABLED: 'false', AUTH_SERVICES_ENABLED: 'true', AUTH_CUTOVER_VERIFIED: 'true',
  CORE_DATA_ACCESS_VERIFIED: 'true', MEMBER_REFERRAL_ENABLED: 'true', CORE_REPORTS_ENABLED: 'true' };
const headers = { origin, cookie: 'better-auth.session_token=synthetic', 'content-type': 'application/json',
  'x-mindbliss-referral-subject': 'synthetic-referral-owner', 'x-vp-auth-client-ip': '192.0.2.1',
  'x-vp-auth-timestamp': '1790000000', 'x-vp-auth-signature': 'a'.repeat(64) };
function request(body, { extra = {}, suffix = '', method = 'POST', host = 'auth.core.internal', target = capture } = {}) {
  return new Request(`https://${host}${target}${suffix}`, { method, headers: { ...headers, ...extra },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
}

test('Core referral capability forwards the exact owner fence/cookie/proof and explicit empty company hint to native API once', async () => {
  for (const ref of ['', 'MBsponsor']) {
    let calls = 0;
    const response = await dispatchCore(request({ ref }), ready, (service, instance) => {
      calls++; assert.equal(service, 'api'); assert.equal(instance, 'singleton');
      return { fetch: async forwarded => {
        assert.equal(forwarded.redirect, 'manual'); assert.deepEqual(await forwarded.json(), { ref });
        for (const key of ['origin', 'cookie', 'x-mindbliss-referral-subject', 'x-vp-auth-signature']) assert.equal(forwarded.headers.get(key), headers[key]);
        return Response.json({ ok: true });
      } };
    });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(calls, 1);
  }
  const read = await dispatchCore(request(undefined, { target: path, method: 'GET' }), ready, service => {
    assert.equal(service, 'api'); return { fetch: async () => Response.json({ context: true }) };
  }); assert.equal(read.status, 200);
});

test('Core referral gates and ref-only schema fail closed even when broad service routing is enabled', async () => {
  const broad = { ...ready, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' };
  const stop = () => assert.fail('invalid referral started a container');
  for (const body of [{}, [], null, { ref: null }, { ref: 42 }, { ref: 'A'.repeat(65) }, { ref: 'two codes' },
    ...['subject', 'nativeSessionId', 'personId', 'companyRoot', 'sponsorId', 'preferred_side', 'commission_eligible'].map(key => ({ ref: '', [key]: 'foreign' }))]) {
    assert.equal((await dispatchCore(request(body), broad, stop)).status, 503);
  }
  for (const extra of [{ origin: '' }, { origin: 'https://wallet.mindblisspower.com' }, { 'x-vp-act-as': '' }, { cookie: '' },
    { 'x-vp-auth-signature': '' }, { 'x-vp-auth-timestamp': '' }, { 'x-vp-auth-client-ip': '' }, { 'content-encoding': 'gzip' },
    { 'x-mindbliss-referral-subject': '' }, { 'x-mindbliss-referral-subject': '%ZZ' }, { 'x-mindbliss-referral-subject': '%00owner' },
    { 'x-mindbliss-referral-subject': 'owner,other' }, { 'x-mindbliss-referral-subject': 'a'.repeat(256) }]) {
    assert.equal((await dispatchCore(request({ ref: '' }, { extra }), broad, stop)).status, 503);
  }
  for (const [key, value] of [['MEMBER_REFERRAL_ENABLED', 'false'], ['AUTH_SERVICES_ENABLED', 'false'], ['CORE_DATA_ACCESS_VERIFIED', 'false'], ['AUTH_CUTOVER_VERIFIED', 'false']]) {
    assert.equal((await dispatchCore(request({ ref: '' }), { ...ready, [key]: value }, stop)).status, 503);
  }
});

test('Core referral rejects route aliases, wrong hosts/methods, oversized bytes and a missing authenticated owner contract', async () => {
  const stop = () => assert.fail('referral alias started a container');
  for (const suffix of ['/', '/capture', '?', '?subject=other', '/%65dit']) {
    assert.ok([400, 404, 503].includes((await dispatchCore(request({ ref: '' }, { suffix }), ready, stop)).status));
  }
  assert.equal((await dispatchCore(request({ ref: '' }, { host: 'payments.core.internal' }), ready, stop)).status, 503);
  assert.equal((await dispatchCore(request({ ref: '' }, { target: path }), ready, stop)).status, 503);
  assert.equal((await dispatchCore(request(undefined, { method: 'GET' }), ready, stop)).status, 503);
  assert.equal((await dispatchCore(request({ ref: 'A'.repeat(2048) }), ready, stop)).status, 413);
  const req = request({ ref: '' }), bytes = new TextEncoder().encode('{"ref":""}');
  assert.equal(memberReferralRequest(req, new URL(req.url), bytes, ready, false), false);
  const encoded = request({ ref: '' }, { extra: { 'x-mindbliss-referral-subject': encodeURIComponent('synthetic/owner.é') } });
  assert.equal(memberReferralRequest(encoded, new URL(encoded.url), bytes, ready, true), true);
  assert.equal(memberReferralRequest(req, new URL(req.url), Uint8Array.from([255, 254]), ready, true), false);
});

test('Core preserves native 409 ownership/outstanding-order responses and sanitizes upstream failures without retrying', async () => {
  for (const code of ['member_referral_owner_changed', 'member_referral_outstanding_order']) {
    let calls = 0;
    const response = await dispatchCore(request({ ref: '' }), ready, () => ({ fetch: async () => { calls++; return Response.json({ error: code }, { status: 409 }); } }));
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: code }); assert.equal(calls, 1);
  }
  for (const code of ['member_referral_unconfigured', 'member_referral_unavailable', 'private postgres password=synthetic']) {
    let calls = 0;
    const response = await dispatchCore(request({ ref: '' }), ready, () => ({ fetch: async () => { calls++; return Response.json({ error: code }, { status: 503 }); } }));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: code.startsWith('member_referral_') ? code : 'upstream_unavailable' }); assert.equal(calls, 1);
  }
  let calls = 0;
  const network = await dispatchCore(request({ ref: '' }), ready, () => ({ fetch: async () => { calls++; throw Error('synthetic network failure'); } }));
  assert.equal(network.status, 503); assert.equal(calls, 1);
});

function apiEnvironment() {
  return { CORE_ENV: 'production', AUTH_CUTOVER_VERIFIED: 'false',
    API_DATABASE_URL: 'postgres://reader.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    API_AUTH_DATABASE_URL: 'postgres://auth.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    API_AUTH_SECRET: 'a'.repeat(48), API_BFF_SHARED_SECRET: 'b'.repeat(48), API_AUTH_URL: 'https://portal.example.invalid', API_AUTH_ORIGINS: 'https://portal.example.invalid',
    API_ENGINE_GRPC_URL: 'https://private-engine.example.invalid:50051', API_ENGINE_TLS_CA_PEM: 'synthetic-ca', API_ENGINE_TLS_CERT_PEM: 'synthetic-cert', API_ENGINE_TLS_KEY_PEM: 'synthetic-key',
    REFERRAL_COMPANY_ROOT_AFFILIATE_ID: 'untrusted-direct-setting', STRIPE_SECRET_KEY: 'must-not-forward', BONUS_ENGINE_SCHEDULER_ENABLED: 'true' };
}

test('Core root mapping uses reviewed payments root only and never enables financial writers or sponsor broadcasting', () => {
  const base = apiEnvironment(), inactive = containerEnvironment('api', base);
  assert.equal(inactive.MEMBER_REFERRAL_ENABLED, 'false'); assert.equal(inactive.REFERRAL_COMPANY_ROOT_AFFILIATE_ID, undefined);
  const active = containerEnvironment('api', { ...base, MEMBER_REFERRAL_ENABLED: 'true', PAYMENTS_ROOT_AFFILIATE_ID: '117903' });
  assert.equal(active.REFERRAL_COMPANY_ROOT_AFFILIATE_ID, '117903'); assert.equal(active.MEMBER_REFERRAL_ENABLED, 'true');
  for (const key of new Set([...Object.keys(inactive), ...Object.keys(active)])) {
    if (!['MEMBER_REFERRAL_ENABLED', 'REFERRAL_COMPANY_ROOT_AFFILIATE_ID'].includes(key)) assert.equal(active[key], inactive[key], key);
  }
  assert.equal(active.STRIPE_SECRET_KEY, undefined); assert.equal(active.ADMINISTRATIVE_WALLET_BROADCAST_ENABLED, 'false');
  assert.equal(active.PERSONAL_POLYGON_RELAY_ENABLED, 'false'); assert.equal(active.PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED, 'false');
  for (const root of [undefined, '', '0', '-1', '1.5', '01', '9007199254740992']) {
    const invalid = containerEnvironment('api', { ...base, MEMBER_REFERRAL_ENABLED: 'true', PAYMENTS_ROOT_AFFILIATE_ID: root });
    assert.equal(invalid.REFERRAL_COMPANY_ROOT_AFFILIATE_ID, undefined);
    assert.equal(invalid.MEMBER_REFERRAL_ENABLED, 'true');
    assert.equal(invalid.BETTER_AUTH_SECRET, inactive.BETTER_AUTH_SECRET);
  }
});
