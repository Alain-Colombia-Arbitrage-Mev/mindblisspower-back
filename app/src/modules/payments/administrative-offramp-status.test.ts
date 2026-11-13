import { createHmac } from 'node:crypto';
import { expect, test } from 'bun:test';
import { administrativeOfframpProof, handleVerifiedAdministrativeOfframpWebhook, readAdministrativeOfframpHistory, readAdministrativeOfframpStatus } from './administrative-offramp-status';
import { handleSandboxMeldWebhook } from './meld-sandbox-webhook';
import { offAddress, offContext, offCustomer, offDatabase, offDeposit, offEnvironment, offId, offNow, offTransaction } from './administrative-offramp-fixtures';
const input = { subject: 'synthetic-owner', nativeSessionId: 'synthetic-native-session', reference: offId };
const context = offContext as Parameters<typeof administrativeOfframpProof>[1];
const proof = () => administrativeOfframpProof({ transaction: offTransaction }, context, 'synthetic-transaction');

test('owned SELL status independently reads the exact transaction before recording a sandbox-only proof with no payout or deposit execution', async () => {
  const db = offDatabase([[offContext]]), calls: string[] = [];
  const result = await readAdministrativeOfframpStatus(db.database, input, { environment: offEnvironment,
    fetchImpl: (async (target: string | Request | URL, init?: RequestInit) => {
      const url = new URL(String(target)); calls.push(url.pathname); expect(url.origin).toBe('https://api-sb.meld.io'); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error');
      if (url.pathname === '/payments/transactions') {
        expect(Object.fromEntries(url.searchParams)).toEqual({ sessionIds: 'synthetic-session', externalSessionIds: offId, externalCustomerIds: offCustomer,
          serviceProviders: 'TRANSAK', types: 'CRYPTO_SELL', limit: '2' });
        return Response.json({ transactions: [{ id: 'synthetic-transaction' }], totalCount: 1, remaining: 0 });
      }
      expect(url.pathname).toBe('/payments/transactions/synthetic-transaction'); return Response.json({ transaction: offTransaction });
    }) as unknown as typeof fetch });
  expect(calls).toHaveLength(2); expect(db.queries).toHaveLength(2);
  expect(result).toMatchObject({ reference: offId, source: { address: offAddress, asset: 'USDT', chainId: 137 },
    confirmation: { state: 'confirmed', source: 'meld_sandbox_api', testMode: true, transactionId: 'synthetic-transaction', providerStatus: 'SETTLED', destinationAmount: '95.010000' },
    execution: { canBroadcast: false, canFund: false, mode: 'sandbox_no_funds' } });
  expect(JSON.stringify(result)).not.toMatch(/depositWallet|private-provider-token|customer_reference|synthetic-account|synthetic-session/);
  expect(JSON.parse(String(db.queries[1]!.params[1]))).toEqual(proof());
  expect(JSON.stringify(db.queries)).not.toMatch(/commission|wallet_movement|capture_meld_webhook_event|reown|funding_attempt/);
});

test('full SELL proof rejects wrong account, chain, owner/session references, direction, asset, exact amount, provider and method', () => {
  for (const change of [{ id: 'another-transaction' }, { accountId: 'another-account' }, { sessionId: 'another-session' },
    { externalSessionId: '11111111-1111-4111-8111-111111111111' }, { externalCustomerId: '11111111-1111-4111-8111-111111111111' },
    { countryCode: 'MX' }, { serviceProvider: 'BANXA' }, { paymentMethodType: 'OTHER_METHOD' }, { sourceCurrencyCode: 'USDT' }, { destinationCurrencyCode: 'MXN' },
    { transactionType: 'CRYPTO_PURCHASE' }, { sourceAmount: 99 }, { sourceAmount: 100.00000001 }, { destinationAmount: 95.01000001 }, { destinationAmount: 0 },
    { status: 'unknown' }, { updatedAt: 'bad' }, { cryptoDetails: { ...offTransaction.cryptoDetails, chainId: 1 } },
    { cryptoDetails: { ...offTransaction.cryptoDetails, sourceWalletAddress: offDeposit, sessionWalletAddress: offDeposit } }]) {
    expect(() => administrativeOfframpProof({ transaction: { ...offTransaction, ...change } }, context, 'synthetic-transaction')).toThrow('administrative_offramp_unavailable');
  }
});

