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
    destinationCurrencyCode: 'USDT_POLYGON', network: 'polygon', chainId: 137,
    paymentMethods: ['CREDIT_DEBIT_CARD'], routes: [
      { serviceProvider: 'SWAPPED', paymentMethods: [{ method: 'CREDIT_DEBIT_CARD', currencyCode: 'USD', minimumAmount: 30, maximumAmount: 15_000, minimumUsd: 30, maximumUsd: 15_000 }] },
      { serviceProvider: 'MERCURYO', paymentMethods: [
        { method: 'CREDIT_DEBIT_CARD', currencyCode: 'USD', minimumAmount: 30, maximumAmount: 15_000, minimumUsd: 30, maximumUsd: 15_000 },
      ] },
    ] });
  expect(JSON.stringify(result)).not.toContain('WXETMu');
});

test('temporarily unavailable AstroPay cannot become an offered rail even with valid positive provider limits', () => {
  expect(normalizeReownProductionRoutes([route('SWAPPED', [
    { name: 'ASTROPAY', limits: { currencyCode: 'USD', min: 7.81, max: 20633.05 } },
  ])])).toEqual([]);
});

test('public USD discovery intersects provider limits with 30 to 15000 without a test-minimum bypass', async () => {
  const usd = (partner: string, min: number, max: number) => route(partner, [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min, max } }]);
  const result = await readReownProductionOptions('US', { fetchImpl: mockFetch(() => Response.json([
    usd('SWAPPED', 7.81, 111530), usd('MERCURYO', 200, 12000),
  ])) });
  expect(result.routes.map(route => route.paymentMethods[0])).toEqual([
    { method: 'CREDIT_DEBIT_CARD', currencyCode: 'USD', minimumAmount: 30, maximumAmount: 15000, minimumUsd: 30, maximumUsd: 15000 },
    { method: 'CREDIT_DEBIT_CARD', currencyCode: 'USD', minimumAmount: 200, maximumAmount: 12000, minimumUsd: 200, maximumUsd: 12000 },
  ]);
  const none = await readReownProductionOptions('US', { fetchImpl: mockFetch(() => Response.json([
    usd('SWAPPED', 1, 29.99), usd('MERCURYO', 15000.01, 20000),
  ])) });
  expect(none.paymentMethods).toEqual([]); expect(none.routes).toEqual([]);
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
  for (const country of ['US', 'CO']) await expect(readReownProductionOptions(country, {
    sourceCurrencyCode: 'MXN', fetchImpl: mockFetch(() => { throw new Error('must not fetch'); }),
  })).rejects.toThrow('wallet_funding_invalid_currency');
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

test('Colombia COP discovers only hosted PSE and local bank through Onramp Money within the COP business bounds', async () => {
  const cop = (partner = 'ONRAMPMONEY', checkoutSupported: unknown = true) => ({ partner, source: 'COP', destination: 'USDT_POLYGON', paymentMethods: [
    { name: 'PSE', checkoutSupported, headlessSupported: false, limits: { currencyCode: 'COP', min: 42300, max: 59900000 } },
    { name: 'LOCAL_BANK_TRANSFER', checkoutSupported: true, limits: { currencyCode: 'COP', min: 42300, max: 59900000 } },
    { name: 'CREDIT_DEBIT_CARD', checkoutSupported: true, limits: { currencyCode: 'COP', min: 42300, max: 59900000 } },
    { name: 'SKRILL', checkoutSupported: true, limits: { currencyCode: 'COP', min: 1, max: 99999999 } },
  ] });
  let calls = 0;
  const result = await readReownProductionOptions('CO', { sourceCurrencyCode: 'COP', fetchImpl: mockFetch((url, init) => {
    calls++;
    expect(url).toBe('https://api.meld.io/network-partner/supported/routes/CRYPTO_ONRAMP/CO/COP/USDT_POLYGON?partners=ONRAMPMONEY');
    expect(init.method).toBe('GET');
    return Response.json([cop(), cop('SWAPPED'), cop('MERCURYO')]);
  }) });
  expect(calls).toBe(1);
  expect(result).toMatchObject({ country: 'CO', sourceCurrencyCode: 'COP', destinationCurrencyCode: 'USDT_POLYGON', network: 'polygon', chainId: 137,
    paymentMethods: ['PSE', 'LOCAL_BANK_TRANSFER'], routes: [{ serviceProvider: 'ONRAMPMONEY', paymentMethods: [
      { method: 'PSE', currencyCode: 'COP', minimumAmount: 170000, maximumAmount: 4000000 },
      { method: 'LOCAL_BANK_TRANSFER', currencyCode: 'COP', minimumAmount: 170000, maximumAmount: 4000000 },
    ] }] });
  expect(JSON.stringify(result)).not.toMatch(/minimumUsd|maximumUsd|exchangeRate|fiatAmountInUsd/);
  for (const supported of [false, undefined, 'true', null]) {
    const body = cop(); body.paymentMethods.forEach(method => { method.checkoutSupported = supported; });
    expect(normalizeReownProductionRoutes([body], 'COP')).toEqual([]);
  }
  for (const country of ['US', 'MX']) await expect(readReownProductionOptions(country, { sourceCurrencyCode: 'COP',
    fetchImpl: mockFetch(() => { throw Error('foreign COP must not fetch'); }) })).rejects.toThrow('wallet_funding_invalid_currency');
  expect(normalizeReownProductionRoutes([{ ...cop(), source: 'USD' }], 'USD')).toEqual([]);
  expect(() => normalizeReownProductionRoutes([{ ...cop(), destination: 'USDT_ETHEREUM' }], 'COP')).toThrow();
  expect(() => normalizeReownProductionRoutes([{ ...cop(), paymentMethods: [{ ...cop().paymentMethods[0]!, limits: { currencyCode: 'USD', min: 50, max: 100 } }] }], 'COP')).toThrow();
  for (const [min, max, expected] of [[200000, 2000000, [200000, 2000000]], [42300, 169999, null], [4000001, 59900000, null]] as const) {
    const limited = cop(); limited.paymentMethods = [limited.paymentMethods[0]!]; limited.paymentMethods[0]!.limits = { currencyCode: 'COP', min, max };
    const options = await readReownProductionOptions('CO', { sourceCurrencyCode: 'COP', fetchImpl: mockFetch(() => Response.json([limited])) });
    expect(options.routes.flatMap(route => route.paymentMethods.map(method => [method.minimumAmount, method.maximumAmount])))
      .toEqual(expected ? [[...expected]] : []);
  }
});

