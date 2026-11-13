import { expect, test } from 'bun:test';
import { reconcileAdministrativeSandboxFunding, readAdministrativeSandboxConfirmations, validateSandboxTransaction,
  sandboxContextInput, sandboxProofConfirmation } from './meld-sandbox-reconciliation';
import { sandboxId, sandboxContext, sandboxTransaction, sandboxEnvironment, sandboxNow, sandboxDatabase } from './meld-sandbox-fixtures';
const input = { subject: sandboxContext.subject, checkoutReference: sandboxId };
const context = sandboxContextInput.parse(sandboxContext);
const proof = () => validateSandboxTransaction({ transaction: sandboxTransaction }, context, 'sandbox-account', 'sandbox-transaction');

test('sandbox reconciliation discovers with owned filters, GETs independent proof and records only bounded test evidence', async () => {
  const db = sandboxDatabase(), calls: string[] = [];
  const result = await reconcileAdministrativeSandboxFunding(db.database, input, { environment: sandboxEnvironment, now: () => sandboxNow,
    fetchImpl: (async (target: string | Request | URL, init?: RequestInit) => { const url = new URL(String(target)); calls.push(url.href);
      expect(url.origin).toBe('https://api-sb.meld.io'); expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe('BASIC synthetic-sandbox-key');
      if (url.search) { expect(url.pathname).toBe('/payments/transactions'); expect(Object.fromEntries(url.searchParams)).toEqual({
        externalSessionIds: sandboxId, sessionIds: 'sandbox-session', externalCustomerIds: sandboxContext.customer_reference,
        serviceProviders: 'BANXA', types: 'CRYPTO_PURCHASE', limit: '2' }); return Response.json({ transactions: [{ id: 'sandbox-transaction' }] }); }
      expect(url.pathname).toBe('/payments/transactions/sandbox-transaction'); return Response.json({ transaction: sandboxTransaction });
    }) as unknown as typeof fetch });
  expect(result).toEqual({ state: 'confirmed', source: 'meld_sandbox_api', testMode: true, receivedAmount: '31.123456',
    confirmedAt: sandboxTransaction.updatedAt, transactionId: 'sandbox-transaction', providerStatus: 'SETTLED' });
  expect(calls).toHaveLength(2); expect(db.queries).toHaveLength(2);
  expect(JSON.stringify(db.queries)).not.toMatch(/private|do-not-persist|commission|meld_onramp_attempt|reown|wallet_movement/);
  expect(JSON.parse(String(db.queries[1]!.params[2]))).toEqual(proof());
});

test('ownership is checked before configuration, keys, search and proof recording', async () => {
  let calls = 0;
  for (const c of [null, { ...sandboxContext, subject: 'someone-else' }, { ...sandboxContext, id: '11111111-1111-4111-8111-111111111111' }]) {
    const db = sandboxDatabase({ context: c });
    await expect(reconcileAdministrativeSandboxFunding(db.database, input, { environment: sandboxEnvironment,
      fetchImpl: (async () => { calls++; throw Error('must not run'); }) as unknown as typeof fetch })).rejects.toThrow();
    expect(db.queries).toHaveLength(1);
  }
  expect(calls).toBe(0);
});

test('absent sandbox configuration or uncreated session remains unconfirmed without network or financial writes', async () => {
  for (const env of [{}, { ...sandboxEnvironment, MELD_API_SANDBOX: '' }, { ...sandboxEnvironment, MELD_ACCOUNT_ID: '' },
    { ...sandboxEnvironment, MELD_ADMIN_SANDBOX_ENABLED: 'false', MELD_API_KEY: 'must-not-use-production' }]) {
    const db = sandboxDatabase();
    expect(await reconcileAdministrativeSandboxFunding(db.database, input, { environment: env,
      fetchImpl: (async () => { throw Error('network forbidden'); }) as unknown as typeof fetch })).toEqual({ state: 'unconfirmed', source: 'none', testMode: true });
    expect(db.queries).toHaveLength(1);
  }
});

