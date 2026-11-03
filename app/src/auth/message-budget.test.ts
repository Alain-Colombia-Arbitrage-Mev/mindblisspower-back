import { expect, test } from 'bun:test';
import type { GenericEndpointContext } from '@better-auth/core';
import { APIError } from 'better-auth/api';
import { limitRecipient, recipientBudgetKey } from './phone-otp';

const secret = 'synthetic-message-budget-secret-at-least-32-characters';
const recipient = 'synthetic-budget@example.test';
const sensitive = new Error('synthetic-private-database-url-and-recipient');
type Row = { lastRequest: number } | null;
function fixture(reads: (Row | Error)[], create: () => Promise<unknown> = async () => { throw sensitive; },
  increment: () => Promise<unknown> = async () => null) {
  const calls: string[] = [];
  const ctx = { context: { adapter: {
    findOne: async ({ where }: { where: { field: string; value: string }[] }) => {
      calls.push('read');
      expect(where).toEqual([{ field: 'key', value: recipientBudgetKey(secret, recipient) }]);
      const row = reads.shift();
      if (row instanceof Error) throw row;
      return row ?? null;
    },
    create: async () => { calls.push('create'); return create(); },
    incrementOne: async () => { calls.push('increment'); return increment(); },
  } } } as unknown as GenericEndpointContext;
  return { ctx, calls };
}
async function failure(ctx: GenericEndpointContext) {
  try { await limitRecipient(secret, recipient, ctx, 300_000); }
  catch (error) { expect(error).toBeInstanceOf(APIError); return error as APIError; }
  throw new Error('Synthetic reservation unexpectedly succeeded');
}
function expectUnavailable(error: APIError) {
  expect(error.statusCode).toBe(503);
  expect(error.body).toEqual({ code: 'AUTH_MESSAGE_BUDGET_UNAVAILABLE', message: 'Authentication temporarily unavailable' });
  expect(new Headers(error.headers).get('Retry-After')).toBeNull();
  expect(JSON.stringify(error.body)).not.toContain('synthetic-private');
  expect(JSON.stringify(error.body)).not.toContain(recipient);
}

test('budget storage read/create/CAS errors are unavailable, not a fabricated five-minute throttle', async () => {
  const fixtures = [fixture([sensitive]), fixture([null, null]),
    fixture([{ lastRequest: Date.now() - 1000 }], undefined, async () => { throw sensitive; })];
  for (const app of fixtures) expectUnavailable(await failure(app.ctx));
  expect(fixtures.map(app => app.calls)).toEqual([['read'], ['read', 'create', 'read'], ['read', 'increment']]);
});

test('a failed create with a concurrent reservation preserves its real deadline and never retries or clears it', async () => {
  const app = fixture([null, { lastRequest: Date.now() + 90_000 }]);
  const error = await failure(app.ctx);
  expect(error.statusCode).toBe(429);
  const wait = Number(new Headers(error.headers).get('Retry-After'));
  expect(wait).toBeGreaterThanOrEqual(89); expect(wait).toBeLessThanOrEqual(90);
  expect(app.calls).toEqual(['read', 'create', 'read']);
});

test('unreadable or aborted transactions after reservation failure do not become a false throttle', async () => {
  const aborted = Object.assign(new Error('synthetic aborted transaction'), { code: '25P02' });
  const app = fixture([null, aborted]);
  expectUnavailable(await failure(app.ctx));
  expect(app.calls).toEqual(['read', 'create', 'read']);
});

test('an expired/missing reservation after failed create is unavailable and cannot permit a send', async () => {
  for (const row of [null, { lastRequest: Date.now() - 1000 }]) {
    const app = fixture([null, row]);
    expectUnavailable(await failure(app.ctx));
    expect(app.calls).toEqual(['read', 'create', 'read']);
  }
});

test('a lost CAS keeps the latest reservation deadline without resetting the budget', async () => {
  const app = fixture([{ lastRequest: Date.now() - 1000 }, { lastRequest: Date.now() + 120_000 }]);
  const error = await failure(app.ctx);
  expect(error.statusCode).toBe(429);
  const wait = Number(new Headers(error.headers).get('Retry-After'));
  expect(wait).toBeGreaterThanOrEqual(119); expect(wait).toBeLessThanOrEqual(120);
  expect(app.calls).toEqual(['read', 'increment', 'read']);
});
