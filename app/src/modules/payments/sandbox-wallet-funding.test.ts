import { expect, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SandboxWalletDatabase } from '../identity/sandbox-wallet';
import { createSandboxWalletFundingSession, readSandboxWalletFundingHistory, readSandboxWalletFundingStatus } from './sandbox-wallet-funding';

const id = '6d492c47-80be-4e14-bc5f-54afaa56fc23', customer = '7d492c47-80be-4e14-bc5f-54afaa56fc23', address = `0x${'1'.repeat(40)}`;
const subject = 'synthetic-owner', nativeSessionId = 'synthetic-session', account = 'synthetic-account', now = new Date();
const environment = { WALLET_SANDBOX_REOWN_ENABLED: 'true', MELD_ADMIN_SANDBOX_ENABLED: 'true', MELD_API_SANDBOX: 'synthetic-sandbox-key', MELD_ACCOUNT_ID: account };
const input = { requestId: id, country: 'US', sourceCurrencyCode: 'USD', amount: 50, paymentMethodType: 'CREDIT_DEBIT_CARD' };
const binding = { address, verified: true, binding_reference: customer, verified_at: now, expires_at: new Date(now.getTime() + 3600000) };
const row = { id, subject, address, customer_reference: customer, account_id: account, country_code: 'US', source_currency: 'USD', requested_amount: 50,
  service_provider: 'TRANSAK', payment_method: 'CREDIT_DEBIT_CARD', status: 'session_created', provider_session_id: 'synthetic-provider-session',
  provider_customer_id: 'synthetic-provider-customer', created_at: now, updated_at: now, proof: null, checked_at: null };
const routes = [{ partner: 'TRANSAK', source: 'USD', destination: 'USDT_POLYGON', paymentMethods: [
  { name: 'CREDIT_DEBIT_CARD', paymentType: 'CARD', limits: { currencyCode: 'USD', min: 20, max: 25000 } }] }];
const quote = { quotes: [{ serviceProvider: 'TRANSAK', sourceCurrencyCode: 'USD', destinationCurrencyCode: 'USDT_POLYGON',
  sourceAmount: 50, destinationAmount: 46.5, paymentMethodType: 'CREDIT_DEBIT_CARD' }] };
const widget = { id: row.provider_session_id, customerId: row.provider_customer_id, externalSessionId: id, externalCustomerId: customer,
  serviceProviderWidgetUrl: 'https://global-stg.transak.com/?apiKey=synthetic-key&sessionId=synthetic-session', widgetUrl: 'https://sb.meldcrypto.com/?token=synthetic.token' };