test('deposit addresses never substitute for an unknown customer source and a proven deposit cannot be swapped or removed', () => {
  for (const cryptoDetails of [{ chainId: '137', destinationWalletAddress: offAddress },
    { ...offTransaction.cryptoDetails, sourceWalletAddress: null, sessionWalletAddress: null },
    { ...offTransaction.cryptoDetails, sourceWalletAddress: offDeposit, sessionWalletAddress: offAddress },
    { ...offTransaction.cryptoDetails, destinationWalletAddress: offAddress },
    { ...offTransaction.cryptoDetails, destinationWalletAddress: '0x' + '0'.repeat(40) }]) {
    expect(() => administrativeOfframpProof({ transaction: { ...offTransaction, cryptoDetails } }, context, 'synthetic-transaction')).toThrow('administrative_offramp_unavailable');
  }
  const proven = { ...context, proof: proof() };
  for (const destinationWalletAddress of [undefined, '0x' + '4'.repeat(40)]) expect(() => administrativeOfframpProof({ transaction: { ...offTransaction,
    cryptoDetails: { ...offTransaction.cryptoDetails, destinationWalletAddress } } }, proven, 'synthetic-transaction')).toThrow('administrative_offramp_unavailable');
  expect(administrativeOfframpProof({ transaction: { ...offTransaction, cryptoDetails: { ...offTransaction.cryptoDetails, sourceWalletAddress: null } } }, context, 'synthetic-transaction').sourceWalletAddress).toBe(offAddress);
});

test('only the documented PENDING CREATED alias becomes pending; errors, cancellations and refunds never become confirmation', async () => {
  const aliased = administrativeOfframpProof({ transaction: { ...offTransaction, status: 'PENDING CREATED', destinationAmount: 0 } }, context, 'synthetic-transaction');
  expect(aliased.providerStatus).toBe('PENDING_CREATED');
  for (const providerStatus of ['PENDING_CREATED', 'SETTLING', 'ERROR', 'CANCELLED', 'REFUNDED']) {
    const cached = { ...proof(), providerStatus, destinationAmount: '0.000000' }, db = offDatabase([[{ ...offContext, proof: cached }]]);
    const result = await readAdministrativeOfframpHistory(db.database, input.subject, input.nativeSessionId, offEnvironment);
    expect(result.records[0]!.confirmation.state).toBe(['CANCELLED', 'REFUNDED'].includes(providerStatus) ? 'failed' : 'pending');
    expect(result.records[0]!.confirmation).not.toHaveProperty('destinationAmount'); expect(db.queries).toHaveLength(1);
  }
  expect(() => administrativeOfframpProof({ transaction: { ...offTransaction, status: 'pending created' } }, context, 'synthetic-transaction')).toThrow('administrative_offramp_unavailable');
});

test('cached history has one owner/session query and performs no provider work; malformed or foreign stored data is rejected', async () => {
  const db = offDatabase([[{ ...offContext, proof: proof() }]]);
  const value = await readAdministrativeOfframpHistory(db.database, input.subject, input.nativeSessionId, offEnvironment);
  expect(value.records[0]?.confirmation.state).toBe('confirmed'); expect(db.queries).toHaveLength(1); expect(db.queries[0]!.params).toEqual([input.subject, input.nativeSessionId]);
  for (const change of [{ subject: 'foreign' }, { amount_atomic: '99999999' }, { proof: { ...proof(), sourceWalletAddress: offDeposit } }, { provider_session_id: 'another' }]) {
    const denied = offDatabase([[{ ...offContext, proof: proof(), ...change }]]);
    await expect(readAdministrativeOfframpHistory(denied.database, input.subject, input.nativeSessionId, offEnvironment)).rejects.toThrow();
  }
});

test('disabled, foreign and expired native status reads stop before provider requests and reject browser transaction selectors', async () => {
  let calls = 0; const fetchImpl = (async () => { calls++; throw Error('must not request'); }) as unknown as typeof fetch;
  for (const operation of [() => readAdministrativeOfframpStatus(offDatabase([]).database, input, { environment: {}, fetchImpl }),
    () => readAdministrativeOfframpHistory(offDatabase([]).database, input.subject, input.nativeSessionId, {})]) await expect(operation()).rejects.toThrow('administrative_offramp_unconfigured');
  const denied = offDatabase([new Error('administrative_signing_forbidden')]);
  await expect(readAdministrativeOfframpStatus(denied.database, input, { environment: offEnvironment, fetchImpl })).rejects.toThrow('administrative_signing_forbidden');
  const foreign = offDatabase([[{ ...offContext, subject: 'foreign' }]]);
  await expect(readAdministrativeOfframpStatus(foreign.database, input, { environment: offEnvironment, fetchImpl })).rejects.toThrow('administrative_operation_forbidden');
  expect(calls).toBe(0);
});

