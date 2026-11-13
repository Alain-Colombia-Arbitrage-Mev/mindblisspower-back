import { createHmac } from 'node:crypto';
import { expect, test } from 'bun:test';
import { handleSandboxMeldWebhook, verifySandboxMeldWebhook } from './meld-sandbox-webhook';
import { sandboxId, sandboxCustomer, sandboxContext, sandboxTransaction, sandboxEnvironment, sandboxNow, sandboxDatabase } from './meld-sandbox-fixtures';
const timestamp = new Date(sandboxNow).toISOString();
function event(change = {}) { return { eventType: 'TRANSACTION_CRYPTO_COMPLETE', eventId: 'synthetic-event', timestamp,
  accountId: 'sandbox-account', profileId: 'sandbox-profile', version: '2026-02-03',
  payload: { externalSessionId: sandboxId, externalCustomerId: sandboxCustomer, sessionId: 'sandbox-session',
    paymentTransactionId: 'sandbox-transaction', transactionType: 'CRYPTO_PURCHASE' }, ...change }; }
function sign(value: unknown, url = sandboxEnvironment.MELD_WEBHOOK_PUBLIC_URL) {
  const raw = JSON.stringify(value), signature = createHmac('sha256', sandboxEnvironment.MELD_WEBHOOK_SIGNING_KEY)
    .update(`${timestamp}.${url}.${raw}`).digest('base64url') + '=';
  return { raw, headers: { signature, signatureTimestamp: timestamp } };
}

test('signed WEBHOOK_TEST with null profile records only one technical receipt and performs no provider or legacy work', async () => {
  const signed = sign(event({ eventType: 'WEBHOOK_TEST', profileId: null, payload: { requestId: 'synthetic-request' } }));
  const db = sandboxDatabase(); let providerCalls = 0;
  const dependencies = { environment: sandboxEnvironment, now: () => sandboxNow,
    fetchImpl: (async () => { providerCalls++; throw Error('no test API lookup'); }) as unknown as typeof fetch };
  expect(await handleSandboxMeldWebhook(db.database, signed.raw, signed.headers, dependencies)).toEqual({ received: true, duplicate: false, mode: 'sandbox_only' });
  expect(await handleSandboxMeldWebhook(db.database, signed.raw, signed.headers, dependencies)).toEqual({ received: true, duplicate: true, mode: 'sandbox_only' });
  expect(db.queries).toHaveLength(2); expect(providerCalls).toBe(0);
  expect(db.queries.every(q => q.sql.includes('record_meld_sandbox_webhook_receipt'))).toBe(true);
  expect(db.queries[0]?.params[6]).toBeNull();
  expect(JSON.stringify(db.queries)).not.toMatch(/capture_meld_webhook_event|meld_onramp_attempt|commission|wallet_movement|private/);
});

test('authentic native event must GET the transaction independently before recording sandbox proof', async () => {
  const signed = sign(event()), db = sandboxDatabase(); let calls = 0;
  expect(await handleSandboxMeldWebhook(db.database, signed.raw, signed.headers, { environment: sandboxEnvironment, now: () => sandboxNow,
    fetchImpl: (async (target: string | Request | URL) => { calls++; expect(String(target)).toBe('https://api-sb.meld.io/payments/transactions/sandbox-transaction');
      return Response.json({ transaction: sandboxTransaction }); }) as unknown as typeof fetch })).toEqual({ received: true, duplicate: false, mode: 'sandbox_only' });
  expect(calls).toBe(1);
  expect(db.queries.map(q => q.sql)).toEqual([expect.stringContaining('read_meld_sandbox_webhook_context'),
    expect.stringContaining('record_meld_sandbox_webhook_receipt'), expect.stringContaining('record_meld_sandbox_proof')]);
  expect(db.queries[0]?.params).toEqual([sandboxId, sandboxCustomer, 'sandbox-session']);
});

test('valid signed unrelated customer, legacy IDs, sell/transfer and early unbound events are acknowledged without lookup or writes', async () => {
  const payloads = [{ transactionType: 'CRYPTO_PURCHASE' }, { externalSessionId: 'external-legacy', externalCustomerId: 'legacy-customer', sessionId: 'session',
    paymentTransactionId: 'tx', transactionType: 'CRYPTO_PURCHASE' }, { ...event().payload, transactionType: 'CRYPTO_SELL' },
    { ...event().payload, transactionType: 'CRYPTO_TRANSFER' }];
  for (const payload of payloads) {
    const signed = sign(event({ payload })), db = sandboxDatabase();
    expect(await handleSandboxMeldWebhook(db.database, signed.raw, signed.headers, { environment: sandboxEnvironment, now: () => sandboxNow,
      fetchImpl: (async () => { throw Error('no request'); }) as unknown as typeof fetch })).toEqual({ received: true, ignored: true, mode: 'sandbox_only' });
    expect(db.queries).toHaveLength(0);
  }
  const signed = sign(event({ eventType: 'CUSTOMER_KYC_STATUS_CHANGE', payload: { requestId: 'other-product' } })), db = sandboxDatabase();
  expect((await handleSandboxMeldWebhook(db.database, signed.raw, signed.headers, { environment: sandboxEnvironment, now: () => sandboxNow })).ignored).toBe(true);
  expect(db.queries).toHaveLength(0);
});