function database(outputs: unknown[][]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  return { queries, database: { execute: async (query: SQL) => { queries.push(new PgDialect().sqlToQuery(query)); const value = outputs.shift();
    if (!value) throw Error('unexpected DB query'); return value; } } as unknown as SandboxWalletDatabase };
}
function provider(outputs: unknown[]) {
  const calls: { url: string; method: string; body: any }[] = [];
  const fetchImpl = (async (target: string | Request | URL, init?: RequestInit) => { calls.push({ url: String(target), method: init?.method || 'GET',
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : null }); const value = outputs.shift();
    if (value === undefined) throw Error('unexpected provider call'); return value instanceof Response ? value : Response.json(value); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const options = { subject, nativeSessionId, clientIp: '192.0.2.1', environment };
test('new connected-wallet BUY locks verified server destination, sandbox, source units and Transak; never touches pool or production ledgers', async () => {
  const db = database([[binding], [{ id, address, customer_reference: customer, created: true, status: 'initiated', created_at: now }], [{ finished: true }]]);
  const api = provider([routes, quote, widget]);
  const result = await createSandboxWalletFundingSession(db.database, input, { ...options, fetchImpl: api.fetchImpl });
  expect(result).toMatchObject({ checkoutReference: id, serviceProvider: 'TRANSAK', destination: { address, asset: 'USDT', chainId: 137 }, status: 'session_created' });
  expect(result.checkoutUrl).toBe(widget.serviceProviderWidgetUrl);
  expect(api.calls).toHaveLength(3); expect(api.calls.every(call => call.url.startsWith('https://api-sb.meld.io/'))).toBe(true);
  expect(api.calls[1]!.body.walletAddress).toBe(address); expect(api.calls[1]!.body.sourceAmount).toBe(50);
  const sent = api.calls[2]!.body; expect(sent.sessionData.sourceAmount).toBe('50.00'); expect(sent.sessionData.walletAddress).toBe(address);
  expect(sent.sessionData.lockFields).toEqual(['walletAddress', 'destinationCurrencyCode', 'sourceCurrencyCode', 'sourceAmount', 'paymentMethodType']);
  expect(sent.externalSessionId).toBe(id); expect(sent.externalCustomerId).toBe(customer); expect(sent.sessionData.redirectUrl).toEndWith(`?sandboxCheckoutReference=${id}`);
  expect(db.queries[1]!.params).toEqual([subject, nativeSessionId, id, 'US', 50, 'USD', 'CREDIT_DEBIT_CARD', account]);
  expect(JSON.stringify(db.queries)).not.toMatch(/administrative_wallet_assignment|auth\.user_wallet|commission|reown_funding|record_meld_sandbox_proof/);
});
test('unverified session, client address/provider injection, flagoff and unsupported local fiat stop before upstream/writes', async () => {
  const api = provider([]);
  const unverified = database([[{ ...binding, verified: false, expires_at: null }]]);
  await expect(createSandboxWalletFundingSession(unverified.database, input, { ...options, fetchImpl: api.fetchImpl })).rejects.toThrow('verification_required');
  for (const raw of [{ ...input, walletAddress: address }, { ...input, serviceProvider: 'BANXA' }, { ...input, sourceCurrencyCode: 'COP' },
    { ...input, country: 'CO', sourceCurrencyCode: 'MXN' }, { ...input, amount: 49.99 }]) {
    const db = database([]); await expect(createSandboxWalletFundingSession(db.database, raw, { ...options, fetchImpl: api.fetchImpl })).rejects.toThrow(); expect(db.queries).toHaveLength(0);
  }
  const db = database([]); await expect(createSandboxWalletFundingSession(db.database, input, { ...options, environment: {}, fetchImpl: api.fetchImpl })).rejects.toThrow('unconfigured');
  expect(api.calls).toHaveLength(0); expect(db.queries).toHaveLength(0);
});
test('invalid quote echoes or malformed HTTP200 produce no request row or widget and no automatic retry', async () => {
  for (const response of [Response.json({ error: 'unauthorized' }, { status: 401 }), new Response('{', { headers: { 'content-type': 'application/json' } }),
    { quotes: [] }, { quotes: [quote.quotes[0], quote.quotes[0]] }, { quotes: [{ ...quote.quotes[0], sourceAmount: 100 }] },
    { quotes: [{ ...quote.quotes[0], serviceProvider: 'BANXA' }] }, { quotes: [{ ...quote.quotes[0], walletAddress: `0x${'2'.repeat(40)}` }] }]) {
    const db = database([[binding]]), api = provider([routes, response]);
    await expect(createSandboxWalletFundingSession(db.database, input, { ...options, fetchImpl: api.fetchImpl })).rejects.toThrow();
    expect(db.queries).toHaveLength(1); expect(api.calls).toHaveLength(2);
  }
});
test('crossed provider session references or production checkout URLs cannot finish an openable request', async () => {
  for (const changed of [{ ...widget, externalSessionId: customer }, { ...widget, externalCustomerId: id },
    { ...widget, serviceProviderWidgetUrl: 'https://global.transak.com/?apiKey=a&sessionId=b', widgetUrl: 'https://meldcrypto.com/?token=test' }]) {
    const db = database([[binding], [{ id, address, customer_reference: customer, created: true, status: 'initiated', created_at: now }], [{ finished: true }]]), api = provider([routes, quote, changed]);
    await expect(createSandboxWalletFundingSession(db.database, input, { ...options, fetchImpl: api.fetchImpl })).rejects.toThrow();
    expect(db.queries[2]!.params).toEqual([subject, nativeSessionId, id, 'unavailable', null, null]); expect(api.calls).toHaveLength(3);
  }
});
function transaction(change: Record<string, unknown> = {}) {
  return { transaction: { id: 'synthetic-transaction', accountId: account, sessionId: row.provider_session_id, customerId: row.provider_customer_id,
    externalSessionId: id, externalCustomerId: customer, serviceProvider: 'TRANSAK', transactionType: 'CRYPTO_PURCHASE', countryCode: 'US',
    sourceCurrencyCode: 'USD', sourceAmount: 50, destinationCurrencyCode: 'USDT_POLYGON', destinationAmount: 46.5,
    paymentMethodType: 'CREDIT_DEBIT_CARD', status: 'SETTLED', updatedAt: now.toISOString(),
    cryptoDetails: { destinationWalletAddress: address, chainId: '137' }, ...change } };
}
test('manual owner status independently searches then fetches exact transaction; confirmed test evidence uses new journal only', async () => {
  const db = database([[row]]), api = provider([{ transactions: [{ id: 'synthetic-transaction' }] }, transaction()]);
  const execute = db.database.execute;
  db.database.execute = (async (query: SQL) => {
    const parsed = new PgDialect().sqlToQuery(query);
    if (parsed.sql.includes('record_connected_wallet_sandbox_proof')) { db.queries.push(parsed); return [{ proof: JSON.parse(parsed.params[2] as string) }]; }
    return execute(query);
  }) as typeof db.database.execute;
  const result = await readSandboxWalletFundingStatus(db.database, { subject, nativeSessionId, checkoutReference: id }, { environment, fetchImpl: api.fetchImpl });
  expect(result.confirmation).toMatchObject({ state: 'confirmed', source: 'meld_sandbox_api', testMode: true, transactionId: 'synthetic-transaction', receivedAmount: '46.5' });
  expect(api.calls.map(call => call.method)).toEqual(['GET', 'GET']); expect(db.queries[1]!.sql).toContain('record_connected_wallet_sandbox_proof');
  expect(JSON.stringify(db.queries)).not.toContain('record_meld_sandbox_proof(');
});
test('proof rejects account, address, chain, customer, source amount or provider mismatches before any proof write', async () => {
  for (const change of [{ accountId: 'foreign' }, { customerId: 'foreign' }, { sourceAmount: 51 }, { serviceProvider: 'BANXA' },
    { cryptoDetails: { destinationWalletAddress: `0x${'2'.repeat(40)}`, chainId: '137' } }, { cryptoDetails: { destinationWalletAddress: address, chainId: '1' } }]) {
    const db = database([[row]]), api = provider([{ transactions: [{ id: 'synthetic-transaction' }] }, transaction(change)]);
    await expect(readSandboxWalletFundingStatus(db.database, { subject, nativeSessionId, checkoutReference: id }, { environment, fetchImpl: api.fetchImpl })).rejects.toThrow('provider_unavailable');
    expect(db.queries).toHaveLength(1);
  }
});
test('history reads owned immutable request destinations without any provider requests; foreign rows fail closed', async () => {
  const db = database([[row]]), api = provider([]);
  expect(await readSandboxWalletFundingHistory(db.database, { subject, nativeSessionId }, { environment, fetchImpl: api.fetchImpl })).toMatchObject({
    environment: 'sandbox', settlement: 'unconfirmed', records: [{ checkoutReference: id, destination: { address } }] });
  expect(api.calls).toHaveLength(0);
  const denied = database([[{ ...row, subject: 'foreign' }]]);
  await expect(readSandboxWalletFundingHistory(denied.database, { subject, nativeSessionId }, { environment })).rejects.toThrow('unavailable');
});
test('manual pending-created alias is exact and never presented as settled; unknown statuses remain unavailable', async () => {
  for (const status of ['PENDING CREATED', 'PENDING_CREATED', 'SETTLED_AND_TRUST_ME']) {
    const db = database([[row]]), api = provider([{ transactions: [{ id: 'synthetic-transaction' }] }, transaction({ status, destinationAmount: 0 })]);
    const execute = db.database.execute;
    db.database.execute = (async (query: SQL) => { const parsed = new PgDialect().sqlToQuery(query);
      if (parsed.sql.includes('record_connected_wallet_sandbox_proof')) { db.queries.push(parsed); return [{ proof: JSON.parse(parsed.params[2] as string) }]; }
      return execute(query); }) as typeof db.database.execute;
    const operation = readSandboxWalletFundingStatus(db.database, { subject, nativeSessionId, checkoutReference: id }, { environment, fetchImpl: api.fetchImpl });
    if (status === 'SETTLED_AND_TRUST_ME') await expect(operation).rejects.toThrow('provider_unavailable');
    else expect((await operation).confirmation).toMatchObject({ state: 'pending', providerStatus: 'PENDING_CREATED', testMode: true });
  }
});
test('quota and inflight gates block duplicate checkout preparations before further DB or upstream calls', async () => {
  let release: (() => void) | undefined, dbCalls = 0, apiCalls = 0;
  const firstRead = new Promise<void>(resolve => { release = resolve; });
  const database = { execute: async () => { dbCalls++; await firstRead; return [{ ...binding, verified: false, expires_at: null }]; } } as unknown as SandboxWalletDatabase;
  const fetchImpl = (async () => { apiCalls++; throw Error('must not call'); }) as unknown as typeof fetch;
  const first = createSandboxWalletFundingSession(database, input, { ...options, fetchImpl });
  await Promise.resolve();
  await expect(createSandboxWalletFundingSession(database, input, { ...options, fetchImpl })).rejects.toThrow('request_pending');
  release!(); await expect(first).rejects.toThrow('verification_required');
  await expect(createSandboxWalletFundingSession(database, input, { ...options, fetchImpl })).rejects.toThrow('request_already_used');
  expect(dbCalls).toBe(1); expect(apiCalls).toBe(0);
});
test('MXN uses exact provider minimum and numeric quote units; never relabels local currency as USD', async () => {
  const mxInput = { ...input, country: 'MX', sourceCurrencyCode: 'MXN', amount: 187 }, db = database([[binding],
    [{ id, address, customer_reference: customer, created: true, status: 'initiated', created_at: now }], [{ finished: true }]]);
  const mxRoutes = [{ ...routes[0], source: 'MXN', paymentMethods: [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'MXN', min: 187, max: 466480 } }] }];
  const api = provider([mxRoutes, { quotes: [{ ...quote.quotes[0], sourceCurrencyCode: 'MXN', sourceAmount: 187 }] }, widget]);
  const result = await createSandboxWalletFundingSession(db.database, mxInput, { ...options, fetchImpl: api.fetchImpl });
  expect(result.sourceCurrencyCode).toBe('MXN'); expect(result.requestedAmount).toBe(187);
  expect(api.calls[1]!.body.sourceCurrencyCode).toBe('MXN'); expect(api.calls[1]!.body.sourceAmount).toBe(187);
  expect(api.calls[2]!.body.sessionData.sourceAmount).toBe('187.00');
  const below = database([[binding]]), unavailable = provider([mxRoutes]);
  await expect(createSandboxWalletFundingSession(below.database, { ...mxInput, amount: 186.99 }, { ...options, fetchImpl: unavailable.fetchImpl })).rejects.toThrow('amount_unavailable');
  expect(below.queries).toHaveLength(1); expect(unavailable.calls).toHaveLength(1);
});
