import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchCore } from '../src/routing.mjs';
import { containerEnvironment } from '../src/runtime-env.mjs';

const prefix = '/api/member/polygon-relay', id = '11111111-1111-4111-8111-111111111111', signature = `0x${'2'.repeat(130)}`;
const env = { CORE_ENV: 'production', AUTH_SERVICES_ENABLED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_CUTOVER_VERIFIED: 'true',
  CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false', PERSONAL_POLYGON_RELAY_ENABLED: 'true', PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED: 'true' };
function request(action = 'prepare', input = { requestId: id, amountAtomic: '28433366' }, extra = {}) {
  return new Request(`https://auth.core.internal${prefix}/${action}`, { method: 'POST', headers: { origin: 'https://app.mindblisspower.com',
    cookie: 'better-auth.session_token=synthetic', 'content-type': 'application/json', 'x-vp-auth-signature': 'a'.repeat(64),
    'x-vp-auth-timestamp': '1794350000', 'x-vp-auth-client-ip': '192.0.2.1', ...extra }, body: JSON.stringify(input) });
}
const read = (action, extra) => new Request(`https://auth.core.internal${prefix}/${action}`, { headers: request('prepare', undefined, extra).headers });
const never = () => assert.fail('unreviewed relay request reached a container');
const base = () => ({ ...env, AUTH_CUTOVER_VERIFIED: 'false', PERSONAL_COMPANY_PAYMENTS_ENABLED: 'false',
  API_DATABASE_URL: 'postgres://reader:synthetic@db.example.invalid/app?sslmode=verify-full',
  API_AUTH_DATABASE_URL: 'postgres://auth:synthetic@db.example.invalid/app?sslmode=verify-full', API_AUTH_SECRET: 'a'.repeat(48),
  API_BFF_SHARED_SECRET: 'b'.repeat(48), API_AUTH_URL: 'https://app.mindblisspower.com', API_AUTH_ORIGINS: 'https://app.mindblisspower.com',
  API_ENGINE_GRPC_URL: 'https://engine.example.invalid', API_ENGINE_TLS_CA_PEM: 'synthetic', API_ENGINE_TLS_CERT_PEM: 'synthetic',
  API_ENGINE_TLS_KEY_PEM: 'synthetic', API_REOWN_PROJECT_ID: 'a'.repeat(32), API_PIMLICO_API_KEY: 'synthetic-pimlico-key',
  API_POLYGON_RELAYER_PRIVATE_KEY: `0x${'1'.repeat(64)}`, API_POLYGON_RELAY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') });

test('Core routes only exact owned relay contracts to the API without granting broad financial writes', async () => {
  const forwarded = [];
  const resolve = (service, instance) => { assert.equal(service, 'api'); assert.equal(instance, 'singleton'); return {
    fetch: async input => { forwarded.push({ url: input.url, body: input.method === 'POST' ? await input.json() : null }); return Response.json({}); } }; };
  for (const [action, input] of [['prepare', { requestId: id, amountAtomic: '28433366' }], ['authorize', { paymentId: id, signature }],
    ['submit', { paymentId: id }], ['verify', { paymentId: id }], ['abandon', { paymentId: id }]]) assert.equal((await dispatchCore(request(action, input), env, resolve)).status, 200);
  for (const action of ['capabilities', 'history', `status?paymentId=${id}`]) assert.equal((await dispatchCore(read(action), env, resolve)).status, 200);
  assert.equal(forwarded.length, 8);
  assert.deepEqual(forwarded[1].body, { paymentId: id, signature });
  assert.equal((await dispatchCore(request('../arbitrary-transfer', {}), env, never)).status, 503);
});

test('pausing broadcast blocks new authorization and submission while canonical status and verify recovery remain usable', async () => {
  let calls = 0; const resolve = () => ({ fetch: async () => { calls++; return Response.json({}); } });
  const paused = { ...env, PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED: 'false' };
  for (const action of ['capabilities', 'history', `status?paymentId=${id}`]) assert.equal((await dispatchCore(read(action), paused, resolve)).status, 200);
  assert.equal((await dispatchCore(request('verify', { paymentId: id }), paused, resolve)).status, 200);
  assert.equal((await dispatchCore(request('abandon', { paymentId: id }), paused, resolve)).status, 200);
  for (const [action, input] of [['prepare', { requestId: id, amountAtomic: '1' }], ['authorize', { paymentId: id, signature }], ['submit', { paymentId: id }]]) {
    assert.equal((await dispatchCore(request(action, input), paused, never)).status, 503);
  }
  assert.equal(calls, 5);
  assert.equal((await dispatchCore(read('history'), { ...env, PERSONAL_POLYGON_RELAY_ENABLED: 'false' }, never)).status, 503);
});

test('Core rejects foreign portals, missing session/HMAC and caller-selected policy even when broad Core is enabled', async () => {
  const broad = { ...env, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' };
  for (const extra of [{ origin: 'https://wallet.mindblisspower.com' }, { origin: 'https://app.mindblisspower.com.evil.test' },
    { cookie: '' }, { cookie: 'other.session_token=synthetic' }, { 'x-vp-auth-signature': '' }, { 'x-vp-auth-timestamp': '' },
    { 'x-vp-auth-client-ip': '' }, { 'x-vp-act-as': 'other' }, { 'content-encoding': 'gzip' }]) {
    assert.equal((await dispatchCore(request('prepare', undefined, extra), broad, never)).status, 503);
    assert.equal((await dispatchCore(read('history', extra), broad, never)).status, 503);
  }
  for (const input of [{ requestId: id, amountAtomic: '0' }, { requestId: id, amountAtomic: '01' }, { requestId: id, amountAtomic: 1 },
    { requestId: id, amountAtomic: (1n << 256n).toString() }, ...['subject', 'walletAddress', 'tokenAddress', 'recipientAddress', 'chainId', 'rpcUrl', 'userOperation'].map(key => ({ requestId: id, amountAtomic: '1', [key]: 'foreign' }))]) {
    assert.equal((await dispatchCore(request('prepare', input), broad, never)).status, 503);
  }
  for (const [action, input] of [['authorize', { paymentId: id, signature, typedData: {} }], ['authorize', { paymentId: id, signature: `0x${'a'.repeat(128)}` }],
    ['submit', { paymentId: id, signedOperation: 'private' }], ['verify', { paymentId: id, transactionHash: `0x${'3'.repeat(64)}` }],
    ['abandon', { paymentId: id, signature }]]) {
    assert.equal((await dispatchCore(request(action, input), broad, never)).status, 503);
  }
});

test('relay namespace aliases, extra queries, unsupported methods and oversized bodies cannot fall through the gateway', async () => {
  const broad = { ...env, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' };
  for (const action of ['%70repare', '%2570repare', '/prepare', 'prepare/', 'prepare/extra', 'prepare?subject=foreign']) {
    assert.equal((await dispatchCore(request(action), broad, never)).status, 503);
  }
  for (const action of ['history?subject=foreign', 'capabilities?chainId=1', `status?paymentId=${id}&paymentId=${id}`,
    `status?paymentId=%31${id.slice(1)}`, `status?walletAddress=foreign&paymentId=${id}`, 'status', 'events']) {
    assert.equal((await dispatchCore(read(action), broad, never)).status, 503);
  }
  assert.equal((await dispatchCore(new Request(read('history'), { method: 'HEAD' }), broad, never)).status, 503);
  assert.equal((await dispatchCore(request('prepare', { requestId: id, amountAtomic: '1', padding: 'x'.repeat(4096) }), broad, never)).status, 413);
  const invalidUtf8 = new Request(`https://auth.core.internal${prefix}/prepare`, { method: 'POST', headers: request().headers, body: new Uint8Array([0xff]) });
  assert.equal((await dispatchCore(invalidUtf8, broad, never)).status, 503);
});

test('relay upstream failures reveal only reviewed error codes and no provider messages, ciphertext or cookie headers', async () => {
  for (const error of ['polygon_relay_fee_unavailable', 'polygon_relay_broadcast_ambiguous', 'company_payment_rpc_unavailable', 'private provider key']) {
    const result = await dispatchCore(request(), env, () => ({ fetch: async () => Response.json({ error, ciphertext: 'private', raw: 'private' },
      { status: 503, headers: { 'set-cookie': 'private', 'x-provider-secret': 'private' } }) }));
    assert.deepEqual(await result.json(), { error: error === 'private provider key' ? 'upstream_unavailable' : error });
    assert.equal(result.headers.get('set-cookie'), null); assert.equal(result.headers.get('x-provider-secret'), null);
  }
});

test('only an enabled API receives validated sponsor credentials and the fixed Polygon budgets', () => {
  const config = base(), values = containerEnvironment('api', config);
  assert.equal(values.PERSONAL_COMPANY_PAYMENTS_ENABLED, 'false'); assert.equal(values.REOWN_PROJECT_ID, config.API_REOWN_PROJECT_ID);
  assert.equal(values.PIMLICO_API_KEY, config.API_PIMLICO_API_KEY); assert.equal(values.POLYGON_RELAYER_PRIVATE_KEY, config.API_POLYGON_RELAYER_PRIVATE_KEY);
  assert.equal(values.POLYGON_RELAY_ENCRYPTION_KEY, config.API_POLYGON_RELAY_ENCRYPTION_KEY); assert.equal(values.POLYGON_RELAY_ENCRYPTION_KEY_ID, 'v1');
  assert.equal(values.PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED, 'true'); assert.equal(values.PERSONAL_POLYGON_RELAY_MAX_FEE_WEI, '1000000000000000000');
  for (const flag of [undefined, 'false']) {
    const inactive = { ...config, PERSONAL_POLYGON_RELAY_ENABLED: flag };
    for (const key of ['API_PIMLICO_API_KEY', 'API_POLYGON_RELAYER_PRIVATE_KEY', 'API_POLYGON_RELAY_ENCRYPTION_KEY', 'PERSONAL_POLYGON_RELAY_MAX_FEE_WEI']) {
      Object.defineProperty(inactive, key, { get: () => assert.fail(`read dormant relay setting: ${key}`) });
    }
    const disabled = containerEnvironment('api', inactive);
    assert.equal(disabled.PERSONAL_POLYGON_RELAY_ENABLED, 'false'); assert.equal(disabled.PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED, 'false');
    for (const key of ['PIMLICO_API_KEY', 'POLYGON_RELAYER_PRIVATE_KEY', 'POLYGON_RELAY_ENCRYPTION_KEY', 'REOWN_PROJECT_ID']) assert.equal(disabled[key], undefined);
  }
  const otherServices = { ...config, ENGINE_DATABASE_URL: config.API_DATABASE_URL, ENGINE_ROOT_AFFILIATE_ID: 'synthetic',
    ENGINE_TLS_CERT_PEM: 'synthetic', ENGINE_TLS_KEY_PEM: 'synthetic', ENGINE_TLS_CLIENT_CA_PEM: 'synthetic',
    PAYMENTS_DATABASE_URL: config.API_DATABASE_URL, PAYMENTS_SERVICE_TOKEN: 'synthetic', CORE_SUPER_ADMIN_EMAILS: 'synthetic@example.test',
    PAYMENTS_ROOT_AFFILIATE_ID: 'synthetic', AUTH_JWT_ISSUER: 'https://app.mindblisspower.com', AUTH_JWT_AUDIENCE: 'synthetic',
    WITHDRAWALS_DATABASE_URL: config.API_DATABASE_URL, WITHDRAWALS_SERVICE_TOKEN: 'synthetic' };
  for (const service of ['engine', 'payments', 'withdrawals']) {
    const values = containerEnvironment(service, otherServices);
    for (const key of ['PIMLICO_API_KEY', 'POLYGON_RELAYER_PRIVATE_KEY', 'POLYGON_RELAY_ENCRYPTION_KEY', 'REOWN_PROJECT_ID', 'PERSONAL_POLYGON_RELAY_ENABLED']) assert.equal(values[key], undefined);
  }
});

test('relay runtime rejects malformed credentials and budget increases without reflecting their values', () => {
  const config = base();
  for (const change of [{ API_PIMLICO_API_KEY: '' }, { API_PIMLICO_API_KEY: 'synthetic\nprivate-key' }, { API_POLYGON_RELAYER_PRIVATE_KEY: `0x${'0'.repeat(64)}` },
    { API_POLYGON_RELAYER_PRIVATE_KEY: `0x${'f'.repeat(64)}` }, { API_POLYGON_RELAY_ENCRYPTION_KEY: 'invalid-private-value' },
    { API_POLYGON_RELAY_ENCRYPTION_KEY: `${config.API_POLYGON_RELAY_ENCRYPTION_KEY.slice(0, 42)}l=` },
    { API_REOWN_PROJECT_ID: 'https://evil.invalid' }, { PERSONAL_POLYGON_RELAY_MAX_FEE_WEI: '1000000000000000001' },
    { PERSONAL_POLYGON_RELAY_OWNER_DAILY_BUDGET_WEI: '1' }, { PERSONAL_POLYGON_RELAY_DAILY_BUDGET_WEI: '10000000000000000001' },
    { POLYGON_RELAY_ENCRYPTION_KEY_ID: 'foreign.key' }]) {
    assert.throws(() => containerEnvironment('api', { ...config, ...change }), error => !/private-key|invalid-private-value|evil\.invalid/.test(error.message));
  }
  assert.equal(containerEnvironment('api', { ...config, PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED: 'false' }).PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED, 'false');
});
