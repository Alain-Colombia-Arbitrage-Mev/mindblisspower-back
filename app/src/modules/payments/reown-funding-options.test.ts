import { expect, test } from 'bun:test';
import { normalizeReownProductionRoutes, readReownProductionOptions } from './reown-funding-options';

const route = (partner = 'TOPPER', methods: unknown[] = [
  { name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 10, max: 30_000 } },
]) => ({ partner, source: 'USD', destination: 'USDT_POLYGON', paymentMethods: methods });
const mockFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  (async (url, init) => handler(String(url), init!)) as typeof fetch;

test('personal discovery is a read-only production request scoped to the public Reown merchant', async () => {
  let calls = 0;
  const result = await readReownProductionOptions('CO', { fetchImpl: mockFetch((url, init) => {
    calls++;
    expect(url).toBe('https://api.meld.io/network-partner/supported/routes/CRYPTO_ONRAMP/CO/USD/USDT_POLYGON?partners=TOPPER,SWAPPED');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).get('authorization')).toBe(
      'BASIC WXETMuFUQmqqybHuRkSgxv:25B8LJHSfpG6LVjR2ytU5Cwh7Z4Sch2ocoU');
    return Response.json([route(), route('TRANSAK'), route('SWAPPED', [
      { name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 7.81, max: 111_530 } },
      { name: 'ASTROPAY', limits: { currencyCode: 'USD', min: 7.81, max: 20_633.05 } },
    ])]);
  }) });
  expect(calls).toBe(1);
  expect(result).toEqual({ walletKind: 'personal', environment: 'production', provider: 'reown', country: 'CO',
    paymentMethods: ['CREDIT_DEBIT_CARD', 'ASTROPAY'], routes: [
      { serviceProvider: 'TOPPER', paymentMethods: [{ method: 'CREDIT_DEBIT_CARD', minimumUsd: 10, maximumUsd: 30_000 }] },
      { serviceProvider: 'SWAPPED', paymentMethods: [
        { method: 'CREDIT_DEBIT_CARD', minimumUsd: 7.81, maximumUsd: 111_530 },
        { method: 'ASTROPAY', minimumUsd: 7.81, maximumUsd: 20_633.05 },
      ] },
    ] });
  expect(JSON.stringify(result)).not.toContain('WXETMu');
});

test('unavailable country routes and unknown limits never invent default rails', async () => {
  for (const data of [[], [route('BANXA')], [route('TOPPER', [{ name: 'CREDIT_DEBIT_CARD', limits: null }])]]) {
    const result = await readReownProductionOptions('CO', { fetchImpl: mockFetch(() => Response.json(data)) });
    expect(result.paymentMethods).toEqual([]);
    expect(result.routes).toEqual([]);
  }
});

test('malformed provider routes cannot broaden allowed country, currency or amount', async () => {
  const invalid: unknown[] = [null, {}, { routes: [route()] }, [null], [{ ...route(), source: 'COP' }],
    [{ ...route(), destination: 'USDT_ETHEREUM' }], [route('TOPPER', [{ name: 'card', limits: { currencyCode: 'USD', min: 10, max: 100 } }])],
    [route('TOPPER', [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'COP', min: 10, max: 100 } }])],
    [route('TOPPER', [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: '10', max: 100 } }])],
    [route('TOPPER', [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: -1, max: 100 } }])],
    [route('TOPPER', [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 100, max: 10 } }])],
    [route(), route('TOPPER', [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 5, max: 100 } }])]];
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
    await expect(readReownProductionOptions('CO', { fetchImpl: mockFetch(() => response) }))
      .rejects.toThrow('wallet_funding_provider_unavailable');
  }
});

test('invalid input and cancelled country changes do not fetch or reuse stale options', async () => {
  let calls = 0;
  const fetchImpl = mockFetch(() => { calls++; return Response.json([route()]); });
  for (const country of ['co', 'COL', 'CO/../US', '', 'US?country=CO']) {
    await expect(readReownProductionOptions(country, { fetchImpl })).rejects.toThrow('wallet_funding_invalid_country');
  }
  const controller = new AbortController(); controller.abort();
  await expect(readReownProductionOptions('CO', { fetchImpl, signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
  expect(calls).toBe(0);
  const inFlight = new AbortController();
  const cancelled = readReownProductionOptions('CO', { fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch,
    signal: inFlight.signal });
  inFlight.abort();
  await expect(cancelled).rejects.toHaveProperty('name', 'AbortError');
});

test('body streams that ignore abort cannot leave a country lookup pending', async () => {
  const controller = new AbortController();
  const pending = readReownProductionOptions('CO', { signal: controller.signal,
    fetchImpl: mockFetch(() => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }))) });
  setTimeout(() => controller.abort(), 10);
  await expect(pending).rejects.toHaveProperty('name', 'AbortError');
});
