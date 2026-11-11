import { expect, spyOn, test } from 'bun:test';
import { normalizeReownProductionRoutes, readReownProductionOptions } from './reown-funding-options';

const route = (partner = 'SWAPPED', methods: unknown[] = [
  { name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 10, max: 30_000 } },
]) => ({ partner, source: 'USD', destination: 'USDT_POLYGON', paymentMethods: methods });
const mockFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  (async (url, init) => handler(String(url), init!)) as typeof fetch;

test('personal discovery is a read-only production request scoped to the public Reown merchant', async () => {
  let calls = 0;
  const result = await readReownProductionOptions('US', { fetchImpl: mockFetch((url, init) => {
    calls++;
    expect(url).toBe('https://api.meld.io/network-partner/supported/routes/CRYPTO_ONRAMP/US/USD/USDT_POLYGON?partners=SWAPPED,MERCURYO');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).get('authorization')).toBe(
      'BASIC WXETMuFUQmqqybHuRkSgxv:25B8LJHSfpG6LVjR2ytU5Cwh7Z4Sch2ocoU');
    return Response.json([route(), route('TRANSAK'), route('TOPPER'), route('MERCURYO', [
      { name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 7.81, max: 111_530 } },
      { name: 'ASTROPAY', limits: { currencyCode: 'USD', min: 7.81, max: 20_633.05 } },
    ])]);
  }) });
  expect(calls).toBe(1);
  expect(result).toEqual({ walletKind: 'personal', environment: 'production', provider: 'reown', country: 'US', sourceCurrencyCode: 'USD',
    paymentMethods: ['CREDIT_DEBIT_CARD', 'ASTROPAY'], routes: [
      { serviceProvider: 'SWAPPED', paymentMethods: [{ method: 'CREDIT_DEBIT_CARD', currencyCode: 'USD', minimumAmount: 10, maximumAmount: 30_000, minimumUsd: 10, maximumUsd: 30_000 }] },
      { serviceProvider: 'MERCURYO', paymentMethods: [
        { method: 'CREDIT_DEBIT_CARD', currencyCode: 'USD', minimumAmount: 7.81, maximumAmount: 111_530, minimumUsd: 7.81, maximumUsd: 111_530 },
        { method: 'ASTROPAY', currencyCode: 'USD', minimumAmount: 7.81, maximumAmount: 20_633.05, minimumUsd: 7.81, maximumUsd: 20_633.05 },
      ] },
    ] });
  expect(JSON.stringify(result)).not.toContain('WXETMu');
});

test('MXN SPEI discovery keeps provider currency and limits distinct from USD', async () => {
  const speiRoute = { partner: 'SWAPPED', source: 'MXN', destination: 'USDT_POLYGON',
    paymentMethods: [{ name: 'SPEI', limits: { currencyCode: 'MXN', min: 148.66, max: 212370.61 } },
      { name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'MXN', min: 100, max: 500000 } }] };
  const result = await readReownProductionOptions('MX', { sourceCurrencyCode: 'MXN', fetchImpl: mockFetch((url, init) => {
    expect(url).toContain('/MX/MXN/USDT_POLYGON');
    expect(url).not.toContain('api-sb');
    expect(init.method).toBe('GET');
    return Response.json([speiRoute]);
  }) });
  expect(result.sourceCurrencyCode).toBe('MXN');
  expect(result.routes).toEqual([{ serviceProvider: 'SWAPPED', paymentMethods: [
    { method: 'SPEI', currencyCode: 'MXN', minimumAmount: 931, maximumAmount: 212370.61 },
  ] }]);
  expect(JSON.stringify(result)).not.toContain('minimumUsd');
  expect(() => normalizeReownProductionRoutes([speiRoute], 'USD')).toThrow();
  expect(() => normalizeReownProductionRoutes([{ ...speiRoute,
    paymentMethods: [{ name: 'SPEI', limits: { currencyCode: 'USD', min: 50, max: 1000 } }] }], 'MXN')).toThrow();
  for (const sourceCurrencyCode of ['mxn', 'MXN/USD', 'US', 'MXN?x=y', 'COP']) {
    await expect(readReownProductionOptions('MX', { sourceCurrencyCode, fetchImpl: mockFetch(() => { throw new Error('must not fetch'); }) }))
      .rejects.toThrow('wallet_funding_invalid_currency');
  }
  await expect(readReownProductionOptions('US', { sourceCurrencyCode: 'MXN', fetchImpl: mockFetch(() => { throw new Error('must not fetch'); }) }))
    .rejects.toThrow('wallet_funding_invalid_currency');
});