test('empty searches remain unconfirmed while ambiguous, malformed, dot-segment and unauthorized API responses never write proof', async () => {
  for (const data of [{ transactions: [] }, { transactions: [{ id: 'one' }, { id: 'two' }] }, { transactions: [{ id: '..' }] }, { private: 'field' }]) {
    const db = offDatabase([[offContext]]); let calls = 0;
    const operation = readAdministrativeOfframpStatus(db.database, input, { environment: offEnvironment,
      fetchImpl: (async () => { calls++; return Response.json(data); }) as unknown as typeof fetch });
    if ('transactions' in data && Array.isArray(data.transactions) && data.transactions.length === 0) expect((await operation).confirmation.state).toBe('unconfirmed');
    else await expect(operation).rejects.toThrow('administrative_offramp_unavailable');
    expect(calls).toBe(1); expect(db.queries).toHaveLength(1);
  }
  for (const response of [Response.json({ private: 'token' }, { status: 401 }), new Response('{bad', { headers: { 'content-type': 'application/json' } })]) {
    const db = offDatabase([[offContext]]); await expect(readAdministrativeOfframpStatus(db.database, input, { environment: offEnvironment,
      fetchImpl: (async () => response) as unknown as typeof fetch })).rejects.toThrow('administrative_offramp_unavailable'); expect(db.queries).toHaveLength(1);
  }
});

test('signed SELL webhook reaches only the sandbox-owned context and independent GET proof after HMAC verification', async () => {
  const timestamp = new Date(offNow).toISOString();
  const event = { eventType: 'TRANSACTION_CRYPTO_COMPLETE', eventId: 'synthetic-sell-event', timestamp, accountId: 'synthetic-account', profileId: 'synthetic-profile', version: '2026-02-03',
    payload: { externalSessionId: offId, externalCustomerId: offCustomer, sessionId: 'synthetic-session', paymentTransactionId: 'synthetic-transaction', transactionType: 'CRYPTO_SELL' } };
  const raw = JSON.stringify(event), signature = createHmac('sha256', offEnvironment.MELD_WEBHOOK_SIGNING_KEY)
    .update(`${timestamp}.${offEnvironment.MELD_WEBHOOK_PUBLIC_URL}.${raw}`).digest('base64url') + '=';
  const db = offDatabase([[offContext]]); let calls = 0;
  const deps = { environment: offEnvironment, now: () => offNow, fetchImpl: (async (target: string | Request | URL) => {
    calls++; expect(String(target)).toBe('https://api-sb.meld.io/payments/transactions/synthetic-transaction'); return Response.json({ transaction: offTransaction });
  }) as unknown as typeof fetch };
  await expect(handleSandboxMeldWebhook(db.database, raw + ' ', { signature, signatureTimestamp: timestamp }, deps)).rejects.toThrow('invalid_meld_signature');
  expect(db.queries).toHaveLength(0);
  expect(await handleSandboxMeldWebhook(db.database, raw, { signature, signatureTimestamp: timestamp }, deps)).toEqual({ received: true, mode: 'sandbox_only' });
  expect(calls).toBe(1); expect(db.queries).toHaveLength(2); expect(db.queries[0]!.sql).toContain('read_administrative_offramp_webhook_context');
  const disabled = offDatabase([]);
  expect((await handleSandboxMeldWebhook(disabled.database, raw, { signature, signatureTimestamp: timestamp }, { ...deps,
    environment: { ...offEnvironment, ADMINISTRATIVE_MELD_OFFRAMP_ENABLED: 'false' } })).ignored).toBe(true);
  expect(disabled.queries).toHaveLength(0); expect(calls).toBe(1);
  for (const change of [{ accountId: 'foreign' }, { profileId: 'foreign' }, { payload: { ...event.payload, sessionId: '..' } }, { payload: { ...event.payload, externalSessionId: 'other' } }]) {
    const ignored = offDatabase([]);
    expect((await handleVerifiedAdministrativeOfframpWebhook(ignored.database, { ...event, ...change }, deps)).ignored).toBe(true); expect(ignored.queries).toHaveLength(0);
  }
});