test('wallet webhook cannot select a foreign attempt, wallet or unbound session', async () => {
  const signed = sign(event());
  for (const c of [null, { ...sandboxContext, provider_session_id: 'wrong-session' }, { ...sandboxContext, customer_reference: '11111111-1111-4111-8111-111111111111' }]) {
    const db = sandboxDatabase({ context: c }); let calls = 0;
    const promise = handleSandboxMeldWebhook(db.database, signed.raw, signed.headers, { environment: sandboxEnvironment, now: () => sandboxNow,
      fetchImpl: (async () => { calls++; throw Error('must not call'); }) as unknown as typeof fetch });
    if (!c) expect((await promise).ignored).toBe(true); else await expect(promise).rejects.toThrow();
    expect(calls).toBe(0); expect(db.queries).toHaveLength(1);
  }
});

test('signature covers exact raw body and configured wallet URL; wrong profile/account, replay and disabled flags fail before DB', () => {
  const signed = sign(event());
  expect(verifySandboxMeldWebhook(signed.raw, signed.headers, sandboxEnvironment, sandboxNow).event.eventId).toBe('synthetic-event');
  for (const [raw, headers, env, now] of [
    [signed.raw + ' ', signed.headers, sandboxEnvironment, sandboxNow],
    [signed.raw, { ...signed.headers, signature: 'a'.repeat(43) + '=' }, sandboxEnvironment, sandboxNow],
    [signed.raw, signed.headers, sandboxEnvironment, sandboxNow + 300001],
    [signed.raw, signed.headers, { ...sandboxEnvironment, MELD_WEBHOOK_ENABLED: 'false' }, sandboxNow],
    [signed.raw, signed.headers, { ...sandboxEnvironment, MELD_ADMIN_SANDBOX_ENABLED: 'false' }, sandboxNow],
    [signed.raw, signed.headers, { ...sandboxEnvironment, MELD_WEBHOOK_PUBLIC_URL: 'https://app.mindblisspower.com/api/webhooks/meld' }, sandboxNow],
    [signed.raw, signed.headers, { ...sandboxEnvironment, MELD_ACCOUNT_ID: 'wrong-account' }, sandboxNow],
    [signed.raw, signed.headers, { ...sandboxEnvironment, MELD_WEBHOOK_PROFILE_ID: 'wrong-profile' }, sandboxNow],
  ] as const) expect(() => verifySandboxMeldWebhook(raw, headers, env, now)).toThrow();
  const invalid = sign(event({ profileId: null }));
  expect(() => verifySandboxMeldWebhook(invalid.raw, invalid.headers, sandboxEnvironment, sandboxNow)).toThrow('invalid_meld_profile');
});

test('captured receipt does not suppress independent GET retry after provider failure and never credits funds', async () => {
  const signed = sign(event()), db = sandboxDatabase(); let attempt = 0, currentNow = sandboxNow;
  const deps = { environment: sandboxEnvironment, now: () => currentNow, fetchImpl: (async () => {
    attempt++; return attempt === 1 ? new Response('{}', { status: 503 }) : Response.json({ transaction: sandboxTransaction });
  }) as unknown as typeof fetch };
  await expect(handleSandboxMeldWebhook(db.database, signed.raw, signed.headers, deps)).rejects.toThrow('wallet_funding_provider_unavailable');
  expect(db.queries.some(q => q.sql.includes('record_meld_sandbox_proof'))).toBe(false);
  currentNow += 5001;
  expect((await handleSandboxMeldWebhook(db.database, signed.raw, signed.headers, deps)).duplicate).toBe(true);
  expect(attempt).toBe(2);
  expect(db.queries.filter(q => q.sql.includes('record_meld_sandbox_proof'))).toHaveLength(1);
});

test('authenticated webhook transaction IDs cannot normalize an outbound URL to dot path segments', async () => {
  for (const paymentTransactionId of ['.', '..']) {
    const signed = sign(event({ payload: { ...event().payload, paymentTransactionId } })), db = sandboxDatabase(); let calls = 0;
    await expect(handleSandboxMeldWebhook(db.database, signed.raw, signed.headers, { environment: sandboxEnvironment, now: () => sandboxNow,
      fetchImpl: (async () => { calls++; throw Error('must not call'); }) as unknown as typeof fetch })).rejects.toThrow();
    expect(calls).toBe(0); expect(db.queries).toHaveLength(0);
  }
});
