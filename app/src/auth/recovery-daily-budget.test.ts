import { expect, test } from 'bun:test';
import type { GenericEndpointContext } from '@better-auth/core';
import { APIError } from 'better-auth/api';
import { checkRecoveryBudget, consumeRecoveryBudget, isRecoveryBudgetKey, RECOVERY_DAILY_LIMITS,
  RECOVERY_DAILY_WINDOW_MS as day, recoveryBudgetKey, RecoveryBudgetConflict, type RecoveryBudgetKind } from './recovery-daily-budget';

const secret = 'synthetic-daily-recovery-secret-with-thirty-two-characters';
const recipient = 'synthetic-recovery@example.test';
type Row = { id: string; identifier: string; value: string; expiresAt: Date };
function fixture() {
  let now = 1_700_000_000_000;
  const rows = new Map<string, Row>();
  const mutations: { kind: string; input: any }[] = [];
  let fault = '';
  let conflictOnce = false;
  const ctx = { context: { adapter: {
    findOne: async (input: any) => {
      if (fault === 'read') throw new Error('Synthetic private database diagnostics');
      return structuredClone(rows.get(input.where[0].value) ?? null);
    },
    create: async (input: any) => {
      mutations.push({ kind: 'create', input });
      if (fault === 'create') throw Object.assign(new Error('Synthetic private unique or permission failure'), { code: '23505' });
      if (conflictOnce) {
        conflictOnce = false;
        rows.set(input.data.id, structuredClone(input.data));
        throw new RecoveryBudgetConflict();
      }
      if (rows.has(input.data.id)) throw new RecoveryBudgetConflict();
      rows.set(input.data.id, structuredClone(input.data));
      return fault === 'create-ack' ? null : structuredClone(input.data);
    },
    incrementOne: async (input: any) => {
      mutations.push({ kind: 'cas', input });
      if (fault === 'cas') throw new Error('Synthetic private database diagnostics');
      const row = rows.get(input.where[0].value);
      if (!row || fault === 'lost-cas' || input.where.some(({ field, value }: any) =>
        field === 'expiresAt' ? row.expiresAt.getTime() !== value.getTime() : row[field as keyof Row] !== value)) return null;
      const updated = { ...row, ...input.set };
      rows.set(row.id, structuredClone(updated));
      return fault === 'cas-ack' ? { ...structuredClone(updated), value: 'invalid-ack' } : structuredClone(updated);
    },
  } } } as unknown as GenericEndpointContext;
  return { ctx, rows, mutations, clock: () => now, advance: (ms: number) => { now += ms; },
    fail: (value: string) => { fault = value; }, conflict: () => { conflictOnce = true; } };
}
async function apiFailure(work: () => Promise<void>) {
  try { await work(); } catch (error) { expect(error).toBeInstanceOf(APIError); return error as APIError; }
  throw new Error('Synthetic budget unexpectedly authorized a request');
}
const consume = (app: ReturnType<typeof fixture>, kind: RecoveryBudgetKind = 'request', email = recipient) =>
  consumeRecoveryBudget(secret, email, kind, app.ctx, app.clock);

test('daily recovery identifiers are purpose-scoped HMACs, normalized and never plaintext contacts', () => {
  const key = recoveryBudgetKey(secret, recipient, 'request');
  expect(key).toBe(recoveryBudgetKey(secret, ` ${recipient.toUpperCase()} `, 'request'));
  expect(key).not.toContain(recipient);
  expect(isRecoveryBudgetKey(key)).toBe(true);
  expect(isRecoveryBudgetKey(recoveryBudgetKey(secret, recipient, 'validation'))).toBe(true);
  expect(key).not.toBe(recoveryBudgetKey(secret, recipient, 'validation'));
  for (const value of ['auth-recovery-request:invalid', recipient, null, {}, '__proto__']) expect(isRecoveryBudgetKey(value)).toBe(false);
});

