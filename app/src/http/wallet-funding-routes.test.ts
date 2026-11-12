import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { registerWalletFundingRoutes } from './wallet-funding-routes';
import type { ApiEnvironment } from './types';
import type { IdentityDatabase } from '../modules/identity/model';
import { createHash, createHmac } from 'node:crypto';

const origin = 'https://app.mindblisspower.com';
const administrativeOrigin = 'https://wallet.mindblisspower.com';
const personalPath = '/api/member/wallet-funding/personal/intent';
const administrativePath = '/api/member/wallet-funding/administrative/session';
const input = { requestId: '6d492c47-80be-4e14-bc5f-54afaa56fc23', walletAddress: `0x${'2'.repeat(40)}`, country: 'US', amount: 100, paymentMethodType: 'CREDIT_DEBIT_CARD' };
const secret = 's'.repeat(48);

function signedRequest(path: string, body: string, extraHeaders: Record<string, string> = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const ip = '192.0.2.1';
  const cookie = 'better-auth.session_token=synthetic';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const signature = createHmac('sha256', secret).update(['POST', path, timestamp, ip, hash(cookie), hash(body)].join('\n')).digest('hex');
  return { method: 'POST', headers: { origin: path === administrativePath ? administrativeOrigin : origin, 'content-type': 'application/json', cookie,
    'x-vp-auth-client-ip': ip, 'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': signature, ...extraHeaders }, body };
}

function application({ signedIn = true, execute = async () => [], fetchImpl }: {
  signedIn?: boolean; execute?: (input: unknown) => Promise<unknown[]>; fetchImpl?: typeof fetch;
} = {}) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => {
    context.set('session', signedIn ? { user: { id: 'synthetic-owner' } } as never : null);
    await next();
  });
  registerWalletFundingRoutes(app, { database: { execute } as Pick<IdentityDatabase, 'execute'>,
    environment: { BETTER_AUTH_URL: origin,
      BETTER_AUTH_TRUSTED_ORIGINS: `https://mindblisspower.com,${administrativeOrigin},https://mindbliss-portal-rewon.devfidubit.workers.dev`, AUTH_BFF_SHARED_SECRET: secret },
    fetchImpl: fetchImpl || (async url => {
      expect(String(url)).toStartWith('https://api.meld.io/');
      return Response.json([{ partner: 'SWAPPED', source: 'USD', destination: 'USDT_POLYGON',
        paymentMethods: [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 20, max: 15000 } }] }]);
    }) as typeof fetch });
  return app;
}

test('funding mutations require a native session, exact origin and bounded strict JSON before database work', async () => {
  let calls = 0;
  const app = application({ execute: async () => { calls++; throw new Error('unexpected database call'); } });
  for (const path of [personalPath, administrativePath]) {
    const absent = application({ signedIn: false });
    expect((await absent.request(path, { method: 'POST' })).status).toBe(401);
    expect((await app.request(path, signedRequest(path, '{}', { origin: 'https://other.test' }))).status).toBe(403);
    expect((await app.request(path, signedRequest(path, '{}', { 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await app.request(path, signedRequest(path, ' '.repeat(4097)))).status).toBe(413);
    expect((await app.request(path, signedRequest(path, JSON.stringify({ ...input, subject: 'other-owner' })))).status).toBe(400);
  }
  expect(calls).toBe(0);
});

test('personal funding returns an uncached initiated acknowledgement while sandbox configuration fails safely', async () => {
  const app = application({ execute: async () => [{ id: input.requestId, created_at: new Date('2026-11-10T20:00:00Z') }] });
  const response = await app.request(personalPath, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect((await response.json() as { environment: string }).environment).toBe('production');
  for (const [change, code] of [[{ paymentMethodType: 'ACH' }, 'wallet_funding_method_unavailable'], [{ amount: 20000 }, 'wallet_funding_amount_unavailable']] as const) {
    const unavailable = await app.request(personalPath, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...input, ...change }) });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toEqual({ error: code });
  }
  const sandbox = await app.request(administrativePath, signedRequest(administrativePath, JSON.stringify({ ...input, serviceProvider: 'TRANSAK' })));
  expect(sandbox.status).toBe(503);
  expect(await sandbox.json()).toEqual({ error: 'wallet_funding_unconfigured' });
});

test('HTTP public personal funding accepts USD30 while USD20 and29.99 are rejected without changing administrative bounds', async () => {
  let calls = 0;
  const app = application({ execute: async () => { calls++; return [{ id: input.requestId, created_at: new Date('2026-11-10T20:00:00Z') }]; } });
  for (const [amount, status] of [[20, 409], [29.99, 409], [30, 201]] as const) {
    const response = await app.request(personalPath, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, amount }) });
    expect(response.status).toBe(status);
    if (amount === 30) expect(await response.json()).toMatchObject({ requestedAmount: 30, allowedProviders: ['SWAPPED'] });
  }
  const administrative = await app.request(administrativePath, signedRequest(administrativePath,
    JSON.stringify({ ...input, amount: 20, serviceProvider: 'TRANSAK' })));
  expect(administrative.status).toBe(409);
  expect(await administrative.json()).toEqual({ error: 'wallet_funding_amount_unavailable' });
  expect(calls).toBe(1);
});

