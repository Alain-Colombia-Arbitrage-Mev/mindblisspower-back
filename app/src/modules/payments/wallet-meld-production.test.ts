import { expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { SandboxWalletDatabase } from '../identity/sandbox-wallet';
import { createProductionWalletSession, normalizeProductionWalletRoutes, productionWalletCapabilities, productionWalletCheckoutUrl,
  quoteProductionWalletFunding, readProductionWalletDiscovery, readProductionWalletHistory, readProductionWalletStatus } from './wallet-meld-production';
import { productionMeldJson, productionScope } from './wallet-meld-production-http';

const id = '6d492c47-80be-4e14-bc5f-54afaa56fc23', customer = '7d492c47-80be-4e14-bc5f-54afaa56fc23', wallet = `0x${'1'.repeat(40)}`;
const subject = 'synthetic-owner', nativeSessionId = 'synthetic-session', account = 'production-account', now = new Date();
const environment = { WALLET_MELD_PRODUCTION_ENABLED: 'true', MELD_PRODUCTION_API_KEYS: 'synthetic-production-key', MELD_PRODUCTION_ACCOUNT_ID: account };
const input = { requestId: id, country: 'MX', sourceCurrencyCode: 'MXN', amount: 2000, paymentMethodType: 'CREDIT_DEBIT_CARD', serviceProvider: 'BANXA' };
const options = { subject, nativeSessionId, clientIp: '192.0.2.1', environment };
const binding = { address: wallet, binding_reference: customer };
const row = { id, subject, address: wallet, country_code: 'MX', source_currency: 'MXN', requested_amount: 2000, service_provider: 'BANXA',
  payment_method: 'SPEI', status: 'session_created', created_at: now, customer_reference: customer, account_id: account,
  provider_session_id: 'vendor-session', provider_customer_id: 'vendor-customer', proof: null, checked_at: null };
function routes(names = ['BANXA'], fiat = 'MXN', method = 'CREDIT_DEBIT_CARD') { return names.map(partner => ({ partner, source: fiat,
  destination: 'USDT_POLYGON', checkoutSupported: true, paymentMethods: [{ name: method, limits: { currencyCode: fiat, min: 1000, max: 50000 } }] })); }
function quote(provider = 'BANXA') { return { quotes: [{ serviceProvider: provider, sourceCurrencyCode: 'MXN', sourceAmount: 2000,
  destinationCurrencyCode: 'USDT_POLYGON', destinationAmount: 101.25, paymentMethodType: 'CREDIT_DEBIT_CARD', transactionType: 'CRYPTO_PURCHASE', totalFee: 53, networkFee: 1 }] }; }
const widget = { id: 'vendor-session', customerId: 'vendor-customer', externalSessionId: id, externalCustomerId: customer,
  serviceProviderWidgetUrl: 'https://unknown-provider.invalid/private', widgetUrl: 'https://meldcrypto.com/?token=synthetic.token' };
function database(outputs: unknown[][]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  return { queries, database: { execute: async (query: SQL) => {
    const parsed = new PgDialect().sqlToQuery(query); queries.push(parsed);
    if (parsed.sql.includes('record_wallet_meld_production_proof')) return [{ proof: JSON.parse(parsed.params[2] as string) }];
    const result = outputs.shift(); if (!result) throw Error('unexpected SQL'); return result;
  } } as unknown as SandboxWalletDatabase };
}
function provider(outputs: unknown[]) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const fetchImpl = (async (target: string | Request | URL, init?: RequestInit) => { calls.push({ url: String(target), headers: new Headers(init?.headers),
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : null }); const result = outputs.shift();
    if (result === undefined) throw Error('unexpected provider call'); return result instanceof Response ? result : Response.json(result);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
test('production gate never borrows sandbox credentials and disabled flows make no DB/provider call', async () => {
  const db = database([]), api = provider([]);
  for (const env of [{}, { ...environment, WALLET_MELD_PRODUCTION_ENABLED: 'false' }, { MELD_API_SANDBOX: 'sandbox', MELD_ACCOUNT_ID: 'sb' },
    { ...environment, MELD_PRODUCTION_API_KEYS: 'with whitespace' }, { ...environment, MELD_PRODUCTION_ACCOUNT_ID: '../other' }]) {
    expect(productionWalletCapabilities(env).configured).toBe(false);
    await expect(createProductionWalletSession(db.database, input, { ...options, environment: env, fetchImpl: api.fetchImpl })).rejects.toThrow('unconfigured');
  }
  expect(db.queries).toHaveLength(0); expect(api.calls).toHaveLength(0);
});
test('routes exclude forbidden or unlockable providers and preserve fiat limits without FX conversion', () => {
  const result = normalizeProductionWalletRoutes(routes(['BANXA', 'ONRAMPMONEY', 'MERCURYO', 'BINANCECONNECT', 'SWAPPED']), 'MXN');
  expect(result.map(item => item.serviceProvider)).toEqual(['BANXA', 'ONRAMPMONEY']); expect(result[0]!.paymentMethods[0]).toEqual({ method: 'CREDIT_DEBIT_CARD', currencyCode: 'MXN', minimumAmount: 1000, maximumAmount: 50000 });
  expect(normalizeProductionWalletRoutes(routes(['BANXA'], 'USD'), 'USD')[0]!.paymentMethods[0]!.maximumAmount).toBe(25000);
  expect(() => normalizeProductionWalletRoutes([{ ...routes()[0], source: 'USD' }], 'MXN')).toThrow('provider_unavailable');
  expect(normalizeProductionWalletRoutes([{ ...routes()[0], checkoutSupported: false }], 'MXN')).toEqual([]);
});
test('only new Banxa MX/MXN/SPEI is quarantined; other providers, methods and country/currency contexts remain available', () => {
  const raw = [...routes(['BANXA', 'ONRAMPMONEY'], 'MXN', 'SPEI'), ...routes(['BANXA'], 'MXN', 'CREDIT_DEBIT_CARD')];
  const safe = normalizeProductionWalletRoutes(raw, 'MXN', 'MX');
  expect(safe.find(item => item.serviceProvider === 'BANXA')!.paymentMethods.map(item => item.method)).toEqual(['CREDIT_DEBIT_CARD']);
  expect(safe.find(item => item.serviceProvider === 'ONRAMPMONEY')!.paymentMethods.map(item => item.method)).toEqual(['SPEI']);
  expect(normalizeProductionWalletRoutes(routes(['BANXA'], 'USD', 'SPEI'), 'USD', 'MX')).toHaveLength(1);
  expect(normalizeProductionWalletRoutes(routes(['BANXA'], 'MXN', 'SPEI'), 'MXN', 'CO')).toHaveLength(1);
  expect(normalizeProductionWalletRoutes(routes(['BANXA'], 'MXN', 'SPEI'), 'MXN', 'MX')).toEqual([]);
});
test('stale or injected Banxa SPEI selection cannot create a journal row or widget, while Onramp Money still quotes', async () => {
  const raw = { ...input, paymentMethodType: 'SPEI' }, db = database([[binding]]), api = provider([routes(['BANXA'], 'MXN', 'SPEI')]);
  await expect(createProductionWalletSession(db.database, raw, { ...options, fetchImpl: api.fetchImpl })).rejects.toThrow('method_unavailable');
  expect(db.queries).toHaveLength(1); expect(api.calls).toHaveLength(1); // Binding SELECT and route GET only.
  const mixed = database([[binding]]), upstream = provider([routes(['BANXA', 'ONRAMPMONEY'], 'MXN', 'SPEI'),
    { quotes: [{ ...quote('ONRAMPMONEY').quotes[0], paymentMethodType: 'SPEI' }] }]);
  const { requestId, serviceProvider, ...quoteInput } = raw;
  expect((await quoteProductionWalletFunding(mixed.database, quoteInput, { ...options, fetchImpl: upstream.fetchImpl })).quotes.map(item => item.serviceProvider)).toEqual(['ONRAMPMONEY']);
  expect(upstream.calls).toHaveLength(2); expect(upstream.calls[1]!.body.serviceProviders).toEqual(['ONRAMPMONEY']);
});
test('owned historical Banxa MX/MXN/SPEI attempts remain readable after quarantine, without any vendor call', async () => {
  const db = database([[row]]), api = provider([]);
  const result = await readProductionWalletHistory(db.database, { subject, nativeSessionId }, { environment, fetchImpl: api.fetchImpl });
  expect(result.records).toHaveLength(1); expect(result.records[0]).toMatchObject({ checkoutReference: id, serviceProvider: 'BANXA',
    country: 'MX', sourceCurrencyCode: 'MXN', requestedAmount: 2000, paymentMethodType: 'SPEI', destination: { address: wallet } });
  expect(api.calls).toHaveLength(0); expect(db.queries).toHaveLength(1);
});
test('explicit quotes omit a provider that advertises a route but returns invalid quote; no journal is written', async () => {
  const db = database([[binding]]), api = provider([routes(['BANXA', 'ONRAMPMONEY', 'MERCURYO']), Response.json({ code: 'INVALID_CRYPTO_CURRENCY' }, { status: 400 }), quote('ONRAMPMONEY')]);
  const { requestId, serviceProvider, ...raw } = input;
  const result = await quoteProductionWalletFunding(db.database, raw, { ...options, fetchImpl: api.fetchImpl });
  expect(result.quotes.map(item => item.serviceProvider)).toEqual(['ONRAMPMONEY']); expect(result.destination.address).toBe(wallet);
  expect(db.queries).toHaveLength(1); expect(api.calls).toHaveLength(3);
  for (const call of api.calls) { expect(call.url).toStartWith('https://api.meld.io/'); expect(call.headers.get('authorization')).toBe('BASIC synthetic-production-key'); expect(call.headers.get('meld-account-id')).toBe(account); }
  expect(api.calls.slice(1).map(call => call.body.serviceProviders)).toEqual([['BANXA'], ['ONRAMPMONEY']]);
  expect(api.calls[1]!.body.walletAddress).toBe(wallet); expect(api.calls[1]!.body.clientIpAddress).toBe('192.0.2.1');
});
test('all failed or crossed quote facts remain unavailable without automatic retries or journal writes', async () => {
  for (const response of [Response.json({}, { status: 401 }), { quotes: [] }, quote('TRANSAK'), { quotes: [{ ...quote().quotes[0], sourceAmount: 2001 }] },
    { quotes: [{ ...quote().quotes[0], walletAddress: `0x${'2'.repeat(40)}` }] }, { quotes: [{ ...quote().quotes[0], destinationCurrencyCode: 'USDT' }] }]) {
    const db = database([[binding]]), api = provider([routes(), response]), { requestId, serviceProvider, ...raw } = input;
    await expect(quoteProductionWalletFunding(db.database, raw, { ...options, fetchImpl: api.fetchImpl })).rejects.toThrow('quote_unavailable');
    expect(db.queries).toHaveLength(1); expect(api.calls).toHaveLength(2);
  }
});
test('production mint uses permanent SQL binding, exact fresh quote and server-only destination locks', async () => {
  const db = database([[binding], [{ id, address: wallet, customer_reference: customer, created: true, status: 'initiated', created_at: now }], [{ finished: true }]]);
  const api = provider([routes(), quote(), widget]); const result = await createProductionWalletSession(db.database, input, { ...options, fetchImpl: api.fetchImpl });
  expect(result).toMatchObject({ environment: 'production', walletKind: 'personal', country: 'MX', serviceProvider: 'BANXA', checkoutUrl: widget.widgetUrl, destination: { address: wallet, chainId: 137 } });
  expect(db.queries[1]!.params).toEqual([subject, nativeSessionId, id, 'MX', 2000, 'MXN', 'CREDIT_DEBIT_CARD', 'BANXA', account]);
  const sent = api.calls[2]!.body; expect(sent.sessionData.walletAddress).toBe(wallet); expect(sent.sessionData.sourceAmount).toBe('2000.00');
  expect(sent.sessionData.lockFields).toContain('walletAddress'); expect(sent.sessionData.lockFields).toContain('destinationCurrencyCode');
  expect(sent.sessionData.redirectUrl).toEndWith(`?walletCheckoutReference=${id}`);
  expect(JSON.stringify(db.queries)).not.toMatch(/create_connected_wallet_sandbox|record_meld_sandbox_proof|administrative_wallet_assignment|ledger|commission/);
});
test('injection, excluded providers and failed fresh quote stop before registration or session creation', async () => {
  for (const raw of [{ ...input, address: wallet }, { ...input, sourceAmount: 100 }, { ...input, serviceProvider: 'MERCURYO' },
    { ...input, serviceProvider: 'BINANCECONNECT' }, { ...input, amount: 0 }, { ...input, amount: 2000.123 }, { ...input, accountId: 'other' }]) {
    const db = database([]), api = provider([]); await expect(createProductionWalletSession(db.database, raw, { ...options, fetchImpl: api.fetchImpl })).rejects.toThrow();
    expect(db.queries).toHaveLength(0); expect(api.calls).toHaveLength(0);
  }
  const db = database([[binding]]), api = provider([routes(), Response.json({}, { status: 400 })]);
  await expect(createProductionWalletSession(db.database, input, { ...options, fetchImpl: api.fetchImpl })).rejects.toThrow('provider_unavailable');
  expect(db.queries).toHaveLength(1); expect(api.calls).toHaveLength(2);
});
test('checkout rejects sandbox URLs, foreign references and opaque unknown hosts before returning an openable URL', async () => {
  for (const changed of [{ ...widget, externalSessionId: customer }, { ...widget, serviceProvider: 'TRANSAK' },
    { ...widget, widgetUrl: 'https://sb.meldcrypto.com/?token=synthetic' }, { ...widget, widgetUrl: 'https://meldcrypto.com.evil.test/?token=synthetic' }]) {
    const db = database([[binding], [{ id, address: wallet, customer_reference: customer, created: true, status: 'initiated', created_at: now }], [{ finished: true }]]), api = provider([routes(), quote(), changed]);
    await expect(createProductionWalletSession(db.database, input, { ...options, fetchImpl: api.fetchImpl })).rejects.toThrow('provider_unavailable');
    expect(db.queries[2]!.params).toEqual([subject, nativeSessionId, id, 'unavailable', null, null]); expect(api.calls).toHaveLength(3);
  }
  for (const url of ['https://meldcrypto.com:443/?token=a', 'https://user@meldcrypto.com/?token=a', 'https://meldcrypto.com/?token=a&token=b',
    'https://meldcrypto.com/?token=a#', 'https://meldcrypto.com/?token=%61', 'https://global-stg.transak.com/?apiKey=a&sessionId=b']) expect(productionWalletCheckoutUrl(url, 'BANXA')).toBeNull();
});
test('verified Banxa production transit URL is preferred and only its one opaque initId may vary', async () => {
  const direct = 'https://meldshared.banxa.com/papi/transit/?initId=opaque-production%2Bvalue%3D';
  const db = database([[binding], [{ id, address: wallet, customer_reference: customer, created: true, status: 'initiated', created_at: now }], [{ finished: true }]]),
    api = provider([routes(), quote(), { ...widget, serviceProviderWidgetUrl: direct }]);
  expect((await createProductionWalletSession(db.database, input, { ...options, fetchImpl: api.fetchImpl })).checkoutUrl).toBe(direct);
  expect(productionWalletCheckoutUrl(direct, 'TRANSAK')).toBeNull();
  for (const url of [direct.replace('https://', 'http://'), direct.replace('meldshared.banxa.com', 'meldshared.banxa.com.evil.test'),
    direct.replace('meldshared.banxa.com', 'user@meldshared.banxa.com'), direct.replace('meldshared.banxa.com', 'meldshared.banxa.com:443'),
    direct.replace('/papi/transit/', '/papi/other/'), direct.replace('initId=', '%69nitId='), direct + '&initId=second', direct + '&redirect=https://evil.test',
    direct + '#', direct.replace('opaque-production%2Bvalue%3D', '%2F%2Fevil.test%3Furl%3Dx')])
    expect(productionWalletCheckoutUrl(url, 'BANXA')).toBeNull();
});
function transaction(change: Record<string, unknown> = {}) { return { transaction: { id: 'tx-valid', accountId: account,
  sessionId: row.provider_session_id, customerId: row.provider_customer_id, externalSessionId: id, externalCustomerId: customer,
  serviceProvider: 'BANXA', countryCode: 'MX', sourceCurrencyCode: 'MXN', sourceAmount: 2000, destinationCurrencyCode: 'USDT_POLYGON',
  destinationAmount: 101.25, paymentMethodType: 'SPEI', transactionType: 'CRYPTO_PURCHASE', status: 'SETTLED', updatedAt: now.toISOString(),
  cryptoDetails: { chainId: '137', destinationWalletAddress: wallet }, ...change } }; }
test('owner status independently reads exact transaction and records production proof only, never balance/commission credits', async () => {
  const db = database([[row]]), api = provider([{ transactions: [{ id: 'tx-valid' }] }, transaction()]);
  const result = await readProductionWalletStatus(db.database, { subject, nativeSessionId, checkoutReference: id }, { environment, fetchImpl: api.fetchImpl });
  expect(result.confirmation).toMatchObject({ state: 'confirmed', source: 'meld_production_api', testMode: false, receivedAmount: '101.25' });
  expect(api.calls).toHaveLength(2); expect(api.calls[1]!.url).toEndWith('/payments/transactions/tx-valid');
  expect(db.queries[1]!.sql).toContain('record_wallet_meld_production_proof'); expect(JSON.stringify(db.queries)).not.toMatch(/record_connected_wallet_sandbox_proof|ledger|commission/);
});
test('foreign ownership and provider/payment/session/amount/network mismatch never write proof', async () => {
  for (const change of [{ accountId: 'foreign' }, { customerId: 'foreign' }, { externalCustomerId: id }, { sessionId: 'foreign' },
    { serviceProvider: 'TRANSAK' }, { paymentMethodType: 'APPLE_PAY' }, { sourceAmount: 2000.01 }, { status: 'FAKE_SETTLED' },
    { cryptoDetails: { chainId: '1', destinationWalletAddress: wallet } }]) {
    const db = database([[row]]), api = provider([{ transactions: [{ id: 'tx-valid' }] }, transaction(change)]);
    await expect(readProductionWalletStatus(db.database, { subject, nativeSessionId, checkoutReference: id }, { environment, fetchImpl: api.fetchImpl })).rejects.toThrow('provider_unavailable');
    expect(db.queries).toHaveLength(1);
  }
  const db = database([[{ ...row, subject: 'foreign' }]]), api = provider([]);
  await expect(readProductionWalletHistory(db.database, { subject, nativeSessionId }, { environment, fetchImpl: api.fetchImpl })).rejects.toThrow('unavailable'); expect(api.calls).toHaveLength(0);
});
test('ambiguous search and dot path identifiers cannot trigger a guessed transaction GET or write', async () => {
  for (const transactions of [[{ id: '.' }], [{ id: '..' }], [{ id: 'tx-one' }, { id: 'tx-two' }]]) {
    const db = database([[row]]), api = provider([{ transactions }]);
    await expect(readProductionWalletStatus(db.database, { subject, nativeSessionId, checkoutReference: id }, { environment, fetchImpl: api.fetchImpl })).rejects.toThrow('provider_unavailable');
    expect(api.calls).toHaveLength(1); expect(db.queries).toHaveLength(1);
  }
});
test('discovery is account-scoped and returns only metadata, no guessed currency default or secret', async () => {
  const api = provider([{ countries: [{ countryCode: 'CO', name: 'Colombia' }, { countryCode: 'ES', name: 'Spain' }] },
    { currencies: [{ currencyCode: 'COP', name: 'Colombian Peso', decimalPlaces: 2, type: 'FIAT' }] }, { currencyCode: 'COP' }]);
  expect(await readProductionWalletDiscovery(undefined, { environment, fetchImpl: api.fetchImpl })).toEqual({ countries: [{ code: 'CO', name: 'Colombia' }, { code: 'ES', name: 'Spain' }] });
  expect(await readProductionWalletDiscovery('CO', { environment, fetchImpl: api.fetchImpl })).toEqual({ country: 'CO', currencies: [{ code: 'COP', name: 'Colombian Peso', decimalPlaces: 2 }], defaultCurrencyCode: 'COP' });
  expect(api.calls.every(call => call.headers.get('meld-account-id') === account)).toBe(true);
});
test('hung body/transport obey bounded abort even if the vendor ignores cancellation', async () => {
  const scope = productionScope(undefined, 5), fetchImpl = (async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  try { await expect(productionMeldJson('/payments/transactions/tx-valid', { key: 'synthetic-key', account, fetchImpl, signal: scope.signal })).rejects.toThrow('unavailable'); }
  finally { scope.close(); }
});