test('personal MXN discovery applies the fixed 931 floor, preserves higher provider minima and omits routes that cannot meet it', async () => {
  const mxn = (partner: string, min: number, max: number) => ({ partner, source: 'MXN', destination: 'USDT_POLYGON',
    paymentMethods: [{ name: 'SPEI', limits: { currencyCode: 'MXN', min, max } }] });
  const result = await readReownProductionOptions('MX', { sourceCurrencyCode: 'MXN', fetchImpl: mockFetch(() =>
    Response.json([mxn('SWAPPED', 148.66, 212370.61), mxn('MERCURYO', 1200, 10000)])) });
  expect(result.routes.map(route => route.paymentMethods[0]!.minimumAmount)).toEqual([931, 1200]);
  const unavailable = await readReownProductionOptions('MX', { sourceCurrencyCode: 'MXN', fetchImpl: mockFetch(() =>
    Response.json([mxn('SWAPPED', 100, 930.99)])) });
  expect(unavailable.routes).toEqual([]); expect(unavailable.paymentMethods).toEqual([]);
  const exact = await readReownProductionOptions('MX', { sourceCurrencyCode: 'MXN', fetchImpl: mockFetch(() =>
    Response.json([mxn('SWAPPED', 100, 931)])) });
  expect(exact.routes[0]!.paymentMethods[0]).toEqual({ method: 'SPEI', currencyCode: 'MXN', minimumAmount: 931, maximumAmount: 931 });
  expect(JSON.stringify(result)).not.toMatch(/minimumUsd|exchangeRate|fiatAmountInUsd/);
});

test('personal funding is limited to US and Mexico and removes Neteller and Skrill rails', async () => {
  for (const country of ['US', 'MX']) {
    const result = await readReownProductionOptions(country, { fetchImpl: mockFetch((url) => {
      expect(url).toContain(`/${country}/USD/USDT_POLYGON`);
      return Response.json([route('SWAPPED', [
        { name: 'NETELLER', limits: { currencyCode: 'USD', min: 10, max: 1000 } },
        { name: 'SKRILL', limits: { currencyCode: 'USD', min: 10, max: 1000 } },
        { name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 10, max: 1000 } },
        { name: 'GOOGLE_PAY', limits: { currencyCode: 'USD', min: 10, max: 1000 } },
      ])]);
    }) });
    expect(result.paymentMethods).toEqual(['CREDIT_DEBIT_CARD', 'GOOGLE_PAY']);
    expect(result.routes[0]!.paymentMethods.map(method => method.method)).toEqual(result.paymentMethods);
  }
});

test('unavailable country routes and unknown limits never invent default rails', async () => {
  for (const data of [[], [route('BANXA')], [route('TOPPER')], [route('SWAPPED', [{ name: 'CREDIT_DEBIT_CARD', limits: null }])]]) {
    const result = await readReownProductionOptions('US', { fetchImpl: mockFetch(() => Response.json(data)) });
    expect(result.paymentMethods).toEqual([]);
    expect(result.routes).toEqual([]);
  }
});

test('malformed provider routes cannot broaden allowed country, currency or amount', async () => {
  const invalid: unknown[] = [null, {}, { routes: [route()] }, [null], [{ ...route(), source: 'COP' }],
    [{ ...route(), destination: 'USDT_ETHEREUM' }], [route('SWAPPED', [{ name: 'card', limits: { currencyCode: 'USD', min: 10, max: 100 } }])],
    [route('SWAPPED', [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'COP', min: 10, max: 100 } }])],
    [route('SWAPPED', [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: '10', max: 100 } }])],
    [route('SWAPPED', [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: -1, max: 100 } }])],
    [route('SWAPPED', [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 100, max: 10 } }])],
    [route(), route('SWAPPED', [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 5, max: 100 } }])]];
  for (const data of invalid) {
    expect(() => normalizeReownProductionRoutes(data)).toThrow('wallet_funding_provider_unavailable');
  }
  expect(normalizeReownProductionRoutes([route(), route()])).toHaveLength(1);
});

