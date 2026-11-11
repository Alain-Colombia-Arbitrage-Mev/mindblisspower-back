import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchCore } from '../src/routing.mjs';
import { containerEnvironment } from '../src/runtime-env.mjs';
const env = { CORE_ENV: 'production', AUTH_SERVICES_ENABLED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_CUTOVER_VERIFIED: 'true',
  CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false', PERSONAL_COMPANY_PAYMENTS_ENABLED: 'true' };
const prefix = '/api/member/company-payments', id = '11111111-1111-4111-8111-111111111111', hash = `0x${'3'.repeat(64)}`;
function request(action = 'prepare', input = { requestId: id, amountAtomic: '20000000' }, extra = {}) {
  return new Request(`https://auth.core.internal${prefix}/${action}`, { method: 'POST', headers: { origin: 'https://app.mindblisspower.com',
    cookie: 'better-auth.session_token=synthetic', 'content-type': 'application/json', 'x-vp-auth-signature': 'a'.repeat(64),
    'x-vp-auth-timestamp': '1794350000', 'x-vp-auth-client-ip': '192.0.2.1', ...extra }, body: JSON.stringify(input) });
}
test('Core admits only isolated native company payment registration capabilities and owned recovery reads', async () => {
  let calls = 0; const resolve = (service, instance) => { assert.equal(service, 'api'); assert.equal(instance, 'singleton');
    return { fetch: async () => { calls++; return Response.json({}); } }; };
  for (const [action, input] of [['prepare', { requestId: id, amountAtomic: '20000000' }], ['submit', { paymentId: id, transactionHash: hash }], ['verify', { paymentId: id }], ['abandon', { paymentId: id }]]) {
    assert.equal((await dispatchCore(request(action, input), env, resolve)).status, 200);
  }
  for (const path of ['history', `status?paymentId=${id}`, 'balance', 'balances']) {
    const post = request(); const read = new Request(`https://auth.core.internal${prefix}/${path}`, { headers: post.headers });
    assert.equal((await dispatchCore(read, env, resolve)).status, 200);
  }
  assert.equal(calls, 8);
});
test('Core denies crossed portals, forged payment policies, unsigned requests and aliases even with broad Core enabled', async () => {
  const never = () => assert.fail('unauthorized company payment reached a container');
  for (const extra of [{ origin: 'https://wallet.mindblisspower.com' }, { origin: 'https://mindblisspower.com' }, { cookie: '' },
    { 'x-vp-act-as': 'other' }, { 'x-vp-auth-signature': '' }, { 'content-encoding': 'gzip' }]) {
    assert.equal((await dispatchCore(request('prepare', undefined, extra), env, never)).status, 503);
  }
  for (const input of [{ requestId: id, amountAtomic: '01' }, { requestId: id, amountAtomic: (1n << 256n).toString() },
    { requestId: id, amountAtomic: '1', recipientAddress: `0x${'2'.repeat(40)}` }, { requestId: id, amountAtomic: '1', subject: 'other' }]) {
    assert.equal((await dispatchCore(request('prepare', input), env, never)).status, 503);
  }
  assert.equal((await dispatchCore(request('abandon', { paymentId: id, transactionHash: hash }), env, never)).status, 503);
  const broad = { ...env, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' };
  for (const action of ['prepare?subject=other', '%70repare', '/prepare', 'prepare/extra', '../company-payments/unknown']) {
    assert.equal((await dispatchCore(request(action), broad, never)).status, 503);
  }
  assert.equal((await dispatchCore(request(), { ...env, PERSONAL_COMPANY_PAYMENTS_ENABLED: 'false' }, never)).status, 503);
  const crossedRead = new Request(`https://auth.core.internal${prefix}/history`, { headers: request('prepare', undefined,
    { origin: 'https://wallet.mindblisspower.com' }).headers });
  assert.equal((await dispatchCore(crossedRead, env, never)).status, 503);
});
test('Core projects only safe company payment errors and never returns provider payloads or cookie headers', async () => {
  const response = await dispatchCore(request(), env, () => ({ fetch: async () => Response.json({ error: 'company_payment_rpc_unavailable', private: 'provider detail' },
    { status: 503, headers: { 'set-cookie': 'private' } }) }));
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'company_payment_rpc_unavailable' });
  assert.equal(response.headers.get('set-cookie'), null);
});
test('public Reown RPC project configuration is forwarded exclusively to the enabled API service', () => {
  const base = { ...env, AUTH_CUTOVER_VERIFIED: 'false', API_DATABASE_URL: 'postgres://reader:synthetic@db.example.invalid/app?sslmode=verify-full',
    API_AUTH_DATABASE_URL: 'postgres://auth:synthetic@db.example.invalid/app?sslmode=verify-full', API_AUTH_SECRET: 'a'.repeat(48),
    API_BFF_SHARED_SECRET: 'b'.repeat(48), API_AUTH_URL: 'https://app.mindblisspower.com', API_AUTH_ORIGINS: 'https://app.mindblisspower.com',
    API_ENGINE_GRPC_URL: 'https://engine.example.invalid', API_ENGINE_TLS_CA_PEM: 'synthetic', API_ENGINE_TLS_CERT_PEM: 'synthetic',
    API_ENGINE_TLS_KEY_PEM: 'synthetic', API_REOWN_PROJECT_ID: 'a'.repeat(32) };
  assert.equal(containerEnvironment('api', base).REOWN_PROJECT_ID, base.API_REOWN_PROJECT_ID);
  assert.equal(containerEnvironment('api', { ...base, PERSONAL_COMPANY_PAYMENTS_ENABLED: 'false' }).REOWN_PROJECT_ID, undefined);
  assert.throws(() => containerEnvironment('api', { ...base, API_REOWN_PROJECT_ID: 'http://127.0.0.1' }));
});


