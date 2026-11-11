import { expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from '../identity/model';
import { companyPaymentEventInput, recordPersonalCompanyPaymentEvent, readPersonalCompanyPaymentActivity } from './personal-company-events';
import { COMPANY_PAYMENT_RECIPIENT, COMPANY_PAYMENT_TOKEN, LEGACY_POLYGON_TOKEN } from './personal-company-rpc';
const id = '11111111-1111-4111-8111-111111111111', eventId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333', hash = `0x${'4'.repeat(64)}`;
const base = { event_id: eventId, payment_id: id, attempt_id: attemptId, source: 'client_reported', event: 'broadcast_observed',
  canonical_status: null, chain_id: 1, token_address: COMPANY_PAYMENT_TOKEN, wallet_address: `0x${'5'.repeat(40)}`,
  recipient_address: COMPANY_PAYMENT_RECIPIENT, amount_atomic: '30000000', transaction_hash: hash, code: null,
  created_at: new Date('2026-11-11T04:00:00Z') };
function database(rows: unknown[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  return { queries, value: { execute: async (query: SQL) => { queries.push(new PgDialect().sqlToQuery(query)); return rows; } } as Pick<IdentityDatabase, 'execute'> };
}

test('client journal accepts only narrow untrusted lifecycle statements, never canonical confirmations or identities', () => {
  expect(companyPaymentEventInput.parse({ eventId, paymentId: id, event: 'wallet_rejected', code: 'user_rejected' })).toMatchObject({ event: 'wallet_rejected' });
  for (const extra of [{ event: 'confirmed' }, { event: 'snapshot' }, { event: 'broadcast_observed' }, { event: 'wallet_prompt_opened', transactionHash: hash },
    { source: 'canonical' }, { canonicalStatus: 'confirmed' }, { amountAtomic: '1' }, { walletAddress: base.wallet_address }, { chainId: 137 },
    { subject: 'another-owner' }, { recordedAt: '2026-11-11T04:00:00Z' }, { code: 'private provider error' }, { signature: 'private' }, { attemptId: null }]) {
    expect(companyPaymentEventInput.safeParse({ eventId, paymentId: id, event: 'wallet_failed', ...extra }).success).toBe(false);
  }
});

test('recording calls one owner-scoped append-only SQL capability and returns an explicitly client-reported acknowledgement', async () => {
  const db = database([base]);
  const input = { eventId, paymentId: id, attemptId, event: 'broadcast_observed', transactionHash: hash };
  expect(await recordPersonalCompanyPaymentEvent(db.value, 'owner', input)).toEqual({ walletKind: 'personal', eventId, paymentId: id,
    attemptId, source: 'client_reported', event: 'broadcast_observed', recordedAt: base.created_at.toISOString() });
  expect(db.queries).toHaveLength(1);
  expect(db.queries[0]!.params).toEqual(['owner', id, eventId, attemptId, 'broadcast_observed', hash, null]);
  expect(db.queries[0]!.sql).toContain('payments.record_personal_company_payment_event');
  expect(db.queries[0]!.sql).not.toMatch(/UPDATE|INSERT INTO|submit_personal|verify_personal|ledger|commission|membership/i);
  const legacy = database([{ ...base, attempt_id: null, event: 'wallet_rejected', transaction_hash: null, code: 'user_rejected' }]);
  expect((await recordPersonalCompanyPaymentEvent(legacy.value, 'owner', { eventId, paymentId: id, event: 'wallet_rejected', code: 'user_rejected' })).attemptId).toBeNull();
});

test('journal rejects crossed chain/token pairs, forged acknowledgement and canonical status from a client row', async () => {
  for (const extra of [{ event_id: attemptId }, { payment_id: attemptId }, { attempt_id: null }, { source: 'canonical' },
    { canonical_status: 'confirmed' }, { event: 'wallet_failed' }, { chain_id: 137 }, { amount_atomic: '0' }, { token_address: LEGACY_POLYGON_TOKEN },
    { transaction_hash: null }, { code: 'unknown' }]) {
    await expect(recordPersonalCompanyPaymentEvent(database([{ ...base, ...extra }]).value, 'owner',
      { eventId, paymentId: id, attemptId, event: 'broadcast_observed', transactionHash: hash })).rejects.toThrow('company_payment_unavailable');
  }
});

test('activity uses owner-bound seek pagination without truncating the retained journal or conflating claims with confirmations', async () => {
  const next = '44444444-4444-4444-8444-444444444444', third = '55555555-5555-4555-8555-555555555555';
  const canonical = { ...base, event_id: next, attempt_id: null, source: 'canonical', event: 'snapshot', canonical_status: 'confirmed' };
  const db = database([base, canonical, { ...canonical, event_id: third }]);
  const result = await readPersonalCompanyPaymentActivity(db.value, 'owner', { paymentId: id, cursor: attemptId, limit: 2 });
  expect(result.events).toHaveLength(2); expect(result.nextCursor).toBe(next);
  expect(result.events[0]).toMatchObject({ source: 'client_reported', canonicalStatus: null, chainId: 1, transactionHash: hash });
  expect(result.events[1]).toMatchObject({ source: 'canonical', event: 'snapshot', canonicalStatus: 'confirmed', recordedAt: base.created_at.toISOString() });
  expect(db.queries[0]!.params).toEqual(['owner', id, attemptId, 3]);
  expect(db.queries[0]!.sql).toContain('read_personal_company_payment_activity');
  expect(await readPersonalCompanyPaymentActivity(database([]).value, 'owner', {})).toEqual({ walletKind: 'personal', events: [], nextCursor: null });
  for (const rows of [[base, base], [{ ...base, payment_id: attemptId }], [{ ...canonical, event: 'confirmed', canonical_status: 'prepared' }],
    [{ ...canonical, canonical_status: null }], [{ ...base, chain_id: 137 }]]) {
    await expect(readPersonalCompanyPaymentActivity(database(rows).value, 'owner', { paymentId: id })).rejects.toThrow('company_payment_unavailable');
  }
});

test('invalid journal selectors and aborted requests never reach the database', async () => {
  const db = database([]), controller = new AbortController(); controller.abort();
  for (const value of [{ subject: 'other' }, { limit: 0 }, { limit: 51 }, { limit: '20' }, { cursor: 'not-an-event' }]) {
    await expect(readPersonalCompanyPaymentActivity(db.value, 'owner', value)).rejects.toThrow();
  }
  await expect(readPersonalCompanyPaymentActivity(db.value, 'owner', {}, { signal: controller.signal })).rejects.toThrow('Aborted');
  await expect(recordPersonalCompanyPaymentEvent(db.value, 'owner', { eventId, paymentId: id, event: 'wallet_failed' }, { signal: controller.signal })).rejects.toThrow('Aborted');
  expect(db.queries).toHaveLength(0);
});