for (const kind of ['request', 'validation'] as const) {
  test(`${kind} quota is an exact sliding day, preserves CAS guards and releases only expired attempts`, async () => {
    const app = fixture();
    for (let index = 0; index < RECOVERY_DAILY_LIMITS[kind]; index++) { await consume(app, kind); app.advance(1000); }
    const denied = await apiFailure(() => consume(app, kind, ` ${recipient.toUpperCase()} `));
    expect(denied.statusCode).toBe(429);
    expect(denied.body?.code).toBe('PASSWORD_RECOVERY_DAILY_LIMIT');
    const wait = Number(new Headers(denied.headers).get('Retry-After'));
    expect(wait).toBeGreaterThan(86_380); expect(wait).toBeLessThanOrEqual(86_400);
    app.advance(day - RECOVERY_DAILY_LIMITS[kind] * 1000);
    await consume(app, kind);
    expect((await apiFailure(() => consume(app, kind))).statusCode).toBe(429);
    const row = app.rows.get(recoveryBudgetKey(secret, recipient, kind))!;
    const events = JSON.parse(row.value);
    expect(events).toHaveLength(RECOVERY_DAILY_LIMITS[kind]);
    expect(row.expiresAt.getTime()).toBe(events.at(-1) + day);
    for (const { input } of app.mutations.filter(value => value.kind === 'cas')) {
      expect(input.increment).toEqual({});
      expect(input.where.map((condition: any) => condition.field)).toEqual(['id', 'value', 'expiresAt']);
    }
  });
}

test('read-only precheck cannot spend quota or mutate an exhausted budget; the two purposes remain independent', async () => {
  const app = fixture();
  await checkRecoveryBudget(secret, recipient, 'request', app.ctx, app.clock);
  expect(app.rows.size).toBe(0);
  for (let index = 0; index < 5; index++) await consume(app);
  const before = structuredClone([...app.rows]); const writes = app.mutations.length;
  expect((await apiFailure(() => checkRecoveryBudget(secret, recipient, 'request', app.ctx, app.clock))).statusCode).toBe(429);
  expect([...app.rows]).toEqual(before); expect(app.mutations).toHaveLength(writes);
  await consume(app, 'validation'); expect(app.rows.size).toBe(2);
});

test('only the typed nonaborting insert conflict retries and reserves its own distinct event', async () => {
  const app = fixture(); app.conflict();
  await consume(app);
  expect(JSON.parse(app.rows.values().next().value!.value)).toHaveLength(2);
  expect(app.mutations.map(value => value.kind)).toEqual(['create', 'cas']);
  expect(app.mutations[0]!.input.forceAllowId).toBe(true);
  expect(app.mutations[0]!.input.data.id).toBe(app.mutations[0]!.input.data.identifier);
});

test('clock skew cannot reorder events or shorten the expiry and expired history is bounded', async () => {
  const app = fixture(); await consume(app); app.advance(-10); await consume(app);
  const row = app.rows.values().next().value!;
  expect(JSON.parse(row.value)).toEqual([1_700_000_000_000, 1_700_000_000_000]);
  app.advance(day + 11); await consume(app);
  expect(JSON.parse(app.rows.values().next().value!.value)).toHaveLength(1);
});

test('storage failures and malformed acknowledgements fail closed without exposing contacts or fabricated throttling', async () => {
  for (const fault of ['read', 'create', 'create-ack', 'cas', 'lost-cas', 'cas-ack']) {
    const app = fixture();
    if (['cas', 'lost-cas', 'cas-ack'].includes(fault)) await consume(app);
    app.fail(fault);
    const failure = await apiFailure(() => consume(app));
    expect(failure.statusCode).toBe(503);
    expect(failure.body?.code).toBe('PASSWORD_RECOVERY_BUDGET_UNAVAILABLE');
    expect(new Headers(failure.headers).has('Retry-After')).toBe(false);
    expect(JSON.stringify(failure.body)).not.toContain(recipient);
    expect(JSON.stringify(failure.body)).not.toContain('Synthetic');
  }
});

test('corrupt quota state cannot reset a daily allowance or be treated as a spent OTP', async () => {
  for (const value of ['not-json', '{}', '[]', '[-1]', '[2,1]', JSON.stringify(Array(6).fill(1))]) {
    const app = fixture(); const key = recoveryBudgetKey(secret, recipient, 'request');
    app.rows.set(key, { id: key, identifier: key, value, expiresAt: new Date(app.clock() + day) });
    expect((await apiFailure(() => consume(app))).statusCode).toBe(503);
    expect(app.mutations).toHaveLength(0);
  }
});
