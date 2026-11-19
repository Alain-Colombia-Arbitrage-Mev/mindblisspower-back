import { expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { SandboxWalletDatabase } from '../identity/sandbox-wallet';
import { createProductionWalletSession, normalizeProductionWalletRoutes, productionWalletCapabilities, productionWalletCheckoutUrl,
  quoteProductionWalletFunding, readProductionWalletDiscovery, readProductionWalletOptions, readProductionWalletHistory, readProductionWalletStatus } from './wallet-meld-production';
import { productionMeldJson, productionScope } from './wallet-meld-production-http';
import { syntheticCoverage as catalogue, coverageTestEnvironment } from './wallet-production-coverage-fixture';
import { walletWidgetDiagnostic } from './wallet-production-diagnostic';

const id = '6d492c47-80be-4e14-bc5f-54afaa56fc23', customer = '7d492c47-80be-4e14-bc5f-54afaa56fc23', wallet = `0x${'1'.repeat(40)}`;
const subject = 'synthetic-owner', nativeSessionId = 'synthetic-session', account = 'production-account', now = new Date();
const environment = coverageTestEnvironment({ WALLET_MELD_PRODUCTION_ENABLED: 'true', MELD_PRODUCTION_API_KEYS: 'synthetic-production-key', MELD_PRODUCTION_ACCOUNT_ID: account });
const input = { requestId: id, country: 'MX', sourceCurrencyCode: 'MXN', amount: 2000, paymentMethodType: 'CREDIT_DEBIT_CARD', serviceProvider: 'BANXA' };
const options = { subject, nativeSessionId, clientIp: '192.0.2.1', environment, catalogue };
const binding = { address: wallet, binding_reference: customer };
const row = { id, subject, address: wallet, country_code: 'MX', source_currency: 'MXN', requested_amount: 2000, service_provider: 'BANXA',
  destination_currency: 'USDT_POLYGON',
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
test('USDC ACH records the asset and opens only an opaque checkout with matching provider prefill', async () => {
  const bank = { ...input, country: 'US', sourceCurrencyCode: 'USD', amount: 100, serviceProvider: 'ONRAMPMONEY', paymentMethodType: 'ACH' };
  const bankCatalogue = { ...catalogue, rows: [{ ...catalogue.rows[0], country: 'US', sourceCurrencyCode: 'USD',
    serviceProvider: 'ONRAMPMONEY', paymentMethodType: 'ACH', minimumAmount: 50, verifiedAmount: 100, destinationCurrencyCode: 'USDC_POLYGON' }] };
  const rail = { partner: 'ONRAMPMONEY', source: 'USD', destination: 'USDC_POLYGON',
    paymentMethods: [{ name: 'ACH', limits: { currencyCode: 'USD', min: 25, max: 50000 } }] };
  const price = { quotes: [{ ...quote('ONRAMPMONEY').quotes[0], sourceCurrencyCode: 'USD',
    sourceAmount: 100, destinationCurrencyCode: 'USDC_POLYGON', paymentMethodType: 'ACH' }] };
  const prefill = new URLSearchParams({ coinCode: 'usdc', network: 'matic20', walletAddress: wallet, fiatAmount: '100.00',
    fiatType: '21', paymentMethod: '2', redirectUrl: `https://wallet.mindblisspower.com/dashboard/wallet-administrative?walletCheckoutReference=${id}` });
  for (const badPrefill of [false, true]) {
    const db = database([[binding], [{ id, address: wallet, customer_reference: customer, created: true, status: 'initiated', created_at: now }], [{ finished: true }]]);
    const scoped = new URLSearchParams(prefill);
    if (badPrefill) scoped.set('coinCode', 'usdt');
    const api = provider([[rail], price, { ...widget, serviceProviderWidgetUrl: `https://onramp.money/main/buy/?${scoped}` }]);
    const session = createProductionWalletSession(db.database, bank, { ...options, catalogue: bankCatalogue, fetchImpl: api.fetchImpl });
    if (badPrefill) {
      await expect(session).rejects.toThrow('provider_unavailable');
      expect(db.queries[2]!.params[3]).toBe('unavailable');
    } else {
      expect(await session).toMatchObject({ destinationCurrencyCode: 'USDC_POLYGON',
        destination: { asset: 'USDC', address: wallet, chainId: 137 }, checkoutUrl: widget.widgetUrl });
      expect(db.queries[1]!.params.at(-1)).toBe('USDC_POLYGON');
      expect(api.calls[2]!.body.sessionData.destinationCurrencyCode).toBe('USDC_POLYGON');
    }
  }
});
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
  expect(db.queries).toHaveLength(0); expect(api.calls).toHaveLength(0); // Policy rejects before the binding, route GET or any write.
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
  expect(db.queries[1]!.params).toEqual([subject, nativeSessionId, id, 'MX', 2000, 'MXN', 'CREDIT_DEBIT_CARD', 'BANXA', account, 'USDT_POLYGON']);
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
test('Meld opaque fallback canonicalizes the optional root slash without accepting another URL shape', () => {
  const canonical = 'https://meldcrypto.com/?token=synthetic.token';
  for (const value of [canonical, 'https://meldcrypto.com?token=synthetic.token'])
    expect(productionWalletCheckoutUrl(value, 'ONRAMPMONEY')).toBe(canonical);
  for (const value of ['https://meldcrypto.com:443?token=a', 'https://user@meldcrypto.com?token=a',
    'https://meldcrypto.com.evil.test?token=a', 'http://meldcrypto.com?token=a', 'https://meldcrypto.com/other?token=a',
    'https://meldcrypto.com?token=a&token=b', 'https://meldcrypto.com?token=a&redirect=https://evil.test',
    'https://meldcrypto.com?%74oken=a', 'https://meldcrypto.com?token=%61', 'https://meldcrypto.com?token=a#',
    'https://meldcrypto.com?token=a\n', 'https://onramp.money/main/buy/?walletAddress=editable'])
    expect(productionWalletCheckoutUrl(value, 'ONRAMPMONEY')).toBeNull();
});

test('Onramp Money checkout uses the canonical Meld token fallback with immutable MXN SPEI facts', async () => {
  const raw = { ...input, serviceProvider: 'ONRAMPMONEY', paymentMethodType: 'SPEI' };
  const db = database([[binding], [{ id, address: wallet, customer_reference: customer, created: true, status: 'initiated', created_at: now }], [{ finished: true }]]);
  const api = provider([routes(['ONRAMPMONEY'], 'MXN', 'SPEI'),
    { quotes: [{ ...quote('ONRAMPMONEY').quotes[0], paymentMethodType: 'SPEI' }] },
    { ...widget, serviceProviderWidgetUrl: 'https://onramp.money/main/buy/?walletAddress=editable', widgetUrl: 'https://meldcrypto.com?token=synthetic.token' }]);
  const result = await createProductionWalletSession(db.database, raw, { ...options, fetchImpl: api.fetchImpl });
  expect(result).toMatchObject({ checkoutUrl: 'https://meldcrypto.com/?token=synthetic.token', serviceProvider: 'ONRAMPMONEY',
    status: 'session_created', sourceCurrencyCode: 'MXN', requestedAmount: 2000, paymentMethodType: 'SPEI', destination: { address: wallet, chainId: 137 } });
  expect(api.calls).toHaveLength(3);
  expect(api.calls[2]!.body.sessionData).toMatchObject({ walletAddress: wallet, sourceCurrencyCode: 'MXN', sourceAmount: '2000.00', paymentMethodType: 'SPEI' });
  expect(db.queries[2]!.params).toEqual([subject, nativeSessionId, id, 'session_created', 'vendor-session', 'vendor-customer']);
});

test('integer fiat uses its verified minor units in the widget payload without changing canonical ledger amount facts', async () => {
  const raw = { ...input, country: 'JP', sourceCurrencyCode: 'JPY', paymentMethodType: 'LOCAL_BANK_TRANSFER' };
  const db = database([[binding], [{ id, address: wallet, customer_reference: customer, created: true, status: 'initiated', created_at: now }], [{ finished: true }]]);
  const api = provider([routes(['BANXA'], 'JPY', 'LOCAL_BANK_TRANSFER'),
    { quotes: [{ ...quote().quotes[0], sourceCurrencyCode: 'JPY', paymentMethodType: 'LOCAL_BANK_TRANSFER' }] }, widget]);
  expect((await createProductionWalletSession(db.database, raw, { ...options, fetchImpl: api.fetchImpl })).sourceCurrencyCode).toBe('JPY');
  expect(api.calls[2]!.body.sessionData.sourceAmount).toBe('2000');
  expect(db.queries[1]!.params).toEqual([subject, nativeSessionId, id, 'JP', 2000, 'JPY', 'LOCAL_BANK_TRANSFER', 'BANXA', account, 'USDT_POLYGON']);
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
test('widget failures identify transport, HTTP, schema and URL stages without retaining vendor private data', async () => {
  const cases = [
    { response: new Response('<html>private</html>', { status: 403, headers: { 'content-type': 'text/html' } }), stage: 'widget_transport', status: 403 },
    { response: Response.json({ code: 'INVALID_CLIENT_IP', serviceProviderDetails: { code: 'PROVIDER_REJECTED', message: wallet }, requestId: customer }, { status: 400 }), stage: 'widget_http', status: 400 },
    { response: { ...widget, externalCustomerId: id }, stage: 'widget_schema', status: 200 },
    { response: { ...widget, widgetUrl: 'https://private.invalid/?token=secret' }, stage: 'widget_url', status: 200 },
  ] as const;
  for (const item of cases) {
    const db = database([[binding], [{ id, address: wallet, customer_reference: customer, created: true, status: 'initiated', created_at: now }], [{ finished: true }]]),
      api = provider([routes(), quote(), item.response]);
    let failure: unknown; try { await createProductionWalletSession(db.database, input, { ...options, fetchImpl: api.fetchImpl }); } catch (error) { failure = error; }
    expect((failure as Error).message).toBe('wallet_production_provider_unavailable');
    expect(walletWidgetDiagnostic(failure)).toMatchObject({ stage: item.stage, upstreamStatus: item.status });
    expect(JSON.stringify(walletWidgetDiagnostic(failure))).not.toMatch(/private|https:|0x|requestId|customer|wallet/i);
  }
});
test('failed cleanup preserves the original diagnostic; primary finish authorization errors keep their original mapping', async () => {
  for (const primaryFinish of [false, true]) {
    const db = database([[binding], [{ id, address: wallet, customer_reference: customer, created: true, status: 'initiated', created_at: now }]]), execute = db.database.execute;
    db.database.execute = (async (query: SQL) => {
      if (new PgDialect().sqlToQuery(query).sql.includes('finish_wallet_meld_production_attempt')) throw Error('administrative_signing_forbidden'); return execute(query);
    }) as unknown as typeof execute;
    const api = provider([routes(), quote(), primaryFinish ? widget : Response.json({ code: 'PROVIDER_ERROR' }, { status: 400 })]);
    let failure: unknown; try { await createProductionWalletSession(db.database, input, { ...options, fetchImpl: api.fetchImpl }); } catch (error) { failure = error; }
    expect((failure as Error).message).toBe(primaryFinish ? 'administrative_signing_forbidden' : 'wallet_production_provider_unavailable');
    expect(walletWidgetDiagnostic(failure)).toMatchObject({ stage: primaryFinish ? 'widget_finish' : 'widget_http', upstreamStatus: primaryFinish ? 200 : 400 });
  }
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
  expect(await readProductionWalletDiscovery(undefined, { environment, fetchImpl: api.fetchImpl, catalogue })).toEqual({ countries: [{ code: 'CO', name: 'Colombia' }, { code: 'ES', name: 'Spain' }] });
  expect(await readProductionWalletDiscovery('CO', { environment, fetchImpl: api.fetchImpl, catalogue })).toEqual({ country: 'CO', currencies: [{ code: 'COP', name: 'Colombian Peso', decimalPlaces: 2 }], defaultCurrencyCode: 'COP' });
  expect(api.calls.every(call => call.headers.get('meld-account-id') === account)).toBe(true);
});

test('discovery removes unverified countries and fiats instead of presenting every generic MELD entry', async () => {
  const api = provider([{ countries: [{ countryCode: 'CR', name: 'Costa Rica' }, { countryCode: 'MX', name: 'Mexico' },
    { countryCode: 'CO', name: 'Colombia' }, { countryCode: 'US', name: 'United States' }] },
  { currencies: ['MXN', 'USD', 'COP'].map(currencyCode => ({ currencyCode, name: currencyCode, type: 'FIAT', decimalPlaces: 2 })) },
  { currencyCode: 'USD' }]);
  const deps = { environment, fetchImpl: api.fetchImpl, catalogue };
  expect((await readProductionWalletDiscovery(undefined, deps)).countries).toEqual([{ code: 'MX', name: 'Mexico' }, { code: 'CO', name: 'Colombia' }]);
  expect(await readProductionWalletDiscovery('MX', deps)).toEqual({ country: 'MX', currencies: [{ code: 'MXN', name: 'MXN', decimalPlaces: 2 }], defaultCurrencyCode: 'MXN' });
  expect(await readProductionWalletDiscovery('CR', deps)).toEqual({ country: 'CR', currencies: [], defaultCurrencyCode: null });
  expect((await readProductionWalletOptions({ country: 'CR', sourceCurrencyCode: 'USD' }, deps)).routes).toEqual([]);
  expect(api.calls).toHaveLength(3); // Rejected pairs perform no extra upstream discovery.
});

test('live routes cannot enable a new method or expand the audited provider-specific range', async () => {
  const restricted = { ...catalogue, rows: catalogue.rows.map(item => item.country === 'MX' && item.paymentMethodType === 'SPEI'
    ? { ...item, minimumAmount: 200, maximumAmount: 1000, verifiedAmount: 200 } : item) };
  const raw = [...routes(['ONRAMPMONEY'], 'MXN', 'SPEI'), ...routes(['BANXA'], 'MXN', 'APPLE_PAY')];
  raw[0]!.paymentMethods[0]!.limits = { currencyCode: 'MXN', min: 100, max: 5000 };
  const api = provider([raw]);
  expect(await readProductionWalletOptions({ country: 'MX', sourceCurrencyCode: 'MXN' }, { environment, fetchImpl: api.fetchImpl, catalogue: restricted }))
    .toMatchObject({ paymentMethods: ['SPEI'], routes: [{ serviceProvider: 'ONRAMPMONEY', paymentMethods: [{ method: 'SPEI', minimumAmount: 200, maximumAmount: 1000 }] }] });
});

test('unsupported country/fiat/method and fractional zero-decimal amounts stop before owner reads, quotes or journal writes', async () => {
  for (const patch of [{ country: 'CR', sourceCurrencyCode: 'USD', amount: 50 }, { sourceCurrencyCode: 'USD', amount: 50 },
    { country: 'JP', sourceCurrencyCode: 'JPY', paymentMethodType: 'LOCAL_BANK_TRANSFER', amount: 2000.5 }]) {
    const raw = { ...input, ...patch }, db = database([]), api = provider([]), { requestId, serviceProvider, ...quoteInput } = raw;
    await expect(quoteProductionWalletFunding(db.database, quoteInput, { ...options, fetchImpl: api.fetchImpl })).rejects.toThrow(/(?:method|amount)_unavailable/);
    await expect(createProductionWalletSession(db.database, raw, { ...options, fetchImpl: api.fetchImpl })).rejects.toThrow(/(?:method|amount)_unavailable/);
    expect(db.queries).toHaveLength(0); expect(api.calls).toHaveLength(0);
  }
});

test('missing catalogue attestation blocks new preparations while owned historical status remains readable', async () => {
  const unverified = { ...environment, MELD_PRODUCTION_CATALOGUE_ATTESTATION: undefined }, db = database([]), api = provider([]);
  await expect(createProductionWalletSession(db.database, input, { ...options, environment: unverified, fetchImpl: api.fetchImpl })).rejects.toThrow('unconfigured');
  expect(db.queries).toHaveLength(0); expect(api.calls).toHaveLength(0);
  const historyDb = database([[row]]);
  expect((await readProductionWalletHistory(historyDb.database, { subject, nativeSessionId }, { environment: unverified, fetchImpl: api.fetchImpl })).records).toHaveLength(1);
});
test('hung body/transport obey bounded abort even if the vendor ignores cancellation', async () => {
  const scope = productionScope(undefined, 5), fetchImpl = (async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  try { await expect(productionMeldJson('/payments/transactions/tx-valid', { key: 'synthetic-key', account, fetchImpl, signal: scope.signal })).rejects.toThrow('unavailable'); }
  finally { scope.close(); }
});
