import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiEnvironment } from './types';
import { PAGAR_COMMISSIONS_PATH, registerMemberPackageRightsRoutes } from './member-package-rights-routes';

const path = '/api/member/package-rights', rechargePath = '/api/member/recharge-package';
const origin = 'https://app.mindblisspower.com';
const subject = 'synthetic-rights-owner', nativeSessionId = 'synthetic-native-session', cookie = 'better-auth.session_token=synthetic';
const headers = { origin, cookie, 'x-mindbliss-profile-subject': encodeURIComponent(subject) };
const rights = { rightsOnly: true, economicActivation: false, roiEnabled: false, commissionsEnabled: false,
  policy: 'historical_membership_access_until_revoked_v1', totalCount: 0, activeCount: 0, items: [] };
function application({ enabled = true, rechargeEnabled = true, closeEnabled = true, stage = 'production',
  authenticated = true, nativeSession = true, owner = subject,
  execute = async () => [{ rights }] }: {
  enabled?: boolean; rechargeEnabled?: boolean; authenticated?: boolean; nativeSession?: boolean; owner?: string;
  closeEnabled?: boolean; stage?: string;
  execute?: (query: SQL) => Promise<unknown[]>;
} = {}) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (ctx, next) => {
    ctx.set('session', authenticated && ctx.req.header('cookie') === cookie ? { user: { id: owner },
      ...(nativeSession ? { session: { id: nativeSessionId } } : {}) } as never : null); await next();
  });
  registerMemberPackageRightsRoutes(app, { database: { execute } as unknown as Pick<IdentityDatabase, 'execute'>,
    environment: { ENV: stage, MEMBER_PACKAGE_RIGHTS_ENABLED: String(enabled), APP_MELD_PRODUCTION_ENABLED: String(rechargeEnabled),
      APP_PAGAR_CLOSE_ENABLED: String(closeEnabled) } }); return app;
}

test('the App recharge package projects the verified cumulative gross and never accepts caller amounts or owners', async () => {
  const confirmedAt = '2026-11-20T10:00:00.000Z';
  let calls = 0;
  const app = application({ enabled: false, closeEnabled: false, execute: async query => {
    calls++;
    const sql = new PgDialect().sqlToQuery(query);
    expect(sql.sql).toContain('payments.read_app_recharge_package_v1');
    expect(sql.params).toEqual([subject, nativeSessionId]);
    return [{ level: 2, ceiling_usd_minor: '10000', gross_usd_minor: '5001', confirmed_at: new Date(confirmedAt) }];
  } });
  const response = await app.request(rechargePath, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ package: { level: 2, ceilingUsdMinor: 10000, grossUsdMinor: 5001, confirmedAt } });
  expect((await app.request(rechargePath + '?gross=10000', { headers })).status).toBe(400);
  expect((await app.request(rechargePath, { headers: { ...headers, origin: 'https://wallet.mindblisspower.com' } })).status).toBe(403);
  expect((await app.request(rechargePath, { headers: { ...headers, 'x-mindbliss-profile-subject': 'other' } })).status).toBe(409);
  expect((await app.request(rechargePath, { headers, method: 'POST' })).status).toBe(404);
  expect(calls).toBe(1);
  const none = await application({ execute: async () => [] }).request(rechargePath, { headers });
  expect(await none.json()).toEqual({ package: null });
});

test('native rights GET uses authenticated session authority, private caching and an explicit rights-only response', async () => {
  let calls = 0;
  const app = application({ execute: async query => {
    calls++; const q = new PgDialect().sqlToQuery(query); expect(q.sql).toContain('payments.read_member_package_rights');
    expect(q.params).toEqual([subject, nativeSessionId]); return [{ rights }];
  } });
  const response = await app.request(path, { headers }); expect(response.status).toBe(200);
  expect(await response.json()).toEqual(rights); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(calls).toBe(1);
});

test('Pagar commissions project the current owner and strict weekly cursor as a private display-only response', async () => {
  const before = '2026-11-16';
  const app = application({ enabled: false, execute: async query => {
    const statement = new PgDialect().sqlToQuery(query);
    expect(statement.sql).toContain('payments.read_app_pagar_commissions_v1');
    expect(statement.params).toEqual([subject, nativeSessionId, before]);
    return [{ virtual_balance_usd_minor: '2710', periods: [
      { week_end: '2026-11-09', binary_usd_minor: '1400', rank_usd_minor: '310' },
    ], next_before: null }];
  } });
  const response = await app.request(PAGAR_COMMISSIONS_PATH + '?before=' + before, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ virtualBalanceUsdMinor: 2710, periods: [
    { weekEnd: '2026-11-09', binaryUsdMinor: 1400, rankUsdMinor: 310 },
  ], nextBefore: null });
});

