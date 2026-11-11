import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCore } from '../src/routing.mjs';
import { containerEnvironment } from '../src/runtime-env.mjs';

const env = { CORE_ENV: 'production', AUTH_SERVICES_ENABLED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true',
  AUTH_CUTOVER_VERIFIED: 'true', CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false',
  WALLET_FUNDING_ENABLED: 'true', MELD_ADMIN_SANDBOX_ENABLED: 'true' };
const input = { requestId: '1d0f91dd-0d86-4ae2-a23e-c106ca6c360b', walletAddress: `0x${'1'.repeat(40)}`, country: 'US', amount: 50, paymentMethodType: 'CREDIT_DEBIT_CARD' };
const path = '/api/member/wallet-funding/personal/intent';
function request(route = path, body = input, extra = {}) {
  return new Request(`https://auth.core.internal${route}`, { method: 'POST', headers: {
    cookie: '__Secure-better-auth.session_token=synthetic', origin: route === '/api/member/wallet-funding/administrative/session'
      ? 'https://wallet.mindblisspower.com' : 'https://app.mindblisspower.com',
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
  assert.equal((await dispatchCore(new Request('https://auth.core.internal/api/member/wallet-funding/personal/options?country=US',
    { headers: { cookie: 'better-auth.session_token=synthetic' } }), { ...env, MELD_ADMIN_SANDBOX_ENABLED: 'false' }, resolve)).status, 200);
  assert.equal(calls, 6);
});

test('funding cannot select owners, environments, unsupported processors, aliases or arbitrary methods', async () => {
  const never = () => assert.fail('invalid funding request dispatched');
  for (const change of [{ subject: 'other' }, { environment: 'production' }, { amount: 19.99 }, { amount: 50.001 },
    { requestId: 'unbound' }, { country: 'CO&x=y' }, { paymentMethodType: undefined }, { paymentMethodType: 'other method' }]) {
    assert.equal((await dispatchCore(request(path, { ...input, ...change }), env, never)).status, 503);
  }
  for (const route of [path + '?subject=other', path + '/extra', path.replace('/personal/', '//personal/'),
    path.replace('/personal/', '/%70ersonal/'), '/api/member/wallet-funding/administrative/session?x=1']) {
    assert.equal((await dispatchCore(request(route), env, never)).status, 503);
  }
  for (const query of ['?country=CO&subject=other', '?country=CO&country=US', '?country=CO&serviceProvider=BANXA', '?country=co']) {
    assert.equal((await dispatchCore(new Request('https://auth.core.internal/api/member/wallet-funding/personal/options' + query,
      { headers: { cookie: 'better-auth.session_token=synthetic' } }), env, never)).status, 503);
  }
  for (const headers of [{ origin: 'https://evil.example.test' }, { cookie: '' }, { 'x-vp-act-as': 'other' }]) {
    assert.equal((await dispatchCore(request(path, input, headers), env, never)).status, 503);
  }
  for (const serviceProvider of ['BINANCECONNECT', 'TOPPER', 'SWAPPED', 'MERCURYO', 'ONRAMPMONEY']) {
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

test('currency discovery admits canonical selectors while duplicate and encoded currency selectors remain denied', async () => {
  let calls = 0;
  const resolve = () => ({ fetch: async () => { calls++; return Response.json({}); } });
  const read = path => new Request(`https://auth.core.internal${path}`, { headers: { cookie: 'better-auth.session_token=synthetic' } });
  const personal = '/api/member/wallet-funding/personal/options';
  const administrative = '/api/member/wallet-funding/administrative/options';
  assert.equal((await dispatchCore(read(personal + '?country=MX&sourceCurrencyCode=MXN'), env, resolve)).status, 200);
  assert.equal((await dispatchCore(read(administrative + '?country=MX&sourceCurrencyCode=MXN&serviceProvider=TRANSAK'), env, resolve)).status, 200);
  assert.equal(calls, 2);
  const never = () => assert.fail('malformed currency discovery dispatched');
  for (const query of ['?country=MX&sourceCurrencyCode=mxn', '?country=MX&sourceCurrencyCode=MXN&sourceCurrencyCode=USD',
    '?country=MX&sourceCurrencyCode=%4dXN', '?country=MX&sourceCurrencyCode=MXN&subject=other', '?sourceCurrencyCode=MXN&country=MX']) {
    assert.equal((await dispatchCore(read(personal + query), env, never)).status, 503);
  }
  assert.equal((await dispatchCore(read(administrative + '?country=MX&serviceProvider=TRANSAK&sourceCurrencyCode=MXN'), env, never)).status, 503);
  assert.equal((await dispatchCore(read(administrative + '?country=MX&sourceCurrencyCode=MXN&serviceProvider=SWAPPED'), env, never)).status, 503);
  // Admission is not financial valuation: the API still rejects nonUSD writes until an independently verified provider valuation exists.
  assert.equal((await dispatchCore(request(path, { ...input, country: 'MX', paymentMethodType: 'SPEI', sourceCurrencyCode: 'MXN', amount: 931 }), env, resolve)).status, 200);
  assert.equal((await dispatchCore(request(path, { ...input, country: 'MX', paymentMethodType: 'SPEI', sourceCurrencyCode: 'MXN', amount: 930.99 }), env, never)).status, 503);
  assert.equal((await dispatchCore(request(path, { ...input, sourceCurrencyCode: 'mxn', amount: 1000 }), env, never)).status, 503);
  assert.equal((await dispatchCore(request(path, { ...input, sourceCurrencyCode: null, amount: 1000 }), env, never)).status, 503);
  assert.equal((await dispatchCore(request(path, { ...input, country: 'MX', sourceCurrencyCode: 'MXN', amount: 1000 }), env, never)).status, 503);
  assert.equal((await dispatchCore(request(path, { ...input, sourceCurrencyCode: 'MXN', paymentMethodType: 'SPEI', amount: 1000 }), env, never)).status, 503);
  assert.equal((await dispatchCore(request('/api/member/wallet-funding/administrative/session', {
    ...input, country: 'MX', paymentMethodType: 'SPEI', sourceCurrencyCode: 'MXN', amount: 1000, serviceProvider: 'BANXA' }), env, never)).status, 503);
});

test('personal country and payment exclusions do not restrict the separate administrative flow or historical owned status', async () => {
  const never = () => assert.fail('excluded personal funding dispatched');
  for (const country of ['CO', 'PA', 'GB', 'ES']) {
    assert.equal((await dispatchCore(request(path, { ...input, country }), env, never)).status, 503);
    assert.equal((await dispatchCore(new Request(`https://auth.core.internal/api/member/wallet-funding/personal/options?country=${country}`,
      { headers: { cookie: 'better-auth.session_token=synthetic' } }), env, never)).status, 503);
  }
  for (const paymentMethodType of ['NETELLER', 'SKRILL']) {
    assert.equal((await dispatchCore(request(path, { ...input, paymentMethodType }), env, never)).status, 503);
  }
  let calls = 0;
  const resolve = () => ({ fetch: async () => { calls++; return Response.json({}); } });
  assert.equal((await dispatchCore(request('/api/member/wallet-funding/administrative/session', {
    ...input, country: 'CO', serviceProvider: 'BANXA', paymentMethodType: 'SKRILL' }), env, resolve)).status, 200);
  for (const country of ['US', 'MX']) assert.equal((await dispatchCore(request(path, { ...input, country }), env, resolve)).status, 200);
  assert.equal(calls, 3);
});

test('owned status reads are a separate exact native-session capability with no checkout or owner overrides', async () => {
  let calls = 0;
  const resolve = () => ({ fetch: async () => { calls++; return Response.json({}); } });
  for (const kind of ['personal', 'administrative']) {
    const path = `/api/member/wallet-funding/${kind}/status`;
    const read = (suffix, cookie = 'better-auth.session_token=synthetic') => new Request(`https://auth.core.internal${path}${suffix}`, { headers: { cookie } });
    assert.equal((await dispatchCore(read(`?checkoutReference=${input.requestId}`), { ...env, MELD_ADMIN_SANDBOX_ENABLED: 'false' }, resolve)).status, 200);
    const never = () => assert.fail('invalid owned-status request was dispatched');
    for (const query of ['', '?checkoutReference=invalid', `?checkoutReference=${input.requestId}&subject=other`,
      `?checkoutReference=${input.requestId}&checkoutReference=${input.requestId}`, `?walletKind=${kind}&checkoutReference=${input.requestId}`]) {
      assert.equal((await dispatchCore(read(query), env, never)).status, 503);
    }
    assert.equal((await dispatchCore(read(`?checkoutReference=${input.requestId}`, ''), env, never)).status, 503);
  }
  assert.equal(calls, 2);
});

test('funding failures preserve reviewed actionable enums through the real Core route without provider payload or headers', async () => {
  const adminPath = '/api/member/wallet-funding/administrative/session';
  const admin = { ...input, country: 'CO', serviceProvider: 'BANXA' };
  for (const code of ['wallet_funding_provider_authentication_unavailable', 'wallet_funding_valuation_unavailable',
    'wallet_funding_provider_unavailable', 'wallet_funding_unconfigured']) {
    let calls = 0;
    const response = await dispatchCore(request(adminPath, admin), env, () => ({ fetch: async () => {
      calls++;
      return Response.json({ error: code, message: 'private provider message', token: 'private-token',
        address: input.walletAddress }, { status: 503, headers: { 'x-private-provider': 'secret', 'set-cookie': 'private=token' } });
    } }));
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
    assert.deepEqual(await response.json(), { error: code });
    assert.equal(response.headers.get('x-private-provider'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  const privateError = async response => {
    const projected = await dispatchCore(request(adminPath, admin), env, () => ({ fetch: async () => response }));
    assert.equal(projected.status, 503);
    assert.deepEqual(await projected.json(), { error: 'upstream_unavailable' });
  };
  await privateError(Response.json({ error: 'SERVICE_PROVIDER_AUTHENTICATION_EXCEPTION', message: 'private-secret' }, { status: 503 }));
  await privateError(Response.json({ error: 'wallet_funding_provider_authentication_unavailable' }, { status: 503,
    headers: { 'content-encoding': 'gzip' } }));
  await privateError(new Response('x'.repeat(1025), { status: 503, headers: { 'content-type': 'application/json' } }));
  await privateError(new Response('{"error":"wallet_funding_provider_authentication_unavailable"}', { status: 503,
    headers: { 'content-type': 'text/plain' } }));
  const personal = await dispatchCore(request(), env, () => ({ fetch: async () => Response.json({
    error: 'wallet_funding_provider_authentication_unavailable' }, { status: 503 }) }));
  assert.deepEqual(await personal.json(), { error: 'upstream_unavailable' });
});

test('personal and administrative mutations cannot cross their explicitly separate portal origins', async () => {
  const administrativePath = '/api/member/wallet-funding/administrative/session';
  const administrative = { ...input, country: 'CO', serviceProvider: 'BANXA' };
  const never = () => assert.fail('cross-portal financial request dispatched');
  assert.equal((await dispatchCore(request(path, input, { origin: 'https://wallet.mindblisspower.com' }), env, never)).status, 503);
  for (const origin of ['https://app.mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev',
    'https://wallet.mindblisspower.com.evil.test', 'http://wallet.mindblisspower.com', 'https://wallet.mindblisspower.com:443',
    'https://wallet.mindblisspower.com/', 'https://WALLET.mindblisspower.com']) {
    assert.equal((await dispatchCore(request(administrativePath, administrative, { origin }), env, never)).status, 503);
  }
  let calls = 0;
  const resolve = () => ({ fetch: async () => { calls++; return Response.json({}); } });
  assert.equal((await dispatchCore(request(administrativePath, administrative), env, resolve)).status, 200);
  assert.equal((await dispatchCore(request(path, input, { origin: 'https://mindbliss-portal-rewon.devfidubit.workers.dev' }), env, resolve)).status, 200);
  assert.equal(calls, 2);
});

test('Core admits the USD20 personal boundary while retaining the independent USD50 administrative boundary', async () => {
  let calls = 0;
  const resolve = () => ({ fetch: async () => { calls++; return Response.json({}); } });
  const never = () => assert.fail('below minimum request dispatched');
  assert.equal((await dispatchCore(request(path, { ...input, amount: 20 }), env, resolve)).status, 200);
  assert.equal((await dispatchCore(request(path, { ...input, amount: 19.99 }), env, never)).status, 503);
  for (const amount of [20, 49.99]) assert.equal((await dispatchCore(request('/api/member/wallet-funding/administrative/session', {
    ...input, amount, serviceProvider: 'BANXA' }), env, never)).status, 503);
  assert.equal((await dispatchCore(request('/api/member/wallet-funding/administrative/session', {
    ...input, amount: 50, serviceProvider: 'BANXA' }), env, resolve)).status, 200);
  assert.equal(calls, 2);
});
