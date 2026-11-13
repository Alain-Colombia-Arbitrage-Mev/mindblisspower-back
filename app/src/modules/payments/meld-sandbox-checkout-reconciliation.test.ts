import { createHmac } from 'node:crypto';
import { expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { handleSandboxMeldWebhook } from './meld-sandbox-webhook';
import { readMeldCheckoutStatus, readMeldCheckoutHistory, handleVerifiedMeldCheckoutWebhook } from './meld-sandbox-checkout-reconciliation';
import type { SandboxDatabase } from './meld-sandbox-reconciliation';
import { sandboxId, sandboxCustomer, sandboxAddress, sandboxTransaction, sandboxEnvironment, sandboxNow } from './meld-sandbox-fixtures';
const environment = { ...sandboxEnvironment, MELD_CHECKOUT_ENABLED: 'true', MELD_WIDGET_PUBLIC_KEY: 'synthetic-public-profile' };
const row = { id: sandboxId, subject: 'synthetic-owner', account_id: 'sandbox-account', customer_reference: sandboxCustomer,
  wallet_address: sandboxAddress, country_code: 'MX', requested_amount: 650, source_currency: 'MXN', status: 'minted',
  provider_session_id: null, transaction_id: null, proof: null, checked_at: null, created_at: new Date(sandboxNow) };
const own = { subject: row.subject, checkoutReference: sandboxId };
function database({ result = row as unknown, history = [] as unknown[] } = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  let receipt = false;
  return { queries, db: { execute: async (query: SQL) => {
    const value = new PgDialect().sqlToQuery(query); queries.push(value);
    if (value.sql.includes('read_meld_sandbox_webhook_context')) return [];
    if (value.sql.includes('record_meld_checkout_proof')) return [{ proof: JSON.parse(String(value.params[2])) }];
    if (value.sql.includes('record_meld_checkout_webhook_receipt')) { const inserted = !receipt; receipt = true; return [{ inserted }]; }
    if (value.sql.includes('read_meld_checkout_history')) return history;
    if (value.sql.includes('read_meld_checkout_')) return result ? [result] : [];
    throw Error('unexpected synthetic query');
  } } as unknown as SandboxDatabase };
}
const get = (transaction = sandboxTransaction) => (async (target: string | Request | URL) => new URL(String(target)).search
  ? Response.json({ transactions: [{ id: transaction.id }] }) : Response.json({ transaction })) as unknown as typeof fetch;

test('new generic paths fail before all financial DB and upstream access until distinct public profile and feature are configured', async () => {
  for (const bad of [{ ...environment, MELD_CHECKOUT_ENABLED: 'false' }, { ...environment, MELD_WIDGET_PUBLIC_KEY: undefined },
    { ...environment, MELD_WIDGET_PUBLIC_KEY: environment.MELD_API_SANDBOX }, { ...environment, MELD_API_SANDBOX: '' },
    { ...environment, MELD_ADMIN_SANDBOX_ENABLED: 'false' }, { ...environment, MELD_ACCOUNT_ID: '.' }]) {
    const d = database();
    await expect(readMeldCheckoutStatus(d.db, own, { environment: bad, fetchImpl: get() })).rejects.toThrow('wallet_funding_unconfigured');
    await expect(readMeldCheckoutHistory(d.db, own.subject, { environment: bad })).rejects.toThrow('wallet_funding_unconfigured');
    expect(d.queries).toHaveLength(0);
  }
});
test('generic BUY learns actual provider, method and session only from one independent owned API transaction', async () => {
  for (const serviceProvider of ['BANXA', 'TRANSAK'] as const) {
    const d = database(); const calls: string[] = [];
    const tx = { ...sandboxTransaction, serviceProvider };
    const result = await readMeldCheckoutStatus(d.db, own, { environment, now: () => sandboxNow,
      fetchImpl: (async (target: string | Request | URL, init?: RequestInit) => { const url = new URL(String(target)); calls.push(url.href);
        expect(url.origin).toBe('https://api-sb.meld.io'); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error');
        if (url.search) { expect(Object.fromEntries(url.searchParams)).toEqual({ externalSessionIds: sandboxId, externalCustomerIds: sandboxCustomer,
          serviceProviders: 'BANXA,TRANSAK', types: 'CRYPTO_PURCHASE', limit: '2' }); return Response.json({ transactions: [{ id: tx.id }] }); }
        return Response.json({ transaction: tx }); }) as unknown as typeof fetch });
    expect(result.confirmation).toEqual({ state: 'confirmed', source: 'meld_sandbox_api', testMode: true, receivedAmount: '31.123456',
      confirmedAt: tx.updatedAt, transactionId: tx.id, providerStatus: 'SETTLED', serviceProvider, paymentMethodType: 'CREDIT_DEBIT_CARD' });
    expect(result.checkoutType).toBe('meld_checkout'); expect(result.requestStatus).toBe('minted'); expect(calls).toHaveLength(2);
    expect(d.queries).toHaveLength(2); expect(JSON.stringify(d.queries)).not.toMatch(/private|commission|wallet_movement|capture_meld_webhook_event/);
    expect(Object.keys(result)).not.toContain('account_id'); expect(Object.keys(result)).not.toContain('provider_session_id');
  }
});
test('an opened checkout with no transaction invents no provider, method, session or settlement', async () => {
  const d = database();
  const result = await readMeldCheckoutStatus(d.db, own, { environment,
    fetchImpl: (async () => Response.json({ transactions: [] })) as unknown as typeof fetch });
  expect(result.confirmation).toEqual({ state: 'unconfirmed', source: 'none', testMode: true });
  expect(d.queries).toHaveLength(1); expect(JSON.stringify(result)).not.toMatch(/BANXA|TRANSAK|sessionId|serviceProvider/);
});
test('owner, immutable references, address, chain, amount and provider are validated before binding unknown session', async () => {
  for (const result of [null, { ...row, subject: 'other-owner' }]) {
    const d = database({ result }); let calls = 0;
    await expect(readMeldCheckoutStatus(d.db, own, { environment, fetchImpl: (async () => { calls++; throw Error(); }) as unknown as typeof fetch })).rejects.toThrow();
    expect(calls).toBe(0);
  }
  for (const change of [{ accountId: 'other-account' }, { externalSessionId: sandboxCustomer }, { externalCustomerId: sandboxId },
    { countryCode: 'CO' }, { sourceCurrencyCode: 'USD' }, { sourceAmount: 649 }, { destinationCurrencyCode: 'USDT' },
    { cryptoDetails: { ...sandboxTransaction.cryptoDetails, chainId: '1' } }, { serviceProvider: 'BINANCECONNECT' },
    { cryptoDetails: { ...sandboxTransaction.cryptoDetails, destinationWalletAddress: `0x${'3'.repeat(40)}` } }, { sessionId: '..' }]) {
    const d = database();
    await expect(readMeldCheckoutStatus(d.db, own, { environment, fetchImpl: get({ ...sandboxTransaction, ...change } as typeof sandboxTransaction) })).rejects.toThrow();
    expect(d.queries).toHaveLength(1);
  }
});
test('history is one cached owner query without API calls and cannot leak a foreign record', async () => {
  const d = database(); const status = await readMeldCheckoutStatus(d.db, own, { environment, fetchImpl: get() });
  const proof = JSON.parse(String(d.queries[1]!.params[2]));
  const h = database({ history: [{ ...row, proof, provider_session_id: proof.sessionId, transaction_id: proof.transactionId }] });
  const result = await readMeldCheckoutHistory(h.db, own.subject, { environment });
  expect(h.queries).toHaveLength(1); expect(result.settlement).toBe('unconfirmed');
  expect(result.records[0]?.confirmation).toEqual(status.confirmation);
  const foreign = database({ history: [{ ...row, subject: 'other-owner' }] });
  await expect(readMeldCheckoutHistory(foreign.db, own.subject, { environment })).rejects.toThrow('wallet_funding_forbidden');
});
test('discovery ambiguity, path traversal, malformed data and timeout never bind a provider session', async () => {
  for (const data of [{ transactions: [{ id: 'one' }, { id: 'two' }] }, { transactions: [{ id: '.' }] },
    { transactions: [{ id: '..' }] }, { transactions: [{ id: 'one' }], remaining: 1 }]) {
    const d = database(); let calls = 0;
    await expect(readMeldCheckoutStatus(d.db, own, { environment, fetchImpl: (async () => { calls++; return Response.json(data); }) as unknown as typeof fetch })).rejects.toThrow();
    expect(calls).toBe(1); expect(d.queries).toHaveLength(1);
  }
  const d = database();
  await expect(readMeldCheckoutStatus(d.db, own, { environment, timeoutMs: 5,
    fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch })).rejects.toThrow('wallet_funding_provider_unavailable');
  expect(d.queries).toHaveLength(1);
  const never = database();
  const faulty = { ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({ read: () => new Promise(() => {}),
    cancel: () => new Promise(() => {}), releaseLock() {} }) } } as unknown as Response;
  await expect(readMeldCheckoutStatus(never.db, own, { environment, timeoutMs: 5,
    fetchImpl: (async () => faulty) as unknown as typeof fetch })).rejects.toThrow('wallet_funding_provider_unavailable');
  expect(never.queries).toHaveLength(1);
});
test('generic signed webhook fallback is gated, learns no session from the callback alone, and reads the transaction', async () => {
  const timestamp = new Date(sandboxNow).toISOString();
  const body = JSON.stringify({ eventId: 'generic-event', eventType: 'TRANSACTION_CRYPTO_COMPLETE', timestamp,
    accountId: environment.MELD_ACCOUNT_ID, profileId: environment.MELD_WEBHOOK_PROFILE_ID, version: '2026-02-03',
    payload: { externalSessionId: sandboxId, externalCustomerId: sandboxCustomer, sessionId: 'sandbox-session',
      paymentTransactionId: 'sandbox-transaction', transactionType: 'CRYPTO_PURCHASE' } });
  const headers = { signatureTimestamp: timestamp, signature: createHmac('sha256', environment.MELD_WEBHOOK_SIGNING_KEY)
    .update(`${timestamp}.${environment.MELD_WEBHOOK_PUBLIC_URL}.${body}`).digest('base64url') + '=' };
  const disabled = database();
  expect((await handleSandboxMeldWebhook(disabled.db, body, headers, { environment: { ...environment, MELD_CHECKOUT_ENABLED: 'false' }, now: () => sandboxNow })).ignored).toBe(true);
  expect(disabled.queries).toHaveLength(1); expect(disabled.queries[0]?.sql).toContain('read_meld_sandbox_webhook_context');
  const d = database();
  expect((await handleSandboxMeldWebhook(d.db, body, headers, { environment, now: () => sandboxNow, fetchImpl: get() })).received).toBe(true);
  expect(d.queries.map(q => q.sql)).toEqual([expect.stringContaining('read_meld_sandbox_webhook_context'), expect.stringContaining('read_meld_checkout_webhook_context'),
    expect.stringContaining('record_meld_checkout_webhook_receipt'), expect.stringContaining('record_meld_checkout_proof')]);
  const direct = database();
  await expect(handleVerifiedMeldCheckoutWebhook(direct.db, { eventId: 'fake', eventType: 'TRANSACTION_CRYPTO_COMPLETE', timestamp,
    accountId: 'foreign', profileId: null, bodySha256: 'a'.repeat(64), payload: {} }, { environment })).resolves.toEqual({ received: true, ignored: true, mode: 'sandbox_only' });
  expect(direct.queries).toHaveLength(0);
});
