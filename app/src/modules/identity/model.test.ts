import { expect, test } from 'bun:test';
import { principalResult, tokenHash, type Principal } from './model';

const linked: Principal = { subject: 'synthetic-user', auth_email: 'member@example.test', email_verified: true, name: 'Member',
  person_id: '7', public_id: '51f8d415-0f6c-40b9-9544-f553f8c247c6', person_email: 'MEMBER@example.test', person_status: 'pending',
  blacklisted: false, user_id: 'synthetic-user', is_admin: false };
test('read authority is the subject binding, verified email and stable public ID, never a supplied email', () => {
  expect(principalResult(linked)).toMatchObject({ status: 'existing', personId: '7', email: 'MEMBER@example.test' });
  expect(principalResult({ ...linked, email_verified: false }).status).toBe('verification_required');
  for (const update of [{ public_id: null }, { user_id: 'other' }, { person_email: 'other@example.test' }, { blacklisted: true }, { person_status: 'banned' }, { person_status: 'suspended' }, { person_status: 'deleted' }]) {
    expect(principalResult({ ...linked, ...update }).status).toBe('quarantined');
  }
  expect(principalResult({ ...linked, person_id: null }).status).toBe('claim_required');
  expect(principalResult(undefined).status).toBe('quarantined');
});
test('approval tokens are hashed, never persisted or returned by identity lookups', () => {
  const token = 'a'.repeat(64);
  expect(tokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
  expect(tokenHash(token)).not.toBe(token);
  expect(Object.keys(principalResult(linked))).not.toContain('token');
});
