import type { GenericEndpointContext } from '@better-auth/core';
import { APIError } from 'better-auth/api';
import { otpHash } from './phone-otp';

export type RecoveryBudgetKind = 'request' | 'validation';
export const RECOVERY_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_DAILY_LIMITS = { request: 5, validation: 10 } as const;
export const recoveryBudgetKey = (secret: string, recipient: string, kind: RecoveryBudgetKind) =>
  `auth-recovery-${kind}:${otpHash(secret, 'recovery-daily', `${kind}\0${recipient.trim().toLowerCase()}`)}`;
export const isRecoveryBudgetKey = (value: unknown): value is string =>
  typeof value === 'string' && /^auth-recovery-(request|validation):[a-f0-9]{64}$/.test(value);

// The PostgreSQL adapter throws this ONLY after ON CONFLICT(id) DO NOTHING
// returned no row. Unlike catching a unique violation, the enclosing reset
// transaction is still usable. Other database errors must never authorize retry.
export class RecoveryBudgetConflict extends Error {}

type BudgetRow = { id: string; identifier: string; value: string; expiresAt: Date };
const unavailable = () => new APIError('SERVICE_UNAVAILABLE', {
  code: 'PASSWORD_RECOVERY_BUDGET_UNAVAILABLE', message: 'Password recovery temporarily unavailable',
});
function timestamp(clock: () => number) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - RECOVERY_DAILY_WINDOW_MS) throw unavailable();
  return now;
}
async function read(ctx: GenericEndpointContext, key: string, limit: number) {
  try {
    const row = await ctx.context.adapter.findOne<BudgetRow>({ model: 'verification', where: [{ field: 'id', value: key }] });
    if (!row) return null;
    const events: unknown = JSON.parse(row.value);
    if (row.id !== key || row.identifier !== key || !Array.isArray(events) || !events.length || events.length > limit
      || !events.every((value, index) => Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - RECOVERY_DAILY_WINDOW_MS
        && (index === 0 || value >= events[index - 1]))
      || !(row.expiresAt instanceof Date) || row.expiresAt.getTime() !== events.at(-1) + RECOVERY_DAILY_WINDOW_MS) throw unavailable();
    return { row, events: events as number[] };
  } catch { throw unavailable(); }
}
function activeEvents(events: number[], now: number) {
  return events.filter(value => value > now - RECOVERY_DAILY_WINDOW_MS);
}
function requireRoom(events: number[], limit: number, now: number) {
  if (events.length >= limit) throw new APIError('TOO_MANY_REQUESTS', {
    code: 'PASSWORD_RECOVERY_DAILY_LIMIT', message: 'Daily password recovery limit reached. Wait before trying again.',
  }, { 'Retry-After': String(Math.max(1, Math.ceil((events[0]! + RECOVERY_DAILY_WINDOW_MS - now) / 1000))) });
}

/** A read-only precheck keeps an already exhausted recovery quota from reserving
 * the shared email cooldown. The later atomic reservation remains authoritative. */
export async function checkRecoveryBudget(secret: string, recipient: string, kind: RecoveryBudgetKind,
  ctx: GenericEndpointContext, clock: () => number = Date.now) {
  const current = await read(ctx, recoveryBudgetKey(secret, recipient, kind), RECOVERY_DAILY_LIMITS[kind]);
  if (current) {
    const now = timestamp(clock);
    requireRoom(activeEvents(current.events, now), RECOVERY_DAILY_LIMITS[kind], now);
  }
}

/** Exactly the last 24 hours, not a fixed window that permits two bursts at its
 * boundary. Two bounded HMAC-keyed verification rows per recipient suffice;
 * neither plaintext addresses nor OTPs are stored here. Native expiry cleanup
 * may remove a row only once its newest event is outside the entire window.
 */
export async function consumeRecoveryBudget(secret: string, recipient: string, kind: RecoveryBudgetKind,
  ctx: GenericEndpointContext, clock: () => number = Date.now) {
  const key = recoveryBudgetKey(secret, recipient, kind);
  const limit = RECOVERY_DAILY_LIMITS[kind];
  for (let step = 0; step < limit + 3; step++) {
    const current = await read(ctx, key, limit);
    const now = timestamp(clock);
    const active = activeEvents(current?.events || [], now);
    requireRoom(active, limit, now);
    // Concurrent instances can have slight clock skew; never move an event or
    // expiry backwards. Refresh the clock and snapshot on every lost CAS.
    const at = Math.max(now, active.at(-1) ?? now);
    const value = JSON.stringify([...active, at]);
    const expiresAt = new Date(at + RECOVERY_DAILY_WINDOW_MS);
    if (!current) {
      try {
        const data = { id: key, identifier: key, value, expiresAt, createdAt: new Date(at), updatedAt: new Date(at) };
        const created = await ctx.context.adapter.create<BudgetRow>({ model: 'verification', forceAllowId: true,
          data });
        if (!created || created.id !== key || created.value !== value || created.expiresAt.getTime() !== expiresAt.getTime()) throw unavailable();
        return;
      } catch (error) {
        if (error instanceof RecoveryBudgetConflict) continue;
        throw unavailable();
      }
    }
    try {
      const updated = await ctx.context.adapter.incrementOne<BudgetRow>({ model: 'verification', where: [
        { field: 'id', value: key }, { field: 'value', value: current.row.value }, { field: 'expiresAt', value: current.row.expiresAt },
      ], increment: {}, set: { value, expiresAt, updatedAt: new Date(at) } });
      if (!updated) continue;
      if (updated.id !== key || updated.value !== value || updated.expiresAt.getTime() !== expiresAt.getTime()) throw unavailable();
      return;
    } catch { throw unavailable(); }
  }
  throw unavailable();
}