test('empty search is not settlement and multiple matches never guess a transaction', async () => {
  for (const transactions of [[], [{ id: 'one' }, { id: 'two' }]]) {
    const db = sandboxDatabase(); let calls = 0;
    const operation = reconcileAdministrativeSandboxFunding(db.database, input, { environment: sandboxEnvironment,
      fetchImpl: (async () => { calls++; return Response.json({ transactions }); }) as unknown as typeof fetch });
    if (transactions.length) await expect(operation).rejects.toThrow('wallet_funding_provider_unavailable');
    else expect(await operation).toEqual({ state: 'unconfirmed', source: 'none', testMode: true });
    expect(calls).toBe(1); expect(db.queries).toHaveLength(1);
  }
});

test('independent proof rejects every immutable routing, owner and transaction mismatch', async () => {
  const changes: Record<string, unknown>[] = [
    { id: 'another-tx' }, { accountId: 'another-account' }, { sessionId: 'another-session' },
    { externalSessionId: '11111111-1111-4111-8111-111111111111' }, { externalCustomerId: '11111111-1111-4111-8111-111111111111' },
    { serviceProvider: 'TRANSAK' }, { countryCode: 'US' }, { sourceCurrencyCode: 'USD' }, { sourceAmount: 649.99 },
    { sourceAmount: 650.001 }, { destinationCurrencyCode: 'USDT' }, { paymentMethodType: 'APPLE_PAY' },
    { cryptoDetails: { ...sandboxTransaction.cryptoDetails, chainId: '1' } },
    { cryptoDetails: { ...sandboxTransaction.cryptoDetails, destinationWalletAddress: `0x${'3'.repeat(40)}` } },
    { transactionType: 'CRYPTO_SELL' }, { status: 'arbitrary' }, { destinationAmount: 0 }, { destinationAmount: -1 },
    { destinationAmount: 1.1234567 }, { updatedAt: 'invalid' }, { accountId: undefined },
  ];
  for (const change of changes) {
    const db = sandboxDatabase({ context: { ...sandboxContext, proof: proof() } });
    await expect(reconcileAdministrativeSandboxFunding(db.database, input, { environment: sandboxEnvironment,
      fetchImpl: (async () => Response.json({ transaction: { ...sandboxTransaction, ...change } })) as unknown as typeof fetch })).rejects.toThrow();
    expect(db.queries).toHaveLength(1);
  }
});

test('provider status mapping cannot turn pending, error, cancellation or refund into settlement', () => {
  expect(validateSandboxTransaction({ transaction: { ...sandboxTransaction, destinationAmount: 27.456789 } }, context,
    'sandbox-account', 'sandbox-transaction').receivedAmount).toBe('27.456789');
  for (const status of ['PENDING_CREATED', 'PENDING', 'SETTLING', 'ERROR', 'TWO_FA_REQUIRED', 'AUTHORIZED']) {
    const p = validateSandboxTransaction({ transaction: { ...sandboxTransaction, status, destinationAmount: 0 } }, context, 'sandbox-account', 'sandbox-transaction');
    expect(sandboxProofConfirmation(p)).toEqual({ state: 'pending', source: 'meld_sandbox_api', testMode: true,
      providerStatus: status, transactionId: 'sandbox-transaction' });
  }
  for (const status of ['FAILED', 'DECLINED', 'CANCELLED', 'REFUNDED']) expect(sandboxProofConfirmation({ ...proof(), providerStatus: status }).state).toBe('failed');
  expect(sandboxProofConfirmation({ ...proof(), receivedAmount: '0' }).state).toBe('unconfirmed');
});

