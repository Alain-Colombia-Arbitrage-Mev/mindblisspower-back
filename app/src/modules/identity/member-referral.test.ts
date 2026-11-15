import { expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from './model';
import { captureMemberReferral, memberReferralCaptureInput, readMemberReferral } from './member-referral';

const principal = { subject: 'synthetic-referral-owner', nativeSessionId: 'synthetic-native-session' };
const environment = { MEMBER_REFERRAL_ENABLED: 'true', REFERRAL_COMPANY_ROOT_AFFILIATE_ID: '50793' };
const id = 'person:11111111-1111-4111-8111-111111111111';
const context: Awaited<ReturnType<typeof readMemberReferral>> = { positioned: false, code: 'MBsynthetic', name: 'Synthetic Owner', placement: 'automatic', generated: true,
  metrics: { total: 80, active: 60, pending: 20 }, referrals: [{ id, name: 'Synthetic Direct', status: 'registrado', date: '2026-11-14T12:00:00Z' }],
  sponsor_name: 'Synthetic Sponsor', sponsor_referral_code: 'MBsponsor', attribution_source: 'referral' };
const attribution: Awaited<ReturnType<typeof captureMemberReferral>> = { ok: true, ref: 'MBsponsor', preferred_side: '', positioned: false, immutable: true };
const database = (execute: (query: SQL) => Promise<unknown[]>) => ({ execute } as unknown as Pick<IdentityDatabase, 'execute'>);

test('referral reads use only the native subject/session and accept real totals beyond the latest fifty rows', async () => {
  let calls = 0;
  const db = database(async query => {
    calls++; const q = new PgDialect().sqlToQuery(query);
    expect(q.sql).toContain('identity.read_member_referral'); expect(q.params).toEqual([principal.subject, principal.nativeSessionId]);
    expect(q.sql).not.toMatch(/affiliate_package|wallet|INSERT|UPDATE|DELETE/); return [{ context }];
  });
  expect(await readMemberReferral(db, principal, { environment })).toEqual(context); expect(calls).toBe(1);
});

test('capture accepts only a referral hint and the company default is an explicit empty hint with a trusted server root', async () => {
  expect(memberReferralCaptureInput.parse({ ref: '' })).toEqual({ ref: '' });
  for (const ref of ['', 'MBsponsor', 'MP00042']) {
    let calls = 0;
    const db = database(async query => {
      calls++; const q = new PgDialect().sqlToQuery(query);
      expect(q.sql).toContain('identity.capture_member_referral');
      expect(q.params).toEqual([principal.subject, principal.nativeSessionId, ref, environment.REFERRAL_COMPANY_ROOT_AFFILIATE_ID]);
      return [{ attribution }];
    });
    expect(await captureMemberReferral(db, { ref }, principal, { environment })).toEqual(attribution); expect(calls).toBe(1);
  }
});

test('selectors, placement, owner and financial fields cannot be injected into a capture body', async () => {
  let calls = 0; const db = database(async () => { calls++; return [{ attribution }]; });
  for (const field of ['subject', 'nativeSessionId', 'personId', 'affiliateId', 'sponsorId', 'companyRoot', 'preferred_side', 'packageId', 'commission_eligible', 'wallet']) {
    await expect(captureMemberReferral(db, { ref: '', [field]: 'foreign' }, principal, { environment })).rejects.toBeInstanceOf(Error);
  }
  for (const body of [undefined, null, [], {}, { ref: null }, { ref: 42 }, { ref: 'A'.repeat(65) }, { ref: 'MB owner' }, { ref: 'MB\nowner' }]) {
    await expect(captureMemberReferral(db, body, principal, { environment })).rejects.toBeInstanceOf(Error);
  }
  expect(calls).toBe(0);
});

test('disabled, missing-root, malformed-principal and already-aborted requests never query SQL', async () => {
  let calls = 0; const db = database(async () => { calls++; return [{ attribution }]; });
  for (const enabled of [undefined, '', 'false', 'TRUE']) {
    const disabled = { ...environment, MEMBER_REFERRAL_ENABLED: enabled };
    await expect(readMemberReferral(db, principal, { environment: disabled })).rejects.toThrow('member_referral_unconfigured');
    await expect(captureMemberReferral(db, { ref: '' }, principal, { environment: disabled })).rejects.toThrow('member_referral_unconfigured');
  }
  for (const root of [undefined, '', '0', '-1', '1.5', '50793 OR true', '9007199254740992', '01']) {
    await expect(captureMemberReferral(db, { ref: '' }, principal, { environment: { ...environment, REFERRAL_COMPANY_ROOT_AFFILIATE_ID: root } })).rejects.toThrow('member_referral_unconfigured');
  }
  for (const invalid of [{ ...principal, subject: '' }, { ...principal, nativeSessionId: '' }, { ...principal, subject: 'owner\nother' }]) {
    await expect(readMemberReferral(db, invalid, { environment })).rejects.toBeInstanceOf(Error);
  }
  const controller = new AbortController(); controller.abort();
  await expect(captureMemberReferral(db, { ref: '' }, principal, { environment, signal: controller.signal })).rejects.toThrow('member_referral_unavailable');
  expect(calls).toBe(0);
});

test('referral output fails closed on malformed, conflicting or private-field projections', async () => {
  const invalid = [null, { ...context, private_email: 'must-not-project' }, { ...context, code: '' },
    { ...context, metrics: { total: 80, active: 60, pending: 19 } },
    { ...context, metrics: { total: 0, active: 0, pending: 0 } },
    { ...context, metrics: { total: 80, active: 80, pending: 0 } },
    { ...context, metrics: { total: 80, active: 0, pending: 80 }, referrals: [{ ...context.referrals[0], status: 'activo' }] },
    { ...context, referrals: [context.referrals[0], context.referrals[0]] },
    { ...context, referrals: [{ ...context.referrals[0], status: 'active' }] },
    { ...context, sponsor_name: 'name\nprivate' }, { ...context, metrics: { total: 80, active: 0, pending: 80 },
      referrals: Array.from({ length: 51 }, (_, i) => ({ ...context.referrals[0], id: `person:${(i + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111` })) }];
  for (const value of invalid) {
    await expect(readMemberReferral(database(async () => [{ context: value }]), principal, { environment })).rejects.toThrow('member_referral_unavailable');
  }
  for (const rows of [[], [{ context }, { context }], [{ attribution }]]) {
    await expect(readMemberReferral(database(async () => rows), principal, { environment })).rejects.toThrow('member_referral_unavailable');
  }
  for (const value of [{ ...attribution, immutable: false }, { ...attribution, preferred_side: 'L' }, { ...attribution, owner: 'other' }]) {
    await expect(captureMemberReferral(database(async () => [{ attribution: value }]), { ref: '' }, principal, { environment })).rejects.toThrow('member_referral_unavailable');
  }
});

test('concurrent capture and response timeout perform one SQL call and never retry an ambiguous attribution', async () => {
  let calls = 0; const db = database(async () => { calls++; return new Promise(() => {}); });
  const first = captureMemberReferral(db, { ref: 'MBsponsor' }, principal, { environment, timeoutMs: 20 });
  await expect(captureMemberReferral(db, { ref: '' }, principal, { environment, timeoutMs: 20 })).rejects.toThrow('member_referral_rate_limited');
  await expect(first).rejects.toThrow('member_referral_unavailable'); expect(calls).toBe(1);
  let failedCalls = 0;
  const failed = database(async () => { failedCalls++; throw Error('member_referral_outstanding_order'); });
  await expect(captureMemberReferral(failed, { ref: '' }, principal, { environment })).rejects.toThrow('member_referral_outstanding_order');
  expect(failedCalls).toBe(1);
});

test('per-owner capture rate is shared across rotated native sessions and does not block another owner', async () => {
  let calls = 0; const db = database(async () => { calls++; return [{ attribution }]; });
  for (let i = 0; i < 10; i++) await captureMemberReferral(db, { ref: '' }, { ...principal, nativeSessionId: `synthetic-${i}` }, { environment, now: () => 1000 });
  await expect(captureMemberReferral(db, { ref: '' }, principal, { environment, now: () => 1001 })).rejects.toThrow('member_referral_rate_limited');
  await captureMemberReferral(db, { ref: '' }, { ...principal, subject: 'synthetic-other-owner' }, { environment, now: () => 1001 });
  expect(calls).toBe(11);
});

test('read concurrency remains bounded at four and releases slots after failures without resetting its minute budget', async () => {
  const pending: { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }[] = [];
  const db = database(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }));
  const options = { environment, now: () => 1000 };
  const reads = Array.from({ length: 4 }, () => readMemberReferral(db, principal, options));
  await Promise.resolve();
  expect(pending).toHaveLength(4);
  await expect(readMemberReferral(db, principal, options)).rejects.toThrow('member_referral_rate_limited');
  const firstFailure = reads[0]!.catch(error => error);
  pending[0]!.reject(Error('synthetic-read-failure')); expect((await firstFailure).message).toBe('synthetic-read-failure');
  const replacement = readMemberReferral(db, principal, options); await Promise.resolve();
  expect(pending).toHaveLength(5);
  for (const item of pending.slice(1)) item.resolve([{ context }]);
  expect(await Promise.all([...reads.slice(1), replacement])).toHaveLength(4);
  const final = readMemberReferral(db, principal, options); await Promise.resolve(); pending[5]!.resolve([{ context }]);
  expect(await final).toEqual(context);
  for (let index = 6; index < 60; index++) {
    const read = readMemberReferral(db, principal, options); await Promise.resolve(); pending[index]!.resolve([{ context }]); await read;
  }
  await expect(readMemberReferral(db, principal, options)).rejects.toThrow('member_referral_rate_limited');
  const nextMinute = readMemberReferral(db, principal, { environment, now: () => 61000 });
  await Promise.resolve(); pending[60]!.resolve([{ context }]); expect(await nextMinute).toEqual(context);
});