test('HTTP personal SPEI rejects 930.99 MXN and accepts 931 MXN without changing the source currency', async () => {
  let writes = 0;
  const app = application({ execute: async () => { writes++; return [{ id: input.requestId, created_at: new Date('2026-11-10T20:00:00Z') }]; },
    fetchImpl: (async () => Response.json([{ partner: 'SWAPPED', source: 'MXN', destination: 'USDT_POLYGON',
      paymentMethods: [{ name: 'SPEI', limits: { currencyCode: 'MXN', min: 148.66, max: 212370.61 } }] }])) as unknown as typeof fetch });
  for (const [amount, status] of [[930.99, 409], [931, 201]] as const) {
    const response = await app.request(personalPath, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, country: 'MX', sourceCurrencyCode: 'MXN', paymentMethodType: 'SPEI', amount }) });
    expect(response.status).toBe(status);
    if (status === 201) expect(await response.json()).toMatchObject({ requestedAmount: 931, sourceCurrencyCode: 'MXN', allowedProviders: ['SWAPPED'] });
  }
  expect(writes).toBe(1);
});

test('funding mutations are isolated by exact portal origin even when both hosts trust the same native auth service', async () => {
  let calls = 0;
  const app = application({ execute: async () => { calls++; return [{ id: input.requestId, created_at: new Date('2026-11-10T20:00:00Z') }]; } });
  for (const untrusted of [administrativeOrigin, 'https://wallet.mindblisspower.com.evil.test', 'https://mindblisspower.com.evil.test',
    'http://mindblisspower.com', 'https://mindblisspower.com:443', 'https://mindblisspower.com/']) {
    const rejected = await app.request(personalPath, { method: 'POST', headers: { origin: untrusted, 'content-type': 'application/json' },
      body: JSON.stringify(input) });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: 'invalid_origin' });
  }
  for (const untrusted of [origin, 'https://mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev', 'https://wallet.mindblisspower.com.evil.test',
    'http://wallet.mindblisspower.com', 'https://wallet.mindblisspower.com:443', 'https://wallet.mindblisspower.com/']) {
    const rejected = await app.request(administrativePath, signedRequest(administrativePath,
      JSON.stringify({ ...input, serviceProvider: 'BANXA' }), { origin: untrusted }));
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: 'invalid_origin' });
  }
  expect(calls).toBe(0);
  const personal = await app.request(personalPath, { method: 'POST', headers: {
    origin: 'https://mindbliss-portal-rewon.devfidubit.workers.dev', 'content-type': 'application/json' }, body: JSON.stringify(input) });
  expect(personal.status).toBe(201);
  expect(calls).toBe(1);
  const administrative = await app.request(administrativePath, signedRequest(administrativePath,
    JSON.stringify({ ...input, serviceProvider: 'BANXA' })));
  expect(administrative.status).toBe(503);
  expect(await administrative.json()).toEqual({ error: 'wallet_funding_unconfigured' });
  expect(calls).toBe(1);
});

