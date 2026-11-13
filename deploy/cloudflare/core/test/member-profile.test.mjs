import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCore } from '../src/routing.mjs';
import { memberProfileRequest } from '../src/member-profile.mjs';
const origin = 'https://app.mindblisspower.com', path = '/api/member/profile';
const ready = { CORE_ENV: 'production', CORE_SERVICES_ENABLED: 'false', AUTH_SERVICES_ENABLED: 'true', AUTH_CUTOVER_VERIFIED: 'true',
  CORE_DATA_ACCESS_VERIFIED: 'true', MEMBER_PROFILE_ENABLED: 'true', CORE_REPORTS_ENABLED: 'true' };
const headers = { origin, cookie: 'better-auth.session_token=synthetic', 'content-type': 'application/json',
  'x-mindbliss-profile-subject': 'synthetic-profile-owner',
  'x-vp-auth-client-ip': '192.0.2.1', 'x-vp-auth-timestamp': '1790000000', 'x-vp-auth-signature': 'a'.repeat(64) };
const input = { name: 'Synthetic Owner', phone: '+12025550123' };
const request = (body, extra = {}, suffix = '', method = 'POST', host = 'auth.core.internal') => new Request(`https://${host}${path}${suffix}`,
  { method, headers: { ...headers, ...extra }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });

test('profile exact native capability forwards only owner cookie/HMAC app-origin reads and reviewed name/phone/country writes', async () => {
  for (const country of [undefined, 'CO', '']) {
    const body = { ...input, ...(country === undefined ? {} : { country }) }; let calls = 0;
    const response = await dispatchCore(request(body), ready, (service, instance) => {
      calls++; assert.equal(service, 'api'); assert.equal(instance, 'singleton'); return { fetch: async forwarded => {
        assert.equal(forwarded.headers.get('origin'), origin); assert.equal(forwarded.headers.get('cookie'), headers.cookie);
        assert.equal(forwarded.headers.get('x-mindbliss-profile-subject'), headers['x-mindbliss-profile-subject']);
        assert.equal(forwarded.headers.get('x-vp-auth-signature'), headers['x-vp-auth-signature']); assert.deepEqual(await forwarded.json(), body);
        return Response.json({ ok: true });
      } };
    }); assert.equal(response.status, 200); assert.equal(calls, 1); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  const get = await dispatchCore(request(undefined, {}, '', 'GET'), ready, service => {
    assert.equal(service, 'api'); return { fetch: async () => Response.json({ profile: true }) };
  }); assert.equal(get.status, 200);
});

test('profile namespace is fail-closed under broad Core for aliases, origins, impersonation, hostile fields and missing proof', async () => {
  const broad = { ...ready, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' };
  for (const body of [{}, { name: input.name }, { phone: input.phone }, { ...input, country: null }, { ...input, country: 'Colombia' },
    { ...input, name: '<script>' }, { ...input, name: '---' }, ...['email', 'subject', 'nativeSessionId', 'payout_wallet_usdc', 'role', 'phoneNumberVerified'].map(key => ({ ...input, [key]: 'foreign' }))]) {
    const response = await dispatchCore(request(body), broad, () => assert.fail('invalid profile started container')); assert.equal(response.status, 503);
  }
  for (const extra of [{ origin: 'https://wallet.mindblisspower.com' }, { origin: '' }, { 'x-vp-act-as': '' }, { cookie: '' },
    { 'x-vp-auth-signature': '' }, { 'x-vp-auth-client-ip': '' }, { 'content-encoding': 'gzip' },
    { 'x-mindbliss-profile-subject': '' }, { 'x-mindbliss-profile-subject': '%ZZ' }, { 'x-mindbliss-profile-subject': '%00owner' },
    { 'x-mindbliss-profile-subject': 'a'.repeat(256) }, { 'x-mindbliss-profile-subject': 'owner,foreign' }]) {
    assert.equal((await dispatchCore(request(input, extra), broad, () => assert.fail('invalid header bypass'))).status, 503);
  }
  for (const suffix of ['?email=other', '/', '/edit', '?', '/%65dit']) {
    const response = await dispatchCore(request(input, {}, suffix), broad, () => assert.fail('profile alias bypass'));
    assert.ok([400, 404, 503].includes(response.status));
  }
  assert.equal((await dispatchCore(request(input), { ...ready, MEMBER_PROFILE_ENABLED: 'false' }, () => assert.fail('disabled profile'))).status, 503);
  assert.equal((await dispatchCore(request(input, {}, '', 'POST', 'payments.core.internal'), broad, () => assert.fail('legacy Go POST opened'))).status, 503);
});

test('profile body limit and safe upstream errors remain bounded without broadening Go writes', async () => {
  assert.equal((await dispatchCore(request({ ...input, name: 'A'.repeat(3000) }), ready, () => assert.fail('oversized profile'))).status, 413);
  for (const code of ['member_profile_unconfigured', 'member_profile_outcome_unconfirmed', 'private postgres password value']) {
    const response = await dispatchCore(request(input), ready, () => ({ fetch: async () => Response.json({ error: code }, { status: 503 }) }));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: code.startsWith('member_profile_') ? code : 'upstream_unavailable' });
  }
  const req = request(input), body = new TextEncoder().encode(JSON.stringify(input));
  assert.equal(memberProfileRequest(req, new URL(req.url), body, ready, false), false);
  const encoded = request(input, { 'x-mindbliss-profile-subject': encodeURIComponent('synthetic/owner.é') });
  assert.equal(memberProfileRequest(encoded, new URL(encoded.url), body, ready, true), true);
});
