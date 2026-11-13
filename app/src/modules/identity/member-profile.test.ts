import { expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from './model';
import { memberProfileUpdateInput, readMemberProfile, updateMemberProfile } from './member-profile';

const principal = { subject: 'synthetic-profile-owner', nativeSessionId: 'synthetic-native-session' };
const environment = { MEMBER_PROFILE_ENABLED: 'true' };
const current = { first_name: 'Synthetic', last_name: 'Owner', phone: '2223334444', country: 'Legacy country', payout_wallet_usdc: '0x' + '1'.repeat(40),
  sponsor_name: 'Synthetic Sponsor', sponsor_referral_code: 'SYNTHETIC', referral_code: 'OWN-SYNTHETIC' };
const database = (execute: (query: SQL) => Promise<unknown[]>) => ({ execute } as unknown as Pick<IdentityDatabase, 'execute'>);
const patch = { name: 'Marina del Río', phone: '+12025550123' };

test('profile reads use only native subject/session SQL parameters and preserve private legacy projection without auth contacts', async () => {
  const queries: unknown[] = [];
  const db = database(async query => { const q = new PgDialect().sqlToQuery(query); queries.push(q);
    expect(q.sql).toContain('identity.read_member_profile'); expect(q.params).toEqual([principal.subject, principal.nativeSessionId]);
    return [{ ...current, auth_contact_phone: 'private', email: 'must-not-project', user_id: 'other' }]; });
  expect(await readMemberProfile(db, principal, { environment })).toEqual(current); expect(queries).toHaveLength(1);
});

test('profile strict patch normalizes legal names, accepts international contacts and preserves omitted country by SQL null', async () => {
  for (const name of ['Marina del Río', 'عائشة عبدالله', '李 小龍', 'O’Connor', 'Single']) {
    expect(memberProfileUpdateInput.parse({ ...patch, name }).name).toBe(name);
  }
  expect(memberProfileUpdateInput.parse({ ...patch, name: '  Marina   del Ri\u0301o  ' }).name).toBe(patch.name);
  let count = 0;
  const db = database(async query => { const q = new PgDialect().sqlToQuery(query); count++;
    expect(q.sql).toContain('identity.update_member_profile');
    expect(q.params).toEqual([principal.subject, principal.nativeSessionId, patch.name, patch.phone, null]);
    return [{ ...current, first_name: 'Marina', last_name: 'del Río', phone: patch.phone }]; });
  expect(await updateMemberProfile(db, { ...patch, name: '  Marina   del Ri\u0301o ' }, principal, { environment }))
    .toEqual({ ok: true, profile: { ...current, first_name: 'Marina', last_name: 'del Río', phone: patch.phone } });
  expect(count).toBe(1);
});

test('explicit country changes/clear and phone clear are distinct from omission; single-token name is not duplicated', async () => {
  const db = database(async query => { const { params } = new PgDialect().sqlToQuery(query);
    return [{ ...current, first_name: 'Single', last_name: '', phone: params[3], country: params[4] }]; });
  for (const country of ['CO', 'US', 'MX', '']) {
    const outcome = await updateMemberProfile(db, { name: 'Single', phone: '', country }, principal, { environment });
    expect(outcome.profile.country).toBe(country); expect(outcome.profile.phone).toBe(''); expect(outcome.profile.last_name).toBe('');
  }
});

test('profile edits cannot inject identity, wallet, verified phone or other owner fields and reject invalid legal/contact input before SQL', async () => {
  let calls = 0; const db = database(async () => { calls++; return [current]; });
  for (const field of ['email', 'subject', 'nativeSessionId', 'userId', 'role', 'payout_wallet_usdc', 'phoneNumberVerified', 'contactWhatsapp', 'sponsor_name', 'sponsor_referral_code', 'referral_code']) {
    await expect(updateMemberProfile(db, { ...patch, [field]: 'forged' }, principal, { environment })).rejects.toBeInstanceOf(Error);
  }
  for (const value of [null, [], {}, { name: patch.name }, { phone: patch.phone }, { ...patch, country: null }, { ...patch, country: 'Colombia' },
    { ...patch, country: 'co' }, { ...patch, name: '<script>' }, { ...patch, name: '---' }, { ...patch, name: '\u0301' },
    { ...patch, name: 'Marina\nOther' }, { ...patch, name: 'A'.repeat(161) }, { ...patch, phone: '2025550123' }, { ...patch, phone: '+012345678' },
    { ...patch, phone: '+123456' }, { ...patch, phone: '+12025550123\n' }]) {
    await expect(updateMemberProfile(db, value, principal, { environment })).rejects.toBeInstanceOf(Error);
  }
  expect(calls).toBe(0);
});

test('unconfigured/aborted profile requests perform zero SQL and no successful ACK is emitted for mismatched or malformed persistence', async () => {
  let calls = 0; const db = database(async () => { calls++; return [current]; });
  await expect(readMemberProfile(db, principal, { environment: {} })).rejects.toThrow('member_profile_unconfigured');
  await expect(updateMemberProfile(db, patch, principal, { environment: {} })).rejects.toThrow('member_profile_unconfigured');
  const controller = new AbortController(); controller.abort();
  await expect(updateMemberProfile(db, patch, principal, { environment, signal: controller.signal })).rejects.toThrow('member_profile_unavailable');
  expect(calls).toBe(0);
  await expect(updateMemberProfile(db, patch, principal, { environment })).rejects.toThrow('member_profile_outcome_unconfirmed');
  await expect(readMemberProfile(database(async () => []), principal, { environment })).rejects.toThrow('member_profile_not_found');
  await expect(readMemberProfile(database(async () => [{ ...current, phone: null }]), principal, { environment })).rejects.toThrow('member_profile_unavailable');
  await expect(readMemberProfile(database(async () => [current, current]), principal, { environment })).rejects.toThrow('member_profile_unavailable');
});

test('profile concurrent writes and per-owner rate gates reject before SQL; stalled write has a deadline and is never retried', async () => {
  let calls = 0; const never = database(async () => { calls++; return new Promise(() => {}); });
  const first = updateMemberProfile(never, patch, principal, { environment, timeoutMs: 20 });
  await expect(updateMemberProfile(never, patch, principal, { environment, timeoutMs: 20 })).rejects.toThrow('member_profile_rate_limited');
  await expect(first).rejects.toThrow('member_profile_unavailable'); expect(calls).toBe(1);
  let writes = 0;
  const db = database(async () => { writes++; return [{ ...current, first_name: 'Marina', last_name: 'del Río', phone: patch.phone }]; });
  for (let n = 0; n < 20; n++) await updateMemberProfile(db, patch, { ...principal, nativeSessionId: 'session-' + n }, { environment, now: () => 1000 });
  await expect(updateMemberProfile(db, patch, { ...principal, nativeSessionId: 'another-session' }, { environment, now: () => 1001 })).rejects.toThrow('member_profile_rate_limited');
  expect(writes).toBe(20);
});