test('Pagar commissions admit no alternate owner, wallet origins, mutations or ambiguous cursor', async () => {
  const execute = async () => { throw Error('unexpected_sql'); };
  const app = application({ execute });
  for (const suffix of ['?', '?subject=other', '?before=2026-11-17', '?before=2026-02-30',
    '?before=0000-01-03', '?before=2026-11-16&before=2026-11-16', '?before=2026-11-16&',
    '?%62efore=2026-11-16', '?before=2026-11-%31%36']) {
    expect((await app.request(PAGAR_COMMISSIONS_PATH + suffix, { headers })).status).toBe(400);
  }
  expect((await app.request(PAGAR_COMMISSIONS_PATH, { headers: { ...headers, origin: 'https://wallet.mindblisspower.com' } })).status).toBe(403);
  expect((await app.request(PAGAR_COMMISSIONS_PATH, { headers: { ...headers, 'x-vp-act-as': 'synthetic' } })).status).toBe(403);
  expect((await app.request(PAGAR_COMMISSIONS_PATH, { headers: { ...headers, 'x-mindbliss-profile-subject': 'other' } })).status).toBe(409);
  for (const method of ['POST', 'HEAD', 'DELETE']) expect((await app.request(PAGAR_COMMISSIONS_PATH, { method, headers })).status).toBe(404);
  expect((await application({ authenticated: false, execute }).request(PAGAR_COMMISSIONS_PATH, { headers })).status).toBe(401);
  for (const options of [{ rechargeEnabled: false }, { closeEnabled: false }, { stage: 'staging' }]) {
    expect((await application({ ...options, execute }).request(PAGAR_COMMISSIONS_PATH, { headers })).status).toBe(503);
  }
});

test('Pagar commission projection rejects malformed totals and history without exposing SQL diagnostics', async () => {
  const result = { virtual_balance_usd_minor: '200', periods: [], next_before: null };
  for (const invalid of [{ ...result, virtual_balance_usd_minor: '9007199254740992' },
    { ...result, next_before: '2026-11-16' }, { ...result, wallet: 'synthetic' },
    { ...result, periods: [{ week_end: '2026-11-16', binary_usd_minor: '1', rank_usd_minor: '1', recipient: 'other' }] }]) {
    const response = await application({ execute: async () => [invalid] }).request(PAGAR_COMMISSIONS_PATH, { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'member_pagar_commissions_unavailable' });
  }
});

test('feature disabled, missing cookie/session and foreign origins cannot reach SQL', async () => {
  let calls = 0; const execute = async () => { calls++; return [{ rights }]; };
  expect((await application({ enabled: false, execute }).request(path, { headers })).status).toBe(503);
  expect((await application({ authenticated: false, execute }).request(path, { headers })).status).toBe(401);
  expect((await application({ nativeSession: false, execute }).request(path, { headers })).status).toBe(401);
  const app = application({ execute });
  expect((await app.request(path, { headers: { ...headers, cookie: '' } })).status).toBe(401);
  for (const extra of [{ origin: '' }, { origin: 'https://wallet.mindblisspower.com' }, { origin: 'https://app.mindblisspower.com.evil.invalid' },
    { 'x-vp-act-as': '' }, { 'x-vp-act-as': 'foreign' }] as Record<string, string>[]) {
    expect((await app.request(path, { headers: { ...headers, ...extra } })).status).toBe(403);
  }
  for (const suffix of ['?subject=foreign', '?email=foreign', '?', '?packageId=51001']) {
    expect((await app.request(path + suffix, { headers })).status).toBe(400);
  }
  expect(calls).toBe(0);
});

test('a stale view cannot read the next cookie owner and canonical subject headers never select another person', async () => {
  let calls = 0; const execute = async () => { calls++; return [{ rights }]; };
  const changed = await application({ owner: 'synthetic-next-owner', execute }).request(path, { headers });
  expect(changed.status).toBe(409); expect(await changed.json()).toEqual({ error: 'member_package_rights_owner_changed' });
  const app = application({ execute });
  for (const value of ['', '%ZZ', '%00owner', '%20owner', 'a'.repeat(256), 'owner,other', '%73ynthetic-rights-owner']) {
    expect((await app.request(path, { headers: { ...headers, 'x-mindbliss-profile-subject': value } })).status).toBe(403);
  }
  expect((await app.request(path, { headers: { origin, cookie } })).status).toBe(403); expect(calls).toBe(0);
  const owner = 'synthetic/owner.é';
  const canonical = application({ owner, execute: async query => {
    calls++; expect(new PgDialect().sqlToQuery(query).params).toEqual([owner, nativeSessionId]); return [{ rights }];
  } });
  expect((await canonical.request(path, { headers: { ...headers, 'x-mindbliss-profile-subject': encodeURIComponent(owner) } })).status).toBe(200); expect(calls).toBe(1);
});

test('rights endpoint has no public grant, revoke, operational activation or selector mutation', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; return [{ rights }]; } });
  for (const [target, method] of [[path, 'POST'], [path, 'PATCH'], [path + '/grant', 'POST'], [path + '/revoke', 'POST']]) {
    const response = await app.request(target!, { method, headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ personId: 42, sourcePackageId: '51001', roiEnabled: true }) });
    expect([404, 405]).toContain(response.status);
  }
  expect(calls).toBe(0);
});

test('rights read failures have safe owner/rate/review states and no retries or financial fallback', async () => {
  for (const [code, status] of [['member_package_rights_forbidden', 403], ['member_package_rights_rate_limited', 429],
    ['member_package_rights_unconfigured', 503], ['private SQL password=synthetic', 503]] as const) {
    let calls = 0; const app = application({ execute: async () => { calls++; throw Error('wrapper', { cause: Error(code) }); } });
    const response = await app.request(path, { headers }); expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code.startsWith('member_package_rights_') ? code : 'member_package_rights_unavailable' }); expect(calls).toBe(1);
  }
  for (const invalid of [{ ...rights, roiEnabled: true }, { ...rights, active_packages: 1 }, { ...rights, personId: 42 }]) {
    const response = await application({ execute: async () => [{ rights: invalid }] }).request(path, { headers });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'member_package_rights_unavailable' });
  }
});
