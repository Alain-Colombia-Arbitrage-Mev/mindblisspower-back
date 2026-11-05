import { expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { principal, principalResult, tokenHash, type Principal, type IdentityDatabase } from './model';

const linked: Principal = { subject: 'synthetic-user', auth_email: 'member@example.test', email_verified: true, name: 'Member',
  person_id: '7', public_id: '51f8d415-0f6c-40b9-9544-f553f8c247c6', person_email: 'MEMBER@example.test', person_status: 'pending',
  blacklisted: false, user_id: 'synthetic-user', is_admin: false, access_restricted: false };
test('read authority is the subject binding, verified email and stable public ID, never a supplied email', () => {
  expect(principalResult(linked)).toMatchObject({ status: 'existing', personId: '7', email: 'MEMBER@example.test' });
  expect(principalResult({ ...linked, email_verified: false }).status).toBe('verification_required');
  for (const update of [{ public_id: null }, { user_id: 'other' }, { person_email: 'other@example.test' }, { blacklisted: true },
    { access_restricted: true }, { access_restricted: null }, { access_restricted: undefined },
    { person_status: 'banned' }, { person_status: 'suspended' }, { person_status: 'deleted' }]) {
    expect(principalResult({ ...linked, ...update } as Principal).status).toBe('quarantined');
  }
  expect(principalResult({ ...linked, person_id: null }).status).toBe('claim_required');
  expect(principalResult(undefined).status).toBe('quarantined');
});
test('a fresh read includes affiliate and null-safe blacklist restrictions with a parameterized subject and no mutation', async () => {
  const subject = "synthetic' OR true --";
  const statements: { sql: string; params: unknown[] }[] = [];
  const database = { execute: async (query: SQL) => {
    statements.push(new PgDialect().sqlToQuery(query)); return [linked];
  } } as unknown as Pick<IdentityDatabase, 'execute'>;
  expect(await principal(database, subject)).toEqual(linked);
  expect(statements).toHaveLength(1);
  expect(statements[0]!.params).toEqual([subject]);
  const text = statements[0]!.sql;
  expect(text).not.toContain(subject);
  for (const fragment of ['FROM mlm.affiliate a WHERE a.person_id=p.id', "a.status::text IN ('suspended','banned','deleted')",
    'FROM mlm.blacklist b', 'mlm.norm_email(p.email) IS NOT NULL', 'mlm.norm_phone10(p.phone_number) IS NOT NULL',
    "mlm.norm_name(p.first_name || ' ' || p.last_name) IS NOT NULL", 'b.birthdate IS NULL', 'p.birthday IS NOT NULL AND b.birthdate=p.birthday',
    'AS access_restricted']) expect(text).toContain(fragment);
  expect(text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/);
});
test('approval tokens are hashed, never persisted or returned by identity lookups', () => {
  const token = 'a'.repeat(64);
  expect(tokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
  expect(tokenHash(token)).not.toBe(token);
  expect(Object.keys(principalResult(linked))).not.toContain('token');
});
