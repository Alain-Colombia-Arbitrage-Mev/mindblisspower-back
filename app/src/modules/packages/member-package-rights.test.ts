import { expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from '../identity/model';
import { readMemberPackageRights } from './member-package-rights';

const principal = { subject: 'synthetic-rights-owner', nativeSessionId: 'synthetic-native-session' };
const environment = { MEMBER_PACKAGE_RIGHTS_ENABLED: 'true' };
const boughtAt = '2025-08-12T15:30:00Z', recognizedAt = '2026-11-15T15:30:00Z';
const item = { id: '11111111-1111-4111-8111-111111111111', packageName: 'Synthetic historical package', sourcePackageId: '51001', packageBaseUsd: '100.00',
  boughtAt, recognizedAt, status: 'active' as const, term: { type: 'until_revoked' as const, startsAt: recognizedAt, endsAt: null }, source: 'stripe_import' as const };
const rights: Awaited<ReturnType<typeof readMemberPackageRights>> = { rightsOnly: true, economicActivation: false, roiEnabled: false,
  commissionsEnabled: false, policy: 'historical_membership_access_until_revoked_v1', totalCount: 1, activeCount: 1, items: [item] };
const database = (execute: (query: SQL) => Promise<unknown[]>) => ({ execute } as unknown as Pick<IdentityDatabase, 'execute'>);

test('rights projection uses only native owner/session, preserves historical purchase date and grants no economic activation', async () => {
  let calls = 0;
  const db = database(async query => {
    calls++; const q = new PgDialect().sqlToQuery(query);
    expect(q.sql).toContain('SELECT payments.read_member_package_rights'); expect(q.params).toEqual([principal.subject, principal.nativeSessionId]);
    expect(q.sql).not.toMatch(/INSERT|UPDATE|DELETE|affiliate_package|investment_cd|wallet_movement|tree_event/); return [{ rights }];
  });
  const result = await readMemberPackageRights(db, principal, { environment });
  expect(result).toEqual(rights); expect(result.items[0]!.boughtAt).toBe(boughtAt);
  expect(result.items[0]!.term.startsAt).toBe(recognizedAt); expect(result.items[0]!.term.endsAt).toBeNull();
  expect(result).not.toHaveProperty('active_packages'); expect(result).not.toHaveProperty('financial_status'); expect(calls).toBe(1);
});

test('empty rights and suspended/revoked/review states are explicit; only active rights count as access', async () => {
  expect(await readMemberPackageRights(database(async () => [{ rights: { ...rights, totalCount: 0, activeCount: 0, items: [] } }]), principal, { environment }))
    .toEqual({ ...rights, totalCount: 0, activeCount: 0, items: [] });
  const limited = { ...rights, totalCount: 101, activeCount: 101 };
  expect(await readMemberPackageRights(database(async () => [{ rights: limited }]), principal, { environment })).toEqual(limited);
  for (const status of ['suspended', 'revoked', 'review_required'] as const) {
    const value = { ...rights, activeCount: 0, items: [{ ...item, status }] };
    expect(await readMemberPackageRights(database(async () => [{ rights: value }]), principal, { environment })).toEqual(value);
  }
});

test('disabled feature, owner selectors and already-aborted calls perform no SQL', async () => {
  let calls = 0; const db = database(async () => { calls++; return [{ rights }]; });
  for (const flag of [undefined, '', 'false', 'TRUE']) {
    await expect(readMemberPackageRights(db, principal, { environment: { MEMBER_PACKAGE_RIGHTS_ENABLED: flag } })).rejects.toThrow('member_package_rights_unconfigured');
  }
  for (const invalid of [{ ...principal, subject: '' }, { ...principal, subject: 'owner other' }, { ...principal, nativeSessionId: '' },
    { ...principal, subject: 'owner\nother' }, { ...principal, email: 'foreign@example.invalid' }, { ...principal, personId: 42 }]) {
    await expect(readMemberPackageRights(db, invalid, { environment })).rejects.toBeInstanceOf(Error);
  }
  const controller = new AbortController(); controller.abort();
  await expect(readMemberPackageRights(db, principal, { environment, signal: controller.signal })).rejects.toThrow('member_package_rights_unavailable');
  expect(calls).toBe(0);
});

test('strict rights boundary rejects financial unlocks, private identifiers and inconsistent access/terms', async () => {
  const invalid = [null, { ...rights, rightsOnly: false }, { ...rights, economicActivation: true }, { ...rights, roiEnabled: true },
    { ...rights, commissionsEnabled: true }, { ...rights, economicActivation: undefined }, { ...rights, active_packages: 1 },
    { ...rights, balance: '100' }, { ...rights, person_id: 42 }, { ...rights, activeCount: 0 }, { ...rights, totalCount: 0 },
    { ...rights, totalCount: undefined }, { ...rights, totalCount: 734, activeCount: 734 }, { ...rights, totalCount: 1, activeCount: 2 },
    { ...rights, policy: 'operational' }, { ...rights, totalCount: 2, items: [item, item], activeCount: 2 },
    { ...rights, items: [{ ...item, status: 'revoked' }] },
    ...[{ ...item, paymentIntentId: 'pi_private' }, { ...item, email: 'private@example.invalid' }, { ...item, personId: 42 },
      { ...item, status: 'paid' }, { ...item, source: 'manual' }, { ...item, id: 'not-a-uuid' }, { ...item, boughtAt: 'not-a-date' },
      { ...item, packageName: 'Synthetic\nPrivate' }, { ...item, packageName: 'A'.repeat(241) },
      { ...item, term: { ...item.term, endsAt: recognizedAt } }, { ...item, term: { ...item.term, startsAt: boughtAt } },
      { ...item, term: { ...item.term, type: 'perpetual' } },
      ...['0', '-1', '01', '1.5', '9'.repeat(20)].map(sourcePackageId => ({ ...item, sourcePackageId })),
      ...['0.00', '-100.00', '100', '100.0', '1e2', '0100.00'].map(packageBaseUsd => ({ ...item, packageBaseUsd }))]
      .map(value => ({ ...rights, items: [value] })),
    { ...rights, totalCount: 101, activeCount: 101, items: Array.from({ length: 101 }, (_, index) => ({ ...item, id: `${(index + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111` })) }];
  for (const value of invalid) {
    await expect(readMemberPackageRights(database(async () => [{ rights: value }]), principal, { environment })).rejects.toThrow('member_package_rights_unavailable');
  }
  for (const rows of [[], [{ rights }, { rights }], [{ context: rights }]]) {
    await expect(readMemberPackageRights(database(async () => rows), principal, { environment })).rejects.toThrow('member_package_rights_unavailable');
  }
});

test('four concurrent reads are bounded, failures release exactly one slot and another owner remains isolated', async () => {
  const pending: { resolve: (value: unknown[]) => void; reject: (error: Error) => void }[] = [];
  const db = database(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const options = { environment, now: () => 1000 };
  const reads = Array.from({ length: 4 }, () => readMemberPackageRights(db, principal, options)); await Promise.resolve();
  await expect(readMemberPackageRights(db, principal, options)).rejects.toThrow('member_package_rights_rate_limited'); expect(pending).toHaveLength(4);
  const failure = reads[0]!.catch(error => error); pending[0]!.reject(Error('synthetic failure')); expect((await failure).message).toBe('synthetic failure');
  const replacement = readMemberPackageRights(db, principal, options), foreign = readMemberPackageRights(db, { ...principal, subject: 'synthetic-other-owner' }, options);
  await Promise.resolve(); expect(pending).toHaveLength(6);
  await expect(readMemberPackageRights(db, principal, options)).rejects.toThrow('member_package_rights_rate_limited');
  pending.slice(1).forEach(value => value.resolve([{ rights }])); expect(await Promise.all([...reads.slice(1), replacement, foreign])).toHaveLength(5);
});

test('minute budget survives native session rotation, resets on expiry and a deadline never retries a stalled read', async () => {
  let calls = 0; const db = database(async () => { calls++; return [{ rights }]; });
  for (let i = 0; i < 60; i++) await readMemberPackageRights(db, { ...principal, nativeSessionId: `synthetic-session-${i}` }, { environment, now: () => 1000 });
  await expect(readMemberPackageRights(db, principal, { environment, now: () => 1001 })).rejects.toThrow('member_package_rights_rate_limited');
  await readMemberPackageRights(db, principal, { environment, now: () => 61000 }); expect(calls).toBe(61);
  let stalledCalls = 0;
  await expect(readMemberPackageRights(database(async () => { stalledCalls++; return new Promise(() => {}); }), principal, { environment, timeoutMs: 20 }))
    .rejects.toThrow('member_package_rights_unavailable'); expect(stalledCalls).toBe(1);
});