test('root and app personal recharge acknowledgements remain production-only and independent from sandbox', async () => {
  let writes = 0;
  const app = application({ execute: async () => { writes++; return [{ id: input.requestId, created_at: new Date('2026-11-10T20:00:00Z') }]; } });
  for (const origin of ['https://mindblisspower.com', 'https://app.mindblisspower.com']) {
    const response = await app.request(personalPath, signedRequest(personalPath, JSON.stringify(input), { origin }));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ walletKind: 'personal', environment: 'production', sourceCurrencyCode: 'USD' });
  }
  expect(writes).toBe(2);
});

test('a retired funding writer or conflicting historical intent gives an actionable safe code even through SQL wrappers', async () => {
  for (const code of ['wallet_funding_network_changed', 'wallet_funding_request_already_used']) {
    const app = application({ execute: async () => { throw new Error('private SQL and parameters', { cause: new Error(code) }); } });
    const response = await app.request(personalPath, signedRequest(personalPath, JSON.stringify(input)));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: code });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  }
});

test('the administrative provider IP must come from a signed proxy envelope bound to path, cookie and body', async () => {
  let calls = 0;
  const app = application({ execute: async () => { calls++; throw new Error('unexpected database call'); } });
  const body = JSON.stringify({ ...input, serviceProvider: 'TRANSAK' });
  const mutations: Record<string, string>[] = [{ 'x-vp-auth-client-ip': '198.51.100.1' }, { 'x-vp-auth-signature': '0'.repeat(64) },
    { 'x-vp-auth-timestamp': '1000000000' }, { cookie: 'better-auth.session_token=other-session' }];
  for (const headers of mutations) {
    expect((await app.request(administrativePath, signedRequest(administrativePath, body, headers))).status).toBe(403);
  }
  const changedBody = { ...signedRequest(administrativePath, body), body: JSON.stringify({ ...input, amount: 250, serviceProvider: 'TRANSAK' }) };
  expect((await app.request(administrativePath, changedBody)).status).toBe(403);
  expect(calls).toBe(0);
});

test('history rejects owner selectors, duplicate query keys, missing sessions and arbitrary database diagnostics', async () => {
  let calls = 0;
  const app = application({ execute: async () => { calls++; throw new Error('postgres://private:secret@private-target'); } });
  for (const query of ['', '?walletKind=personal&subject=other', '?walletKind=personal&walletKind=administrative', '?walletKind=other']) {
    expect((await app.request(`/api/member/wallet-funding/history${query}`)).status).toBe(400);
  }
  expect(calls).toBe(0);
  const response = await app.request('/api/member/wallet-funding/history?walletKind=personal');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'wallet_funding_unavailable' });
  expect((await application({ signedIn: false }).request('/api/member/wallet-funding/history?walletKind=personal')).status).toBe(401);
});

test('administrative options require a session and one exact country/provider without account selectors', async () => {
  const app = application();
  const path = '/api/member/wallet-funding/administrative/options';
  for (const query of ['', '?country=US&serviceProvider=TOPPER', '?country=US&country=CO&serviceProvider=TRANSAK',
    '?country=US&serviceProvider=TRANSAK&subject=other']) {
    expect((await app.request(path + query)).status).toBe(400);
  }
  expect((await application({ signedIn: false }).request(path + '?country=US&serviceProvider=TRANSAK')).status).toBe(401);
  const response = await app.request(path + '?country=US&serviceProvider=TRANSAK');
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ error: 'wallet_funding_unconfigured' });
});