test('provider errors, redirects and oversized responses fail closed without exposing body details', async () => {
  const responses = [Response.json({ message: 'private provider information' }, { status: 401 }),
    Response.json([], { status: 503 }), new Response('[]', { status: 302, headers: { location: 'https://api-sb.meld.io/' } }),
    new Response('[]', { headers: { 'content-length': '65537' } }), new Response('x'.repeat(65_537)), new Response('not json')];
  for (const response of responses) {
    await expect(readReownProductionOptions('US', { fetchImpl: mockFetch(() => response) }))
      .rejects.toThrow('wallet_funding_provider_unavailable');
  }
});

test('invalid input and cancelled country changes do not fetch or reuse stale options', async () => {
  let calls = 0;
  const fetchImpl = mockFetch(() => { calls++; return Response.json([route()]); });
  for (const country of ['co', 'CO', 'PA', 'GB', 'ES', 'COL', 'CO/../US', '', 'US?country=CO']) {
    await expect(readReownProductionOptions(country, { fetchImpl })).rejects.toThrow('wallet_funding_invalid_country');
  }
  const controller = new AbortController(); controller.abort();
  await expect(readReownProductionOptions('US', { fetchImpl, signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
  expect(calls).toBe(0);
  const inFlight = new AbortController();
  const cancelled = readReownProductionOptions('US', { fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch,
    signal: inFlight.signal });
  inFlight.abort();
  await expect(cancelled).rejects.toHaveProperty('name', 'AbortError');
});

test('body streams that ignore abort cannot leave a country lookup pending', async () => {
  const controller = new AbortController();
  const pending = readReownProductionOptions('US', { signal: controller.signal,
    fetchImpl: mockFetch(() => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }))) });
  setTimeout(() => controller.abort(), 10);
  await expect(pending).rejects.toHaveProperty('name', 'AbortError');
});

test('discovery diagnostics identify only bounded failure phase, status and category without provider details', async () => {
  const cases = [
    { fetchImpl: mockFetch(() => { throw new Error('private transport URL and credentials'); }), phase: 'fetch', status: null, code: 'TRANSPORT_FAILURE' },
    { fetchImpl: mockFetch(() => Response.json({ secret: 'provider diagnostics' }, { status: 429 })), phase: 'response', status: 429, code: 'HTTP_REJECTED' },
    { fetchImpl: mockFetch(() => new Response('private invalid JSON body')), phase: 'body', status: 200, code: 'INVALID_RESPONSE' },
    { fetchImpl: mockFetch(() => Response.json([{ ...route(), source: 'MXN', secret: 'provider diagnostics' }])), phase: 'normalization', status: 200, code: 'INVALID_RESPONSE' },
  ];
  for (const item of cases) {
    const events: unknown[] = [];
    await expect(readReownProductionOptions('US', { fetchImpl: item.fetchImpl, diagnostic: event => events.push(event) }))
      .rejects.toThrow('wallet_funding_provider_unavailable');
    expect(events).toEqual([{ event: 'personal_funding_discovery_failure', phase: item.phase, status: item.status,
      code: item.code, country: 'US', sourceCurrencyCode: 'USD' }]);
    expect(JSON.stringify(events)).not.toMatch(/private|credentials|secret|provider diagnostics|https?:|WXETMu/);
  }
  await expect(readReownProductionOptions('US', { fetchImpl: cases[0]!.fetchImpl, diagnostic() { throw Error('logger failed'); } }))
    .rejects.toThrow('wallet_funding_provider_unavailable');
});

test('discovery records its own deadline once while normal caller cancellation and successful lookups stay quiet', async () => {
  const events: unknown[] = [];
  const original = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementationOnce(((callback: () => void) => original(callback, 5)) as typeof setTimeout);
  try {
    await expect(readReownProductionOptions('MX', { sourceCurrencyCode: 'MXN',
      fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch, diagnostic: event => events.push(event) }))
      .rejects.toThrow('wallet_funding_provider_unavailable');
  } finally { timer.mockRestore(); }
  expect(events).toEqual([{ event: 'personal_funding_discovery_failure', phase: 'fetch', status: null,
    code: 'TIMEOUT', country: 'MX', sourceCurrencyCode: 'MXN' }]);
  events.length = 0;
  const controller = new AbortController(); controller.abort();
  await expect(readReownProductionOptions('US', { signal: controller.signal, diagnostic: event => events.push(event) }))
    .rejects.toHaveProperty('name', 'AbortError');
  await readReownProductionOptions('US', { fetchImpl: mockFetch(() => Response.json([route()])), diagnostic: event => events.push(event) });
  expect(events).toEqual([]);
});