test('local COP and MXN bank method IDs never become USD bank rails and unconfigured bank providers remain excluded', async () => {
  for (const country of ['US', 'MX']) {
    const options = await readReownProductionOptions(country, { fetchImpl: mockFetch(() => Response.json([
      route('SWAPPED', ['CREDIT_DEBIT_CARD', 'PSE', 'SPEI', 'LOCAL_BANK_TRANSFER'].map(name => ({ name, checkoutSupported: true, limits: { currencyCode: 'USD', min: 30, max: 15000 } }))),
      route('BINANCECONNECT', [{ name: 'BANK_TRANSFER', limits: { currencyCode: 'USD', min: 50, max: 15000 } }]),
      route('ONRAMPMONEY', [{ name: 'LOCAL_BANK_TRANSFER', checkoutSupported: true, limits: { currencyCode: 'USD', min: 50, max: 15000 } }]),
    ])) });
    expect(options.paymentMethods).toEqual(['CREDIT_DEBIT_CARD']);
    expect(options.routes.map(route => route.serviceProvider)).toEqual(['SWAPPED']);
  }
});

test('personal funding admits its countries but removes every prohibited method and alias from provider routes', async () => {
  for (const country of ['US', 'MX', 'CO']) {
    const result = await readReownProductionOptions(country, { fetchImpl: mockFetch((url) => {
      expect(url).toContain(`/${country}/USD/USDT_POLYGON`);
      return Response.json([route('SWAPPED', [
        ...['PAYPAL', 'NETELLER', 'PAYSAFECARD', 'PAYSAFE_CARD', 'SKRILL', 'SKIRLL'].map(name => ({
          name, limits: { currencyCode: 'USD', min: 10, max: 1000 } })),
        { name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 10, max: 1000 } },
        { name: 'GOOGLE_PAY', limits: { currencyCode: 'USD', min: 10, max: 1000 } },
      ])]);
    }) });
    expect(result.paymentMethods).toEqual(['CREDIT_DEBIT_CARD', 'GOOGLE_PAY']);
    expect(result.routes[0]!.paymentMethods.map(method => method.method)).toEqual(result.paymentMethods);
  }
  expect(normalizeReownProductionRoutes([route('SWAPPED', ['PAYPAL', 'NETELLER', 'PAYSAFECARD', 'PAYSAFE_CARD', 'SKRILL', 'SKIRLL'].map(name => ({
    name, limits: { currencyCode: 'USD', min: 10, max: 1000 },
  })))])).toEqual([]);
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
    [{ ...route(), destination: 'USDT_ETHEREUM' }], [{ ...route(), destination: 'USDT' }], [route('SWAPPED', [{ name: 'card', limits: { currencyCode: 'USD', min: 10, max: 100 } }])],
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
  for (const country of ['co', 'PA', 'GB', 'ES', 'COL', 'CO/../US', '', 'US?country=CO']) {
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
      .rejects.toThrow(item.status === 429 ? 'wallet_funding_rate_limited' : 'wallet_funding_provider_unavailable');
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