test('personal options use one native-session country query without a sandbox credential or provider selector', async () => {
  const app = application();
  const path = '/api/member/wallet-funding/personal/options';
  for (const query of ['', '?country=US&country=CO', '?country=US&serviceProvider=TRANSAK', '?country=us', '?country=US&subject=other', '?country=PA', '?country=ES']) {
    expect((await app.request(path + query)).status).toBe(400);
  }
  expect((await application({ signedIn: false }).request(path + '?country=US')).status).toBe(401);
  const response = await app.request(path + '?country=US');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toMatchObject({ walletKind: 'personal', environment: 'production', provider: 'reown', country: 'US', paymentMethods: ['CREDIT_DEBIT_CARD'] });
});

test('personal upstream throttling remains HTTP429 for discovery and intent without persisting or exposing provider details', async () => {
  let reads = 0, writes = 0;
  const app = application({ execute: async () => { writes++; throw Error('Throttled discovery cannot persist an intent'); },
    fetchImpl: (async () => { reads++; return Response.json({ code: 'private-provider-code', message: 'private-provider-message' },
      { status: 429, headers: { 'retry-after': '60' } }); }) as unknown as typeof fetch });
  for (const [path, init] of [
    ['/api/member/wallet-funding/personal/options?country=US', undefined],
    [personalPath, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(input) }],
  ] as const) {
    const response = await app.request(path, init);
    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ error: 'wallet_funding_rate_limited' });
  }
  expect(reads).toBe(2); expect(writes).toBe(0);
});

test('HTTP Colombia keeps USD and offers COP PSE through Onramp Money without mixing provider routes or amounts', async () => {
  let writes = 0;
  const app = application({ execute: async () => { writes++; return [{ id: input.requestId, created_at: new Date('2026-11-10T20:00:00Z') }]; },
    fetchImpl: (async url => {
      if (String(url).includes('/CO/COP/')) {
        expect(String(url)).toEndWith('/CO/COP/USDT_POLYGON?partners=ONRAMPMONEY');
        return Response.json([{ partner: 'ONRAMPMONEY', source: 'COP', destination: 'USDT_POLYGON', paymentMethods: [
          { name: 'PSE', checkoutSupported: true, headlessSupported: false, limits: { currencyCode: 'COP', min: 42300, max: 59900000 } },
          { name: 'LOCAL_BANK_TRANSFER', checkoutSupported: true, limits: { currencyCode: 'COP', min: 42300, max: 59900000 } },
        ] }]);
      }
      expect(String(url)).toContain('/CO/USD/USDT_POLYGON?partners=SWAPPED,MERCURYO');
      return Response.json([{ partner: 'SWAPPED', source: 'USD', destination: 'USDT_POLYGON',
        paymentMethods: [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 20, max: 15000 } }] }]);
    }) as typeof fetch });
  const options = await app.request('/api/member/wallet-funding/personal/options?country=CO&sourceCurrencyCode=USD');
  expect(options.status).toBe(200);
  expect(await options.json()).toMatchObject({ country: 'CO', sourceCurrencyCode: 'USD', environment: 'production',
    routes: [{ serviceProvider: 'SWAPPED', paymentMethods: [{ minimumAmount: 30, maximumAmount: 15000, minimumUsd: 30, maximumUsd: 15000 }] }] });
  const accepted = await app.request(personalPath, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, country: 'CO', amount: 30 }) });
  expect(accepted.status).toBe(201);
  expect(await accepted.json()).toMatchObject({ sourceCurrencyCode: 'USD', requestedAmount: 30, environment: 'production' });
  const copOptions = await app.request('/api/member/wallet-funding/personal/options?country=CO&sourceCurrencyCode=COP');
  expect(copOptions.status).toBe(200);
  expect(copOptions.headers.get('cache-control')).toBe('private, no-store');
  expect(await copOptions.json()).toMatchObject({ country: 'CO', sourceCurrencyCode: 'COP', environment: 'production', paymentMethods: ['PSE', 'LOCAL_BANK_TRANSFER'],
    routes: [{ serviceProvider: 'ONRAMPMONEY', paymentMethods: [{ currencyCode: 'COP', minimumAmount: 170000, maximumAmount: 4000000 }, { currencyCode: 'COP', minimumAmount: 170000, maximumAmount: 4000000 }] }] });
  const pse = { ...input, country: 'CO', sourceCurrencyCode: 'COP', amount: 170000, paymentMethodType: 'PSE' };
  const copIntent = await app.request(personalPath, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(pse) });
  expect(copIntent.status).toBe(201);
  expect(await copIntent.json()).toMatchObject({ sourceCurrencyCode: 'COP', requestedAmount: 170000, paymentMethodType: 'PSE', allowedProviders: ['ONRAMPMONEY'] });
  const localIntent = await app.request(personalPath, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ...pse, paymentMethodType: 'LOCAL_BANK_TRANSFER' }) });
  expect(localIntent.status).toBe(201);
  expect(await localIntent.json()).toMatchObject({ requestedAmount: 170000, sourceCurrencyCode: 'COP', paymentMethodType: 'LOCAL_BANK_TRANSFER', allowedProviders: ['ONRAMPMONEY'] });
  expect((await app.request('/api/member/wallet-funding/personal/options?country=CO&sourceCurrencyCode=MXN')).status).toBe(400);
  for (const country of ['US', 'MX']) expect((await app.request(`/api/member/wallet-funding/personal/options?country=${country}&sourceCurrencyCode=COP`)).status).toBe(400);
  for (const sourceCurrencyCode of ['COP', 'MXN']) {
    const rejected = await app.request(personalPath, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, country: 'CO', sourceCurrencyCode, amount: 931, paymentMethodType: 'SPEI' }) });
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({ error: 'wallet_funding_valuation_unavailable' });
  }
  for (const amount of [42300, 100000, 169999.99, 4000000.01]) {
    const rejected = await app.request(personalPath, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...pse, amount }) });
    expect(rejected.status).toBe(409); expect(await rejected.json()).toEqual({ error: 'wallet_funding_amount_unavailable' });
  }
  expect(writes).toBe(3);
});

