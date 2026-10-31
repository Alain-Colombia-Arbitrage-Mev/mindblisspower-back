import { expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { postgresAuthAdapter } from './postgres-auth-adapter';
import * as schema from '../db/schema/auth';

function fixture(rows: Record<string, unknown>[] = [{ id: 'synthetic-row', count: 5 }]) {
  const builder = drizzle.mock({ schema });
  const statements: { sql: string; params: unknown[] }[] = [];
  const database = { delete(table: PgTable) {
    return { where(condition: SQL) {
      statements.push(builder.delete(table).where(condition).toSQL());
      return Promise.resolve({ rowCount: rows.length });
    } };
  }, update(table: PgTable) {
    return { set(assignments: Record<string, unknown>) {
      return { where(condition: SQL) {
        return { async returning() {
          statements.push(builder.update(table).set(assignments).where(condition).returning().toSQL());
          return rows;
        } };
      } };
    } };
  } } as unknown as Parameters<typeof postgresAuthAdapter>[0];
  const adapter = postgresAuthAdapter(database)({});
  return { adapter, statements };
}

test('guarded PostgreSQL counter uses one direct UPDATE with all outer CAS predicates and parameters', async () => {
  const app = fixture(); const secretKey = "synthetic-key-' OR true; --";
  expect(await app.adapter.incrementOne({ model: 'rateLimit', where: [
    { field: 'key', value: secretKey }, { field: 'count', operator: 'lt', value: 5 },
    { field: 'lastRequest', operator: 'gt', value: 100 },
  ], increment: { count: 1 }, set: { lastRequest: 200 } })).toMatchObject({ count: 5 });
  expect(app.statements).toHaveLength(1);
  const query = app.statements[0]!;
  expect(query.sql).toStartWith('update "auth"."rate_limit" set ');
  expect(query.sql.toLowerCase()).not.toContain('select');
  expect(query.sql.toLowerCase()).not.toContain(' in (');
  expect(query.sql).toContain('"key" ='); expect(query.sql).toContain('"count" <'); expect(query.sql).toContain('"last_request" >');
  expect(query.sql).not.toContain(secretKey);
  expect(query.params).toContain(secretKey); expect(query.params).toContain(5); expect(query.params).toContain(100);
});

test('confirmed delivery rejection deletes only the parameterized purpose and HMAC generation with all guards on the outer PostgreSQL DELETE', async () => {
  const app = fixture();
  const identifier = "email-verification-otp-synthetic-' OR true; --@example.test";
  const values = [0, 1, 2, 3].map(attempt => `${'a'.repeat(64)}:${attempt}`);
  expect(await app.adapter.deleteMany({ model: 'verification', where: [
    { field: 'identifier', value: identifier }, { field: 'value', operator: 'in', value: values },
  ] })).toBe(1);
  expect(app.statements).toHaveLength(1);
  const query = app.statements[0]!;
  expect(query.sql).toStartWith('delete from "auth"."verification" where ');
  expect(query.sql).toContain('"identifier" =');
  expect(query.sql).toContain('"value" in (');
  expect(query.sql).toContain(' and ');
  expect(query.sql.toLowerCase()).not.toContain('select');
  expect(query.sql.toLowerCase()).not.toContain(' like ');
  expect(query.sql).not.toContain(identifier);
  for (const value of values) expect(query.sql).not.toContain(value);
  expect(query.params).toEqual([identifier, ...values]);
});

test('OTP attempt CAS preserves value and expiry guards on the outer UPDATE', async () => {
  const app = fixture([]); const deadline = new Date();
  expect(await app.adapter.incrementOne({ model: 'verification', where: [
    { field: 'id', value: 'challenge-id' }, { field: 'value', value: 'h1_synthetic:0' },
    { field: 'expiresAt', operator: 'gt', value: deadline },
  ], increment: {}, set: { value: 'h1_synthetic:1' } })).toBeNull();
  const query = app.statements[0]!;
  expect(query.sql).toStartWith('update "auth"."verification" set ');
  expect(query.sql.toLowerCase()).not.toContain('select');
  expect(query.sql).toContain('"id" ='); expect(query.sql).toContain('"value" ='); expect(query.sql).toContain('"expires_at" >');
  expect(query.params).toContain(deadline.toISOString());
});

test('transaction:false callbacks keep the guarded adapter without opening a transaction or escaping to the base adapter', async () => {
  const app = fixture();
  expect(app.adapter.options?.adapterConfig.transaction).toBe(false);
  await app.adapter.transaction(async tx => {
    expect(tx).toBe(app.adapter);
    return tx.incrementOne({ model: 'rateLimit', where: [{ field: 'key', value: 'budget' }, { field: 'count', operator: 'lt', value: 5 }], increment: { count: 1 } });
  });
  expect(app.statements).toHaveLength(1);
  expect(app.statements[0]!.sql.toLowerCase()).not.toContain('select');
});

test('guarded mutations reject missing unique anchors, unknown identifiers, unsupported operators and unsafe assignments without SQL', async () => {
  const app = fixture();
  const cases: Parameters<typeof app.adapter.incrementOne>[0][] = [
    { model: 'rateLimit', where: [{ field: 'count', operator: 'lt' as const, value: 5 }], increment: { count: 1 } },
    { model: 'rateLimit', where: [{ field: 'key', value: 'budget', connector: 'OR' as const }], increment: { count: 1 } },
    { model: 'rateLimit', where: [{ field: 'key', value: 'budget', mode: 'insensitive' as const }], increment: { count: 1 } },
    { model: 'rateLimit', where: [{ field: 'key', value: 'budget' }, { field: 'not_a_column', value: 1 }], increment: { count: 1 } },
    { model: 'rateLimit', where: [{ field: 'key', value: 'budget', operator: 'contains' as const }], increment: { count: 1 } },
    { model: 'rateLimit', where: [{ field: 'key', value: 'budget' }], increment: { count: Number.NaN } },
    { model: 'rateLimit', where: [{ field: 'key', value: 'budget' }], increment: {}, set: { key: 'changed-key' } },
    { model: 'rateLimit', where: [{ field: 'key', value: 'budget' }], increment: { count: 1 }, set: { count: 9 } },
    { model: 'verification', where: [{ field: 'id', value: 'challenge' }], increment: {}, set: { expiresAt: 'not-a-date' } },
  ];
  for (const input of cases) await expect(app.adapter.incrementOne(input)).rejects.toThrow('Unsupported guarded authentication mutation');
  expect(app.statements).toHaveLength(0);
});
