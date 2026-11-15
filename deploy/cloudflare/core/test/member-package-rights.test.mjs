import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCore } from '../src/routing.mjs';
import { containerEnvironment } from '../src/runtime-env.mjs';

const path = '/api/member/package-rights';
const ready = { CORE_ENV: 'production', CORE_SERVICES_ENABLED: 'false', AUTH_SERVICES_ENABLED: 'true', AUTH_CUTOVER_VERIFIED: 'true',
  CORE_DATA_ACCESS_VERIFIED: 'true', MEMBER_PACKAGE_RIGHTS_ENABLED: 'true', CORE_REPORTS_ENABLED: 'true' };
const headers = { origin: 'https://app.mindblisspower.com', cookie: 'better-auth.session_token=synthetic', 'x-mindbliss-profile-subject': 'synthetic-owner' };
const request = ({ host = 'auth.core.internal', suffix = '', method = 'GET', extra = {} } = {}) => new Request(`https://${host}${path}${suffix}`, { method, headers: { ...headers, ...extra } });

test('Core routes package rights to Native once with its owner fence and cookie, without enabling business writers', async () => {
  let calls = 0;
  const result = await dispatchCore(request(), ready, (service, instance) => {
    calls++; assert.equal(service, 'api'); assert.equal(instance, 'singleton');
    return { fetch: async forwarded => {
      assert.equal(forwarded.method, 'GET'); assert.equal(forwarded.headers.get('cookie'), headers.cookie);
      assert.equal(forwarded.headers.get('x-mindbliss-profile-subject'), headers['x-mindbliss-profile-subject']);
      return Response.json({ rightsOnly: true });
    } };
  });
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'private, no-store'); assert.equal(calls, 1);
});

test('Core package rights rejects all write verbs, aliases, query ownership, wrong portals and missing owner proof even in broad routing mode', async () => {
  const broad = { ...ready, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' };
  const stop = () => assert.fail('invalid rights request started a container');
  for (const options of [
    ...['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(method => ({ method })),
    ...['/', '/recognize', '/revoke', '?', '?personId=other', '?subject=other'].map(suffix => ({ suffix })),
    ...['payments.core.internal', 'engine.core.internal', 'withdrawals.core.internal'].map(host => ({ host })),
    ...[{ origin: '' }, { origin: 'https://wallet.mindblisspower.com' }, { origin: 'https://mindblisspower.com' }, { cookie: '' },
      { 'x-vp-act-as': '' }, { 'x-mindbliss-profile-subject': '' }, { 'x-mindbliss-profile-subject': '%ZZ' },
      { 'x-mindbliss-profile-subject': '%00owner' }, { 'x-mindbliss-profile-subject': 'owner,other' }].map(extra => ({ extra }))
  ]) assert.equal((await dispatchCore(request(options), broad, stop)).status, 503);
  for (const flag of ['MEMBER_PACKAGE_RIGHTS_ENABLED', 'AUTH_SERVICES_ENABLED', 'AUTH_CUTOVER_VERIFIED', 'CORE_DATA_ACCESS_VERIFIED'])
    assert.equal((await dispatchCore(request(), { ...broad, [flag]: 'false' }, stop)).status, 503);
});

test('Core package rights preserves ownership fences and sanitizes upstream database failures without retrying', async () => {
  for (const [status, error] of [[409, 'member_package_rights_owner_changed'], [503, 'member_package_rights_unconfigured'], [503, 'database password=synthetic']]) {
    let calls = 0;
    const result = await dispatchCore(request(), ready, () => ({ fetch: async () => { calls++; return Response.json({ error }, { status }); } }));
    assert.equal(result.status, status); assert.equal(calls, 1);
    assert.deepEqual(await result.json(), { error: error.startsWith('member_package_rights_') ? error : 'upstream_unavailable' });
  }
});

test('Core package rights feature only changes its Native read flag and never forwards it to Go or enables financial capabilities', () => {
  const base = { CORE_ENV: 'production', AUTH_CUTOVER_VERIFIED: 'false',
    API_DATABASE_URL: 'postgres://reader.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    API_AUTH_DATABASE_URL: 'postgres://auth.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    API_AUTH_SECRET: 'a'.repeat(48), API_BFF_SHARED_SECRET: 'b'.repeat(48), API_AUTH_URL: 'https://portal.example.invalid', API_AUTH_ORIGINS: 'https://portal.example.invalid',
    API_ENGINE_GRPC_URL: 'https://private-engine.example.invalid:50051', API_ENGINE_TLS_CA_PEM: 'synthetic-ca', API_ENGINE_TLS_CERT_PEM: 'synthetic-cert', API_ENGINE_TLS_KEY_PEM: 'synthetic-key' };
  const off = containerEnvironment('api', base), on = containerEnvironment('api', { ...base, MEMBER_PACKAGE_RIGHTS_ENABLED: 'true' });
  assert.equal(off.MEMBER_PACKAGE_RIGHTS_ENABLED, 'false'); assert.equal(on.MEMBER_PACKAGE_RIGHTS_ENABLED, 'true');
  for (const key of new Set([...Object.keys(off), ...Object.keys(on)])) if (key !== 'MEMBER_PACKAGE_RIGHTS_ENABLED') assert.equal(on[key], off[key], key);
});
