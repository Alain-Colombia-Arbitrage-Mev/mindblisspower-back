import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { apiErrorHandler } from './errors';
import { positiveId, placementInput, autoPlacementInput, transactionInput, reportingRange, alertId } from './input';
import { FinancialRecoveryPendingError, requireOperationalFinance } from '../server/financial-readiness';

const input = {
  externalRef: 'source:fixture', description: 'Synthetic transaction', initiatedByPersonId: '1',
  movements: [{ walletId: '2', affiliateId: '3', conceptId: 4, amount: '10.0001', postedAt: '2026-10-25T12:00:00Z' }],
};

test('IDs preserve exact int64 values and reject unsafe or missing input', () => {
  expect(positiveId.parse('9223372036854775807')).toBe(9223372036854775807n);
  expect(positiveId.parse(123)).toBe(123n);
  for (const value of [null, undefined, '', 0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, '9223372036854775808', '1; SELECT 1']) {
    expect(positiveId.safeParse(value).success).toBe(false);
  }
  expect(alertId.parse('42')).toBe('42');
});

test('placement validates its side and required identities before a service runs', () => {
  expect(autoPlacementInput.parse({ personId: '1', sponsorAffiliateId: '2' }).personId).toBe(1n);
  expect(placementInput.safeParse({ personId: '1', parentAffiliateId: '2', sponsorAffiliateId: '3', position: 'X' }).success).toBe(false);
  expect(placementInput.safeParse({ personId: '1', position: 'L' }).success).toBe(false);
});

test('transactions keep exact money strings, timestamps and idempotency references', () => {
  const parsed = transactionInput.parse({ ...input, externalRef: ' source:fixture ' });
  expect(parsed.movements[0]!.amount).toBe('10.0001');
  expect(parsed.movements[0]!.postedAt).toBeInstanceOf(Date);
  expect(parsed.externalRef).toBe(' source:fixture ');
  for (const amount of [null, 10.1, 'NaN', 'Infinity', '1e3', '', '0.000000001', '1000000000000', '9'.repeat(80)]) {
    expect(transactionInput.safeParse({ ...input, movements: [{ ...input.movements[0], amount }] }).success).toBe(false);
  }
  expect(transactionInput.safeParse({ ...input, movements: [] }).success).toBe(false);
  expect(transactionInput.safeParse({ ...input, movements: [{ ...input.movements[0], postedAt: 'not-a-date' }] }).success).toBe(false);
  expect(transactionInput.safeParse({ ...input, movements: [{ ...input.movements[0], postedAt: '2026-02-30T12:00:00Z' }] }).success).toBe(false);
  expect(transactionInput.safeParse({ ...input, movements: [{ ...input.movements[0], postedAt: '0000-01-01T00:00:00Z' }] }).success).toBe(false);
  expect(transactionInput.safeParse({ ...input, movements: [{ ...input.movements[0], postedAt: '0001-01-01T00:00:00+01:00' }] }).success).toBe(false);
  for (const amount of ['999999999999.99999999', '-999999999999.99999999', '0.00000001', '0001.00000000']) {
    expect(transactionInput.parse({ ...input, movements: [{ ...input.movements[0], amount }] }).movements[0]!.amount).toBe(amount);
  }
});

test('legacy initiator fields are optional and ignored instead of becoming audit identity', () => {
  for (const initiatedByPersonId of [undefined, '9223372036854775807', 'invalid', null]) {
    expect('initiatedByPersonId' in transactionInput.parse({ ...input, initiatedByPersonId })).toBe(false);
  }
});

test('report ranges reject invalid dates and reversed periods', () => {
  expect(reportingRange.safeParse({ from: '2026-02-30', to: '2026-10-25' }).success).toBe(false);
  expect(reportingRange.safeParse({ from: '2026-10-25', to: '2026-01-01' }).success).toBe(false);
  expect(reportingRange.safeParse({ from: '0000-01-01', to: '2026-10-25' }).success).toBe(false);
  expect(reportingRange.parse({ from: '2026-01-01', to: '2026-10-25' }).from).toBe('2026-01-01');
});

test('HTTP boundary returns 400 without leaking input validation or syntax details', async () => {
  const app = new Hono().onError(apiErrorHandler);
  app.post('/fixture', async c => { transactionInput.parse(await c.req.json()); return c.json({ ok: true }); });
  for (const body of ['{', JSON.stringify({ ...input, movements: [{ ...input.movements[0], walletId: 'private-invalid-input' }] })]) {
    const response = await app.request('/fixture', { method: 'POST', body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  }
});

test('body size guard rejects oversized JSON with a stable 413 error', async () => {
  const app = new Hono().onError(apiErrorHandler);
  app.use('*', bodyLimit({ maxSize: 32, onError: c => c.json({ error: 'request_too_large' }, 413) }));
  app.post('/fixture', async c => c.json(await c.req.json()));
  const response = await app.request('/fixture', { method: 'POST', body: JSON.stringify({ data: 'x'.repeat(64) }) });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: 'request_too_large' });
});

test('recovery blocks derived finance and is represented as 503, not invented solvency', async () => {
  for (const rows of [[{ recovery: true }], []]) {
    const database = { execute: async () => rows } as unknown as Parameters<typeof requireOperationalFinance>[0];
    await expect(requireOperationalFinance(database)).rejects.toBeInstanceOf(FinancialRecoveryPendingError);
  }
  const database = { execute: async () => [{ recovery: false }] } as unknown as Parameters<typeof requireOperationalFinance>[0];
  await requireOperationalFinance(database);
  const app = new Hono().onError(apiErrorHandler);
  app.get('/fixture', () => { throw new FinancialRecoveryPendingError(); });
  const response = await app.request('/fixture');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'stripe_recovery_review_pending', retryable: false });
});
