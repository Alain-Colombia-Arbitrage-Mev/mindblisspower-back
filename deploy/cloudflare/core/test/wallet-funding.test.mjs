import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCore } from '../src/routing.mjs';
import { containerEnvironment } from '../src/runtime-env.mjs';

const env = { CORE_ENV: 'production', AUTH_SERVICES_ENABLED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true',
  AUTH_CUTOVER_VERIFIED: 'true', CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false',
  WALLET_FUNDING_ENABLED: 'true', MELD_ADMIN_SANDBOX_ENABLED: 'true' };
const input = { requestId: '1d0f91dd-0d86-4ae2-a23e-c106ca6c360b', walletAddress: `0x${'1'.repeat(40)}`, country: 'CO', amount: 50 };
const path = '/api/member/wallet-funding/personal/intent';
function request(route = path, body = input, extra = {}) {
  return new Request(`https://auth.core.internal${route}`, { method: 'POST', headers: {
    cookie: '__Secure-better-auth.session_token=synthetic', origin: 'https://app.mindblisspower.com',
    'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
}

test('funding admits only the native personal intent, independent sandbox session and owned history', async () => {
  let calls = 0;
  const resolve = (service, instance) => { assert.equal(service, 'api'); assert.equal(instance, 'singleton');
    return { fetch: async req => { calls++; return new Response(req.method === 'POST' ? await req.text() : '{}'); } }; };
  assert.equal((await dispatchCore(request(), env, resolve)).status, 200);
  assert.equal((await dispatchCore(request('/api/member/wallet-funding/administrative/session', {
    ...input, serviceProvider: 'TRANSAK', paymentMethodType: 'CREDIT_DEBIT_CARD' }), env, resolve)).status, 200);
  for (const kind of ['personal', 'administrative']) assert.equal((await dispatchCore(new Request(
    `https://auth.core.internal/api/member/wallet-funding/history?walletKind=${kind}`,
    { headers: { cookie: 'better-auth.session_token=synthetic' } }), env, resolve)).status, 200);
  assert.equal((await dispatchCore(new Request('https://auth.core.internal/api/member/wallet-funding/administrative/options?country=US&serviceProvider=TRANSAK',
    { headers: { cookie: 'better-auth.session_token=synthetic' } }), env, resolve)).status, 200);
  assert.equal(calls, 5);
});

test('funding cannot select owners, environments, unsupported processors, aliases or arbitrary methods', async () => {
  const never = () => assert.fail('invalid funding request dispatched');
  for (const change of [{ subject: 'other' }, { environment: 'production' }, { amount: 49 }, { amount: 50.001 },
    { requestId: 'unbound' }, { country: 'CO&x=y' }]) {
    assert.equal((await dispatchCore(request(path, { ...input, ...change }), env, never)).status, 503);
  }
  for (const route of [path + '?subject=other', path + '/extra', path.replace('/personal/', '//personal/'),
    path.replace('/personal/', '/%70ersonal/'), '/api/member/wallet-funding/administrative/session?x=1']) {
    assert.equal((await dispatchCore(request(route), env, never)).status, 503);
  }
  for (const headers of [{ origin: 'https://evil.example.test' }, { cookie: '' }, { 'x-vp-act-as': 'other' }]) {
    assert.equal((await dispatchCore(request(path, input, headers), env, never)).status, 503);
  }
  for (const serviceProvider of ['BINANCECONNECT', 'TOPPER', 'SWAPPED', 'ONRAMPMONEY']) {
    assert.equal((await dispatchCore(request('/api/member/wallet-funding/administrative/session', {
      ...input, serviceProvider }), env, never)).status, 503);
  }
  for (const key of ['WALLET_FUNDING_ENABLED', 'AUTH_CUTOVER_VERIFIED']) {
    assert.equal((await dispatchCore(request(), { ...env, [key]: 'false' }, never)).status, 503);
  }
  assert.equal((await dispatchCore(request('/api/member/wallet-funding/administrative/session', {
    ...input, serviceProvider: 'BANXA' }), { ...env, MELD_ADMIN_SANDBOX_ENABLED: 'false' }, never)).status, 503);
});

test('sandbox credential forwarding is explicit and separate from the live financial credential', () => {
  const secrets = { ...env, AUTH_CUTOVER_VERIFIED: 'false',
    API_DATABASE_URL: 'postgres://reader:synthetic@db.example.invalid/app?sslmode=verify-full',
    API_AUTH_DATABASE_URL: 'postgres://auth:synthetic@db.example.invalid/app?sslmode=verify-full',
    API_AUTH_SECRET: 'a'.repeat(48), API_BFF_SHARED_SECRET: 'b'.repeat(48), API_AUTH_URL: 'https://app.mindblisspower.com',
    API_AUTH_ORIGINS: 'https://app.mindblisspower.com', API_ENGINE_GRPC_URL: 'https://engine.example.invalid',
    API_ENGINE_TLS_CA_PEM: 'synthetic', API_ENGINE_TLS_CERT_PEM: 'synthetic', API_ENGINE_TLS_KEY_PEM: 'synthetic',
    MELD_API_SANDBOX: 'sandbox-synthetic' };
  const values = containerEnvironment('api', secrets);
  assert.equal(values.MELD_API_SANDBOX, 'sandbox-synthetic');
  assert.equal(values.MELD_API_KEY, undefined);
  assert.equal(values.MELD_ADMIN_SANDBOX_ENABLED, 'true');
  assert.equal(containerEnvironment('api', { ...secrets, MELD_ADMIN_SANDBOX_ENABLED: 'false' }).MELD_API_SANDBOX, undefined);
  assert.throws(() => containerEnvironment('api', { ...secrets, MELD_API_SANDBOX: '' }));
});
