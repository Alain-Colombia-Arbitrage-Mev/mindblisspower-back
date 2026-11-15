import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiEnvironment } from './types';
import { registerMemberPackageRightsRoutes } from './member-package-rights-routes';

const path = '/api/member/package-rights', origin = 'https://app.mindblisspower.com';
const subject = 'synthetic-rights-owner', nativeSessionId = 'synthetic-native-session', cookie = 'better-auth.session_token=synthetic';
const headers = { origin, cookie, 'x-mindbliss-profile-subject': encodeURIComponent(subject) };
const rights = { rightsOnly: true, economicActivation: false, roiEnabled: false, commissionsEnabled: false,
  policy: 'historical_membership_access_until_revoked_v1', totalCount: 0, activeCount: 0, items: [] };
function application({ enabled = true, authenticated = true, nativeSession = true, owner = subject, execute = async () => [{ rights }] }: {
  enabled?: boolean; authenticated?: boolean; nativeSession?: boolean; owner?: string; execute?: (query: SQL) => Promise<unknown[]>;
} = {}) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (ctx, next) => {
    ctx.set('session', authenticated && ctx.req.header('cookie') === cookie ? { user: { id: owner },
      ...(nativeSession ? { session: { id: nativeSessionId } } : {}) } as never : null); await next();
  });
  registerMemberPackageRightsRoutes(app, { database: { execute } as unknown as Pick<IdentityDatabase, 'execute'>,
    environment: { MEMBER_PACKAGE_RIGHTS_ENABLED: String(enabled) } }); return app;
}

test('native rights GET uses authenticated session authority, private caching and an explicit rights-only response', async () => {
  let calls = 0;
  const app = application({ execute: async query => {
    calls++; const q = new PgDialect().sqlToQuery(query); expect(q.sql).toContain('payments.read_member_package_rights');
    expect(q.params).toEqual([subject, nativeSessionId]); return [{ rights }];
  } });
  const response = await app.request(path, { headers }); expect(response.status).toBe(200);
  expect(await response.json()).toEqual(rights); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(calls).toBe(1);
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