test('Core balance capability is read-only, owner-scoped and cannot select a wallet, token, network or provider', async () => {
  const headers = request().headers;
  const never = () => assert.fail('unapproved balance selector reached a container');
  for (const query of ['?chainId=137', '?walletAddress=0x' + '2'.repeat(40), '?subject=other', '?tokenAddress=0x' + '3'.repeat(40), '?rpcUrl=https://evil.invalid']) {
    const read = new Request(`https://auth.core.internal${prefix}/balance${query}`, { headers });
    assert.equal((await dispatchCore(read, env, never)).status, 503);
  }
  for (const action of ['balance', 'balance/extra', '%62alance']) {
    assert.equal((await dispatchCore(request(action, {}), env, never)).status, 503);
  }
  const crossed = new Request(`https://auth.core.internal${prefix}/balance`, { headers: request('prepare', undefined, { origin: 'https://wallet.mindblisspower.com' }).headers });
  assert.equal((await dispatchCore(crossed, env, never)).status, 503);
});


test('Core dual display capability permits only exact GET balances without granting arbitrary transfer selectors', async () => {
  const headers = request().headers, never = () => assert.fail('unapproved dual balance request reached a container');
  for (const query of ['?chainId=137', '?network=polygon', '?walletAddress=0x' + '2'.repeat(40), '?subject=other', '?tokenAddress=0x' + '3'.repeat(40)]) {
    assert.equal((await dispatchCore(new Request(`https://auth.core.internal${prefix}/balances${query}`, { headers }), env, never)).status, 503);
  }
  for (const action of ['balances', 'balances/extra', '%62alances']) assert.equal((await dispatchCore(request(action, {}), env, never)).status, 503);
  assert.equal((await dispatchCore(request('prepare', { requestId: id, amountAtomic: '1', chainId: 56 }), env, never)).status, 503);
});


test('Core preparation admits only the two reviewed networks and legacy Ethereum default with no token, receiver or RPC override', async () => {
  let calls = 0;
  const resolve = () => ({ fetch: async () => { calls++; return Response.json({}); } });
  for (const input of [{ requestId: id, amountAtomic: '1' }, { requestId: id, amountAtomic: '1', chainId: 1 }, { requestId: id, amountAtomic: '1', chainId: 137 }]) {
    assert.equal((await dispatchCore(request('prepare', input), env, resolve)).status, 200);
  }
  assert.equal(calls, 3);
  const never = () => assert.fail('unapproved preparation reached a container');
  for (const extra of [{ chainId: 56 }, { chainId: '137' }, { chainId: null }, { chainId: 0 }, { chainId: 1.5 },
    { chainId: 137, tokenAddress: '0x' + '2'.repeat(40) }, { chainId: 1, recipientAddress: '0x' + '2'.repeat(40) },
    { rpcUrl: 'https://evil.invalid' }, { chainId: 137, walletAddress: '0x' + '2'.repeat(40) }]) {
    assert.equal((await dispatchCore(request('prepare', { requestId: id, amountAtomic: '1', ...extra }), env, never)).status, 503);
  }
});
