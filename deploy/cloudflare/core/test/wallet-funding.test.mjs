import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCore } from '../src/routing.mjs';
import { containerEnvironment } from '../src/runtime-env.mjs';

const env = { CORE_ENV: 'production', AUTH_SERVICES_ENABLED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true',
  AUTH_CUTOVER_VERIFIED: 'true', CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false',
  WALLET_FUNDING_ENABLED: 'true', MELD_ADMIN_SANDBOX_ENABLED: 'true' };
const input = { requestId: '1d0f91dd-0d86-4ae2-a23e-c106ca6c360b', walletAddress: `0x${'1'.repeat(40)}`, country: 'US', amount: 100, paymentMethodType: 'CREDIT_DEBIT_CARD' };
const path = '/api/member/wallet-funding/personal/intent';
function request(route = path, body = input, extra = {}) {
  return new Request(`https://auth.core.internal${route}`, { method: 'POST', headers: {
    cookie: '__Secure-better-auth.session_token=synthetic', origin: route === '/api/member/wallet-funding/administrative/session'
      ? 'https://wallet.mindblisspower.com' : 'https://app.mindblisspower.com',
    'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
}

test('general Meld checkout is an exact separate native capability, disabled by default except private configuration metadata', async () => {
  const checkout = '/api/member/wallet-funding/administrative/checkout';
  const data = { requestId: input.requestId, country: 'US', amount: 100, sourceCurrencyCode: 'USD' };
  const create = (body = data, suffix = '', headers = {}) => request(checkout + suffix, body, { origin: 'https://wallet.mindblisspower.com', ...headers });
  const read = (suffix, headers = {}) => new Request(`https://auth.core.internal${checkout}${suffix}`, { headers: {
    cookie: 'better-auth.session_token=synthetic', origin: 'https://wallet.mindblisspower.com', ...headers } });
  const enabled = { ...env, MELD_CHECKOUT_ENABLED: 'true' }, never = () => assert.fail('disabled or invalid generic checkout reached API');
  const resolve = () => ({ fetch: async () => Response.json({}) });
  assert.equal((await dispatchCore(read('/capabilities'), env, resolve)).status, 200);
  for (const suffix of ['/capabilities', '/history', '/status?checkoutReference=' + input.requestId]) {
    for (const origin of ['', 'https://app.mindblisspower.com', 'https://wallet.mindblisspower.com.evil.test']) {
      assert.equal((await dispatchCore(read(suffix, { origin }), enabled, never)).status, 503);
    }
    assert.equal((await dispatchCore(new Request(`https://auth.core.internal${checkout}${suffix}`, { headers: { cookie: 'better-auth.session_token=synthetic' } }), enabled, never)).status, 503);
    assert.equal((await dispatchCore(read(suffix, { 'x-vp-act-as': '' }), enabled, never)).status, 503);
  }
  assert.equal((await dispatchCore(create(), env, never)).status, 503);
  for (const suffix of ['/history', '/status?checkoutReference=' + input.requestId]) assert.equal((await dispatchCore(read(suffix), env, never)).status, 503);
  assert.equal((await dispatchCore(create(), enabled, resolve)).status, 200);
  for (const country of ['US', 'MX', 'CO']) for (const amount of [50, 25000]) assert.equal((await dispatchCore(create({ ...data, country, amount }), enabled, resolve)).status, 200);
  for (const amount of [1, 10000000]) assert.equal((await dispatchCore(create({ ...data, country: 'MX', sourceCurrencyCode: 'MXN', amount }), enabled, resolve)).status, 200);
  for (const suffix of ['/history', '/status?checkoutReference=' + input.requestId]) assert.equal((await dispatchCore(read(suffix), enabled, resolve)).status, 200);
  for (const change of [{ country: 'ES' }, { country: 'co' }, { sourceCurrencyCode: 'COP' }, { sourceCurrencyCode: 'MXN' }, { amount: 49.99 },
    { amount: 25000.01 }, { amount: 100.001 }, { walletAddress: input.walletAddress }, { serviceProvider: 'BANXA' }, { paymentMethodType: 'CREDIT_DEBIT_CARD' },
    { subject: 'foreign' }, { publicKey: 'foreign' }, { sessionType: 'SELL' }, { redirectUrl: 'https://evil.test' }]) {
    assert.equal((await dispatchCore(create({ ...data, ...change }), enabled, never)).status, 503);
  }
  assert.equal((await dispatchCore(create(data, '', { origin: 'https://app.mindblisspower.com' }), enabled, never)).status, 503);
  assert.equal((await dispatchCore(create(data, '', { cookie: '' }), enabled, never)).status, 503);
  for (const suffix of ['/capabilities?debug=1', '/history?subject=foreign', '/status?checkoutReference=' + input.requestId + '&transactionId=foreign',
    '/status?checkoutReference=' + input.requestId + '&checkoutReference=' + input.requestId]) assert.equal((await dispatchCore(read(suffix), enabled, never)).status, 503);
});

test('administrative offramp catalog reads remain independent of Checkout but never admit sells, aliases or a foreign portal', async () => {
  const path = '/api/member/wallet-funding/administrative/offramp/options';
  const read = (query, origin = 'https://wallet.mindblisspower.com') => new Request('https://auth.core.internal' + path + query,
    { headers: { cookie: 'better-auth.session_token=synthetic', origin } });
  const resolve = () => ({ fetch: async () => Response.json({ execution: { canCreateSession: false, canTransfer: false } }) });
  const never = () => assert.fail('invalid offramp discovery reached API');
  for (const [country, fiat] of [['US', 'USD'], ['MX', 'USD'], ['MX', 'MXN'], ['CO', 'USD'], ['CO', 'COP']]) {
    assert.equal((await dispatchCore(read(`?country=${country}&destinationCurrencyCode=${fiat}`), { ...env, MELD_CHECKOUT_ENABLED: 'false' }, resolve)).status, 200);
  }
  for (const query of ['?country=US&destinationCurrencyCode=MXN', '?country=MX&destinationCurrencyCode=COP', '?country=ES&destinationCurrencyCode=EUR',
    '?country=CO&destinationCurrencyCode=COP&amount=100', '?destinationCurrencyCode=USD&country=US', '?country=US&destinationCurrencyCode=USD&country=MX']) {
    assert.equal((await dispatchCore(read(query), env, never)).status, 503);
  }
  assert.equal((await dispatchCore(read('?country=US&destinationCurrencyCode=USD', 'https://app.mindblisspower.com'), env, never)).status, 503);
  assert.equal((await dispatchCore(read('?country=US&destinationCurrencyCode=USD'), { ...env, MELD_ADMIN_SANDBOX_ENABLED: 'false' }, never)).status, 503);
  assert.equal((await dispatchCore(request(path, { amount: 100 }, { origin: 'https://wallet.mindblisspower.com' }), env, never)).status, 503);
});

test('sandbox contract v2 is forwarded only for exact administrative capabilities and never upgrades warm or personal clients', async () => {
  const prefix = '/api/member/wallet-funding';
  for (const route of [`${prefix}/administrative/session`, `${prefix}/administrative/status?checkoutReference=${input.requestId}`,
    `${prefix}/administrative/options?country=US&serviceProvider=TRANSAK`, `${prefix}/history?walletKind=administrative`,
    `${prefix}/personal/intent`, `${prefix}/personal/status?checkoutReference=${input.requestId}`, `${prefix}/personal/options?country=US`,
    `${prefix}/history?walletKind=personal`]) {
    const administrative = route.includes('/administrative/') || route.endsWith('walletKind=administrative');
    for (const value of [undefined, 'v1', 'V2', 'v2, v2', 'v2']) {
      let calls = 0;
      const headers = value === undefined ? {} : { 'x-mindbliss-sandbox-contract': value };
      const incoming = route.endsWith('/session') || route.endsWith('/intent')
        ? request(route, { ...input, ...(administrative ? { serviceProvider: 'TRANSAK' } : {}) }, headers)
        : new Request(`https://auth.core.internal${route}`, { headers: { cookie: 'better-auth.session_token=synthetic', ...headers } });
      const response = await dispatchCore(incoming, env, () => ({ fetch: async forwarded => {
        calls++;
        assert.equal(forwarded.headers.get('x-mindbliss-sandbox-contract'), administrative && value === 'v2' ? 'v2' : null);
        assert.equal(forwarded.headers.get('cookie'), incoming.headers.get('cookie'));
        return Response.json({});
      } }));
      assert.equal(response.status, 200); assert.equal(calls, 1);
    }
  }
});

test('US Venmo/PayPal and Mexico MXN card/mobile methods retain exact country, currency and minima', async () => {
  const resolve = () => ({ fetch: async () => new Response('{}') });
  const never = () => assert.fail('A crossed local payment method reached a container');
  assert.equal((await dispatchCore(request(path, { ...input, paymentMethodType: 'VENMO' }), env, resolve)).status, 200);
  assert.equal((await dispatchCore(request(path, { ...input, paymentMethodType: 'PAYPAL' }), env, resolve)).status, 200);
  for (const country of ['MX', 'CO']) assert.equal((await dispatchCore(request(path, { ...input, country, paymentMethodType: 'VENMO' }), env, never)).status, 503);
  for (const paymentMethodType of ['SPEI', 'CREDIT_DEBIT_CARD', 'APPLE_PAY', 'GOOGLE_PAY']) {
    assert.equal((await dispatchCore(request(path, { ...input, country: 'MX', sourceCurrencyCode: 'MXN', amount: 931, paymentMethodType }), env, resolve)).status, 200);
    assert.equal((await dispatchCore(request(path, { ...input, country: 'MX', sourceCurrencyCode: 'MXN', amount: 930.99, paymentMethodType }), env, never)).status, 503);
  }
  for (const country of ['MX', 'CO']) assert.equal((await dispatchCore(request(path, { ...input, country, paymentMethodType: 'PAYPAL' }), env, never)).status, 503);
});

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
  assert.equal((await dispatchCore(request(path, { ...input, country: 'MX', sourceCurrencyCode: 'MXN', paymentMethodType: 'VENMO', amount: 1000 }), env, never)).status, 503);
  assert.equal((await dispatchCore(request(path, { ...input, sourceCurrencyCode: 'MXN', paymentMethodType: 'SPEI', amount: 1000 }), env, never)).status, 503);
  assert.equal((await dispatchCore(request('/api/member/wallet-funding/administrative/session', {
    ...input, country: 'MX', paymentMethodType: 'SPEI', sourceCurrencyCode: 'MXN', amount: 1000, serviceProvider: 'BANXA' }), env, never)).status, 503);
});

test('personal country and payment exclusions do not restrict the separate administrative flow or historical owned status', async () => {
  const never = () => assert.fail('excluded personal funding dispatched');
  for (const country of ['PA', 'GB', 'ES']) {
    assert.equal((await dispatchCore(request(path, { ...input, country }), env, never)).status, 503);
    assert.equal((await dispatchCore(new Request(`https://auth.core.internal/api/member/wallet-funding/personal/options?country=${country}`,
      { headers: { cookie: 'better-auth.session_token=synthetic' } }), env, never)).status, 503);
  }
  for (const paymentMethodType of ['PAYPAL', 'NETELLER', 'PAYSAFECARD', 'PAYSAFE_CARD', 'SKRILL', 'SKIRLL', 'ASTROPAY']) {
    assert.equal((await dispatchCore(request(path, { ...input, paymentMethodType }), env, never)).status, 503);
  }
  let calls = 0;
  const resolve = () => ({ fetch: async () => { calls++; return Response.json({}); } });
  assert.equal((await dispatchCore(request('/api/member/wallet-funding/administrative/session', {
    ...input, country: 'CO', serviceProvider: 'BANXA', paymentMethodType: 'SKRILL' }), env, resolve)).status, 200);
  for (const country of ['US', 'MX', 'CO']) assert.equal((await dispatchCore(request(path, { ...input, country }), env, resolve)).status, 200);
  assert.equal(calls, 4);
});

test('new COP checkouts are disabled while owned COP history and Colombia USD card/mobile remain available',async()=>{
 const never=()=>assert.fail('Disabled COP or unsupported CO method reached container');const resolve=()=>({fetch:async()=>new Response('{}')});
 for(const sourceCurrencyCode of ['COP','MXN'])assert.equal((await dispatchCore(new Request('https://auth.core.internal/api/member/wallet-funding/personal/options?country=CO&sourceCurrencyCode='+sourceCurrencyCode,{headers:{cookie:'better-auth.session_token=synthetic'}}),env,never)).status,503);
 for(const paymentMethodType of ['PSE','LOCAL_BANK_TRANSFER','CREDIT_DEBIT_CARD'])assert.equal((await dispatchCore(request(path,{...input,country:'CO',sourceCurrencyCode:'COP',amount:170000,paymentMethodType}),env,never)).status,503);
 for(const paymentMethodType of ['CREDIT_DEBIT_CARD','APPLE_PAY','GOOGLE_PAY'])assert.equal((await dispatchCore(request(path,{...input,country:'CO',paymentMethodType}),env,resolve)).status,200);
 for(const paymentMethodType of ['BANK_TRANSFER','VENMO','PAYPAL'])assert.equal((await dispatchCore(request(path,{...input,country:'CO',paymentMethodType}),env,never)).status,503);
 assert.equal((await dispatchCore(new Request('https://auth.core.internal/api/member/wallet-funding/history?walletKind=personal',{headers:{cookie:'better-auth.session_token=synthetic'}}),env,resolve)).status,200);
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
  for (const origin of ['https://mindblisspower.com', 'https://app.mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev',
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

test('Core admits personal recharge from root and app without admitting origin aliases', async () => {
  let calls = 0;
  const resolve = () => ({ fetch: async () => { calls++; return Response.json({}); } });
  const never = () => assert.fail('invalid personal funding origin dispatched');
  for (const origin of ['https://mindblisspower.com', 'https://app.mindblisspower.com']) {
    assert.equal((await dispatchCore(request(path, input, { origin }), env, resolve)).status, 200);
  }
  for (const origin of ['https://mindblisspower.com.evil.test', 'http://mindblisspower.com',
    'https://mindblisspower.com:443', 'https://mindblisspower.com/', 'https://wallet.mindblisspower.com']) {
    assert.equal((await dispatchCore(request(path, input, { origin }), env, never)).status, 503);
  }
  assert.equal(calls, 2);
});

test('Core admits only public personal USD30 to 15000 while retaining administrative USD50 to25000', async () => {
  let calls = 0;
  const resolve = () => ({ fetch: async () => { calls++; return Response.json({}); } });
  const never = () => assert.fail('below minimum request dispatched');
  for (const amount of [30, 15000]) assert.equal((await dispatchCore(request(path, { ...input, amount }), env, resolve)).status, 200);
  for (const amount of [20, 29.99, 15000.01]) assert.equal((await dispatchCore(request(path, { ...input, amount }), env, never)).status, 503);
  for (const amount of [20, 49.99]) assert.equal((await dispatchCore(request('/api/member/wallet-funding/administrative/session', {
    ...input, amount, serviceProvider: 'BANXA' }), env, never)).status, 503);
  assert.equal((await dispatchCore(request('/api/member/wallet-funding/administrative/session', {
    ...input, amount: 50, serviceProvider: 'BANXA' }), env, resolve)).status, 200);
  assert.equal((await dispatchCore(request('/api/member/wallet-funding/administrative/session', {
    ...input, amount: 25000, serviceProvider: 'BANXA' }), env, resolve)).status, 200);
  assert.equal(calls, 4);
});

test('administrative MXN uses country-specific card/mobile rails with provider-owned minima instead of the personal931 floor', async () => {
  const path='/api/member/wallet-funding/administrative/session';const resolve=()=>({fetch:async()=>new Response('ok')});
  for(const [serviceProvider, paymentMethodType]of [['TRANSAK','CREDIT_DEBIT_CARD'],['TRANSAK','APPLE_PAY'],['TRANSAK','GOOGLE_PAY'],['BANXA','CREDIT_DEBIT_CARD']]){
    assert.equal((await dispatchCore(request(path,{...input,country:'MX',sourceCurrencyCode:'MXN',amount:0.01,paymentMethodType,serviceProvider}),env,resolve)).status,200);
  }
  const never=async()=>assert.fail('unsupported admin source reached gateway');
  for(const change of [{country:'US'},{country:'CO'},{sourceCurrencyCode:'COP'},{sourceCurrencyCode:'EUR'},{paymentMethodType:'SPEI'},{paymentMethodType:'PSE'},{serviceProvider:'BANXA',paymentMethodType:'APPLE_PAY'},{amount:0},{amount:0.001}]){
    assert.equal((await dispatchCore(request(path,{...input,country:'MX',sourceCurrencyCode:'MXN',amount:93,paymentMethodType:'CREDIT_DEBIT_CARD',serviceProvider:'TRANSAK',...change}),env,never)).status,503);
  }
});
