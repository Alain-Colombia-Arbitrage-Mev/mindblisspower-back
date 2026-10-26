import { and, eq, gt, gte, lt, lte, ne, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DBAdapter, Where } from '@better-auth/core/db/adapter';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { authDb } from '../db/auth-client';
import * as schema from '../db/schema/auth';

type Kind = 'string' | 'number' | 'date';
type GuardedModel = {
  table: typeof schema.verification | typeof schema.rateLimit;
  fields: Record<string, { column: AnyPgColumn; kind: Kind }>;
  mutable: ReadonlySet<string>;
};
const guardedModels: Record<string, GuardedModel> = {
  verification: { table: schema.verification, mutable: new Set(['value', 'expiresAt', 'updatedAt']), fields: {
    id: { column: schema.verification.id, kind: 'string' }, identifier: { column: schema.verification.identifier, kind: 'string' },
    value: { column: schema.verification.value, kind: 'string' }, expiresAt: { column: schema.verification.expiresAt, kind: 'date' },
    createdAt: { column: schema.verification.createdAt, kind: 'date' }, updatedAt: { column: schema.verification.updatedAt, kind: 'date' },
  } },
  rateLimit: { table: schema.rateLimit, mutable: new Set(['count', 'lastRequest']), fields: {
    id: { column: schema.rateLimit.id, kind: 'string' }, key: { column: schema.rateLimit.key, kind: 'string' },
    count: { column: schema.rateLimit.count, kind: 'number' }, lastRequest: { column: schema.rateLimit.lastRequest, kind: 'number' },
  } },
};
const unsupported = () => new Error('Unsupported guarded authentication mutation');
function validate(kind: Kind, value: unknown) {
  if (kind === 'string' ? typeof value !== 'string'
    : kind === 'number' ? !Number.isSafeInteger(value)
      : !(value instanceof Date) || !Number.isFinite(value.getTime())) throw unsupported();
}
function predicate(record: GuardedModel, where: Where): SQL {
  const field = record.fields[where.field];
  if (!field || (where.connector && where.connector !== 'AND') || (where.mode && where.mode !== 'sensitive')) throw unsupported();
  validate(field.kind, where.value);
  switch (where.operator || 'eq') {
    case 'eq': return eq(field.column, where.value);
    case 'ne': return ne(field.column, where.value);
    case 'lt': return lt(field.column, where.value);
    case 'lte': return lte(field.column, where.value);
    case 'gt': return gt(field.column, where.value);
    case 'gte': return gte(field.column, where.value);
    default: throw unsupported();
  }
}

/**
 * Better Auth 1.6.22's Drizzle incrementOne uses UPDATE ... WHERE id IN
 * (SELECT id WHERE guards). Under PostgreSQL READ COMMITTED, a waiting UPDATE
 * can reuse that snapshot's id after a competing update changed the guards.
 * Keep EVERY CAS predicate on the outer UPDATE so PostgreSQL rechecks it after
 * acquiring the row lock. Identifiers come only from this fixed schema, all
 * values are Drizzle parameters, and a unique id/key anchor limits it to one row.
 */
export function postgresAuthAdapter(database: typeof authDb) {
  const factory = drizzleAdapter(database, { provider: 'pg', schema, usePlural: false, transaction: false });
  return (options: Parameters<typeof factory>[0]): DBAdapter => {
    const base = factory(options);
    const wrapped: DBAdapter = { ...base,
      incrementOne: async <T>(input: Parameters<DBAdapter['incrementOne']>[0]): Promise<T | null> => {
        const record = Object.hasOwn(guardedModels, input.model) ? guardedModels[input.model]! : null;
        if (!record) return base.incrementOne<T>(input);
        if (!input.where.some(condition => (condition.field === 'id' || (input.model === 'rateLimit' && condition.field === 'key'))
          && (!condition.operator || condition.operator === 'eq') && typeof condition.value === 'string' && condition.value.length > 0)) throw unsupported();
        const assignments: Record<string, string | number | Date | SQL> = {};
        for (const [name, delta] of Object.entries(input.increment)) {
          const field = record.fields[name];
          if (!field || !record.mutable.has(name) || field.kind !== 'number' || !Number.isSafeInteger(delta)) throw unsupported();
          assignments[name] = sql`${field.column} + ${delta}`;
        }
        for (const [name, value] of Object.entries(input.set || {})) {
          const field = record.fields[name];
          if (!field || !record.mutable.has(name) || Object.hasOwn(assignments, name)) throw unsupported();
          validate(field.kind, value);
          assignments[name] = value as string | number | Date;
        }
        if (!Object.keys(assignments).length) throw unsupported();
        const result = await database.update(record.table).set(assignments).where(and(...input.where.map(condition => predicate(record, condition)))).returning();
        return (result[0] ?? null) as T | null;
      },
      // The existing adapter explicitly has transaction:false. Preserve its
      // sequential semantics, but give callbacks the guarded adapter rather
      // than the original factory's unguarded instance. Do NOT enable a global
      // transaction: identity hooks use a separately bounded authDb connection.
      transaction: async callback => callback(wrapped),
    };
    return wrapped;
  };
}
