import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCore } from '../src/routing.mjs';

const root = '/api/member/administrative-wallet', reference = '6d492c47-80be-4e14-bc5f-54afaa56fc23';
const env = { CORE_ENV: 'production', AUTH_SERVICES_ENABLED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_CUTOVER_VERIFIED: 'true',
  CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false', MELD_ADMIN_SANDBOX_ENABLED: 'true', ADMINISTRATIVE_WALLET_SIGNING_ENABLED: 'true',
  ADMINISTRATIVE_MELD_OFFRAMP_ENABLED: 'true', ADMINISTRATIVE_WALLET_BROADCAST_ENABLED: 'false' };
function request(path, body, extra = {}) {
  return new Request(`https://auth.core.internal${root}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin: 'https://wallet.mindblisspower.com', cookie: 'better-auth.session_token=synthetic', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const transfer = { requestId: reference, recipient: '0x' + '2'.repeat(40), amount: '1' };
const verify = { challengeId: reference, signature: '0x' + '1'.repeat(130) };
const sell = { requestId: reference, country: 'US', destinationCurrencyCode: 'USD', amount: '100', serviceProvider: 'TRANSAK', paymentMethodType: 'PAYOUT_TO_CARD' };

test('only exact native ownership, immutable draft and hosted off-ramp preparations are admitted; no send execution route exists', async () => {
  let calls = 0; const resolve = () => ({ fetch: async () => { calls++; return Response.json({}); } });
  for (const [path, body] of [['/signing/capabilities'], ['/signing/status'], ['/signing/challenge', {}], ['/signing/verify', verify],
    ['/transfers/prepare', transfer], ['/transfers/history'], ['/offramp/prepare', sell], ['/offramp/history'], ['/offramp/status?reference=' + reference]]) {
    assert.equal((await dispatchCore(request(path, body), env, resolve)).status, 200);
  }
  assert.equal(calls, 9);
  const never = () => assert.fail('unapproved administrative operation reached the API');
  for (const path of ['/transfers/execute', '/transfers/send', '/transfers/broadcast', '/offramp/execute', '/signing/sign-transaction',
    '/transfers/prepare/extra', '/%73igning/challenge', '//signing/challenge']) {
    assert.notEqual((await dispatchCore(request(path, {}), env, never)).status, 200);
  }
});

test('wallet origin, native cookie, no acting-as, method, query, strict fields and chain-free payloads are enforced before dispatch', async () => {
  const never = () => assert.fail('crossed administrative input reached API');
  for (const path of ['/signing/capabilities', '/signing/status', '/transfers/history']) for (const headers of [
    { origin: '' }, { origin: 'https://app.mindblisspower.com' }, { origin: 'https://wallet.mindblisspower.com.evil.test' }, { cookie: '' }, { 'x-vp-act-as': '' }]) {
    assert.equal((await dispatchCore(request(path, undefined, headers), env, never)).status, 503);
  }
  for (const path of ['/signing/status?subject=foreign', '/transfers/history?nativeSessionId=foreign', '/offramp/status?reference=' + reference + '&owner=foreign']) {
    assert.equal((await dispatchCore(request(path), env, never)).status, 503);
  }
  for (const raw of [{ ...verify, address: transfer.recipient }, { ...verify, nativeSessionId: 'foreign' }, { ...verify, signature: '0x1234' }]) {
    assert.equal((await dispatchCore(request('/signing/verify', raw), env, never)).status, 503);
  }
  for (const raw of [{ address: transfer.recipient }, { nonce: 'a'.repeat(64) }, { message: 'forged' }]) assert.equal((await dispatchCore(request('/signing/challenge', raw), env, never)).status, 503);
  for (const field of ['walletAddress', 'subject', 'nativeSessionId', 'chainId', 'token', 'data', 'preparationHash']) {
    assert.equal((await dispatchCore(request('/transfers/prepare', { ...transfer, [field]: 'forged' }), env, never)).status, 503);
  }
  for (const amount of ['0', '-1', '1e6', '01', '1.0000001', '1000000000.000001']) assert.equal((await dispatchCore(request('/transfers/prepare', { ...transfer, amount }), env, never)).status, 503);
  assert.equal((await dispatchCore(request('/transfers/prepare', { ...transfer, recipient: '0x' + '0'.repeat(40) }), env, never)).status, 503);
});

test('signing and hosted off-ramp preparations have separate sandbox flags and broadcast flags never grant a route', async () => {
  const resolve = () => ({ fetch: async () => Response.json({}) }), never = () => assert.fail('disabled operation reached API');
  const disabled = { ...env, ADMINISTRATIVE_WALLET_SIGNING_ENABLED: 'false' };
  assert.equal((await dispatchCore(request('/signing/capabilities'), disabled, resolve)).status, 200);
  for (const [path, body] of [['/signing/status'], ['/signing/challenge', {}], ['/signing/verify', verify], ['/transfers/prepare', transfer], ['/transfers/history']]) {
    assert.equal((await dispatchCore(request(path, body), disabled, never)).status, 503);
  }
  assert.equal((await dispatchCore(request('/transfers/prepare', transfer), { ...env, ADMINISTRATIVE_MELD_OFFRAMP_ENABLED: 'false' }, resolve)).status, 200);
  assert.equal((await dispatchCore(request('/offramp/prepare', sell), { ...env, ADMINISTRATIVE_MELD_OFFRAMP_ENABLED: 'false' }, never)).status, 503);
  for (const [country, destinationCurrencyCode] of [['US', 'USD'], ['MX', 'MXN'], ['CO', 'COP']]) {
    assert.equal((await dispatchCore(request('/offramp/prepare', { ...sell, country, destinationCurrencyCode, serviceProvider: 'VALID_PROVIDER', paymentMethodType: 'VALID_METHOD' }), env, resolve)).status, 200);
  }
  for (const change of [{ walletAddress: transfer.recipient }, { country: 'ES' }, { destinationCurrencyCode: 'EUR' }, { paymentMethodType: 'invalid method' }]) {
    assert.equal((await dispatchCore(request('/offramp/prepare', { ...sell, ...change }), env, never)).status, 503);
  }
  assert.equal((await dispatchCore(request('/transfers/broadcast', transfer), { ...env, ADMINISTRATIVE_WALLET_BROADCAST_ENABLED: 'true' }, never)).status, 503);
});

test('administrative upstream errors retain only approved configuration enums, never signatures or transaction fields', async () => {
  const response = await dispatchCore(request('/signing/status'), env, () => ({ fetch: async () => Response.json({
    error: 'administrative_signing_unconfigured', signature: verify.signature, nativeSessionId: 'private', message: 'private' },
  { status: 503, headers: { 'x-private': 'secret' } }) }));
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'administrative_signing_unconfigured' }); assert.equal(response.headers.get('x-private'), null);
});