test('currency selectors are strict and non-USD mutations expose no unverified USD acknowledgement', async () => {
  let calls = 0;
  const app = application({ execute: async () => { calls++; throw new Error('must not write'); } });
  for (const kind of ['personal', 'administrative']) {
    const optionsPath = `/api/member/wallet-funding/${kind}/options`;
    const provider = kind === 'administrative' ? '&serviceProvider=TRANSAK' : '';
    for (const query of ['?country=MX&sourceCurrencyCode=mxn', '?country=MX&sourceCurrencyCode=MXN&sourceCurrencyCode=USD',
      '?country=MX&sourceCurrencyCode=MXN&currency=USD']) {
      expect((await app.request(optionsPath + query + provider)).status).toBe(400);
    }
  }
  const response = await app.request(personalPath, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, country: 'MX', sourceCurrencyCode: 'MXN' }) });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'wallet_funding_valuation_unavailable' });
  const administrative = await app.request(administrativePath, signedRequest(administrativePath,
    JSON.stringify({ ...input, serviceProvider: 'TRANSAK', sourceCurrencyCode: 'MXN' })));
  expect(administrative.status).toBe(503);
  expect(await administrative.json()).toEqual({ error: 'wallet_funding_valuation_unavailable' });
  expect(calls).toBe(0);
});

test('status requires native ownership, an exact reference query and uncached indistinguishable not-found responses', async () => {
  let calls = 0;
  const app = application({ execute: async () => { calls++; return []; } });
  for (const kind of ['personal', 'administrative']) {
    const path = `/api/member/wallet-funding/${kind}/status`;
    for (const query of ['', '?checkoutReference=bad', `?checkoutReference=${input.requestId}&subject=other`,
      `?checkoutReference=${input.requestId}&checkoutReference=${input.requestId}`, `?checkoutReference=${input.requestId}&walletKind=personal`]) {
      expect((await app.request(path + query)).status).toBe(400);
    }
    expect(calls).toBe(0);
    expect((await application({ signedIn: false }).request(path + `?checkoutReference=${input.requestId}`)).status).toBe(401);
    const response = await app.request(path + `?checkoutReference=${input.requestId}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ error: 'wallet_funding_not_found' });
    calls = 0;
  }
});