test('timeouts, bad JSON, oversized streams, HTTP401 and DB failure never store or return invented settlement', async () => {
  for (const response of [new Response('private-secret', { status: 401 }), new Response('{bad'),
    new Response('x'.repeat(131_073)), new Response('{}', { headers: { 'content-length': '999999' } })]) {
    const db = sandboxDatabase();
    await expect(reconcileAdministrativeSandboxFunding(db.database, input, { environment: sandboxEnvironment,
      fetchImpl: (async () => response) as unknown as typeof fetch })).rejects.toThrow('wallet_funding_provider_unavailable');
    expect(db.queries).toHaveLength(1);
  }
  const db = sandboxDatabase();
  await expect(reconcileAdministrativeSandboxFunding(db.database, input, { environment: sandboxEnvironment, timeoutMs: 5,
    fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch })).rejects.toThrow('wallet_funding_provider_unavailable');
  expect(db.queries).toHaveLength(1);
  const failed = sandboxDatabase({ context: { ...sandboxContext, proof: proof() }, failProof: true });
  await expect(reconcileAdministrativeSandboxFunding(failed.database, input, { environment: sandboxEnvironment,
    fetchImpl: (async () => Response.json({ transaction: sandboxTransaction })) as unknown as typeof fetch })).rejects.toThrow();
});

test('manual repeats share a bounded owner budget and concurrent reads make no duplicate provider requests', async () => {
  const db = sandboxDatabase(); let calls = 0;
  await reconcileAdministrativeSandboxFunding(db.database, input, { environment: sandboxEnvironment, now: () => sandboxNow,
    fetchImpl: (async () => { calls++; return Response.json({ transactions: [] }); }) as unknown as typeof fetch });
  await expect(reconcileAdministrativeSandboxFunding(db.database, input, { environment: sandboxEnvironment, now: () => sandboxNow,
    fetchImpl: (async () => { calls++; return Response.json({ transactions: [] }); }) as unknown as typeof fetch })).rejects.toThrow('wallet_funding_rate_limited');
  expect(calls).toBe(1);
});

test('history uses one owner-scoped cached query and never returns private proof fields', async () => {
  const db = sandboxDatabase({ cached: [{ id: sandboxId, proof: proof() }] });
  const map = await readAdministrativeSandboxConfirmations(db.database, { subject: input.subject, checkoutReferences: [sandboxId] });
  expect(map.get(sandboxId)?.state).toBe('confirmed'); expect(db.queries).toHaveLength(1);
  expect(db.queries[0]?.params).toEqual([input.subject, [sandboxId]]);
  expect(JSON.stringify([...map])).not.toMatch(/accountId|sessionId|externalCustomerId|walletAddress|sourceAmount/);
  await expect(readAdministrativeSandboxConfirmations(db.database, { subject: input.subject, checkoutReferences: Array(51).fill(sandboxId) })).rejects.toThrow();
  const escaped = sandboxDatabase({ cached: [{ id: '11111111-1111-4111-8111-111111111111', proof: proof() }] });
  await expect(readAdministrativeSandboxConfirmations(escaped.database, { subject: input.subject, checkoutReferences: [sandboxId] })).rejects.toThrow();
});

test('dot path segments cannot be taken from discovery, persisted context or cached proof into authenticated GET URLs', async () => {
  for (const id of ['.', '..']) {
    const db = sandboxDatabase(); let calls = 0;
    await expect(reconcileAdministrativeSandboxFunding(db.database, input, { environment: sandboxEnvironment,
      fetchImpl: (async () => { calls++; return Response.json({ transactions: [{ id }] }); }) as unknown as typeof fetch })).rejects.toThrow();
    expect(calls).toBe(1); expect(db.queries).toHaveLength(1);
    for (const c of [{ ...sandboxContext, provider_session_id: id }, { ...sandboxContext, proof: { ...proof(), transactionId: id } }]) {
      const invalid = sandboxDatabase({ context: c }); let fetches = 0;
      await expect(reconcileAdministrativeSandboxFunding(invalid.database, input, { environment: sandboxEnvironment,
        fetchImpl: (async () => { fetches++; throw Error('must not send'); }) as unknown as typeof fetch })).rejects.toThrow();
      expect(fetches).toBe(0);
    }
  }
});
