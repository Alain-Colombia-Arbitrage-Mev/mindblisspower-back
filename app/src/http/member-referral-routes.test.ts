import { createHash, createHmac } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiEnvironment } from './types';
import { registerMemberReferralRoutes } from './member-referral-routes';

const path = '/api/member/referral', capture = '/api/member/referral-attribution', origin = 'https://app.mindblisspower.com';
const subject = 'synthetic-referral-owner', nativeSessionId = 'synthetic-native-session', secret = 's'.repeat(48);
const cookie = 'better-auth.session_token=synthetic', ownerHeader = { 'x-mindbliss-referral-subject': encodeURIComponent(subject) };
const environment = { MEMBER_REFERRAL_ENABLED: 'true', REFERRAL_COMPANY_ROOT_AFFILIATE_ID: '50793', AUTH_BFF_SHARED_SECRET: secret };
const context = { positioned: false, code: 'MBsynthetic', name: 'Synthetic Owner', placement: 'automatic', generated: true,
  metrics: { total: 0, active: 0, pending: 0 }, referrals: [], sponsor_name: '', sponsor_referral_code: '', attribution_source: 'unassigned' };
const attribution = { ok: true, ref: 'MBsponsor', preferred_side: '', positioned: false, immutable: true };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function signed(body: unknown, extra: Record<string, string> = {}) {
  const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000)), ip = '192.0.2.1';
  const signature = createHmac('sha256', secret).update(['POST', capture, timestamp, ip, hash(cookie), hash(raw)].join('\n')).digest('hex');
  return { method: 'POST', body: raw, headers: { origin, cookie, 'content-type': 'application/json', ...ownerHeader,
    'x-vp-auth-client-ip': ip, 'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': signature, ...extra } };
}
function application({ authenticated = true, nativeSession = true, enabled = true, owner = subject, execute = async () => [{ context }] }: {
  authenticated?: boolean; nativeSession?: boolean; enabled?: boolean; owner?: string; execute?: (query: SQL) => Promise<unknown[]>;
} = {}) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (ctx, next) => {
    ctx.set('session', authenticated ? { user: { id: owner }, ...(nativeSession ? { session: { id: nativeSessionId } } : {}) } as never : null); await next();
  });
  registerMemberReferralRoutes(app, { database: { execute } as unknown as Pick<IdentityDatabase, 'execute'>,
    environment: { ...environment, MEMBER_REFERRAL_ENABLED: String(enabled) } }); return app;
}

test('native referral GET binds real native session and POST supplies only its hint plus the trusted root', async () => {
  let calls = 0;
  const app = application({ execute: async query => {
    calls++; const q = new PgDialect().sqlToQuery(query);
    if (q.sql.includes('identity.read_member_referral')) { expect(q.params).toEqual([subject, nativeSessionId]); return [{ context }]; }
    expect(q.params).toEqual([subject, nativeSessionId, '', '50793']); return [{ attribution }];
  } });
  const read = await app.request(path, { headers: { origin, ...ownerHeader } });
  expect(read.status).toBe(200); expect(await read.json()).toEqual(context); expect(read.headers.get('cache-control')).toBe('private, no-store');
  const write = await app.request(capture, signed({ ref: '' }));
  expect(write.status).toBe(200); expect(await write.json()).toEqual(attribution); expect(write.headers.get('cache-control')).toBe('private, no-store'); expect(calls).toBe(2);
});

test('disabled capability, missing native session, origin aliases and impersonation fail before SQL', async () => {
  let calls = 0; const execute = async () => { calls++; return [{ context }]; };
  for (const init of [{ headers: { origin, ...ownerHeader } }, signed({ ref: '' })] as RequestInit[]) {
    const target = init.method === 'POST' ? capture : path;
    expect((await application({ enabled: false, execute }).request(target, init)).status).toBe(503);
    expect((await application({ authenticated: false, execute }).request(target, init)).status).toBe(401);
    expect((await application({ nativeSession: false, execute }).request(target, init)).status).toBe(401);
  }
  const app = application({ execute });
  for (const extra of [{ origin: '' }, { origin: 'https://wallet.mindblisspower.com' }, { origin: 'https://app.mindblisspower.com.evil.invalid' }, { 'x-vp-act-as': '' }] as Record<string, string>[]) {
    expect((await app.request(path, { headers: { origin, ...ownerHeader, ...extra } })).status).toBe(403);
    expect((await app.request(capture, signed({ ref: '' }, extra))).status).toBe(403);
  }
  expect((await app.request(path + '?subject=other', { headers: { origin, ...ownerHeader } })).status).toBe(400); expect(calls).toBe(0);
});

test('mounted owner mismatch is 409 and malformed or missing owner fences never select SQL identity', async () => {
  let calls = 0; const execute = async () => { calls++; return [{ context }]; };
  const changed = application({ owner: 'another-cookie-owner', execute });
  for (const [target, init] of [[path, { headers: { origin, ...ownerHeader } }], [capture, signed({ ref: '' })]] as const) {
    const response = await changed.request(target, init); expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'member_referral_owner_changed' });
  }
  const app = application({ execute });
  for (const value of ['', '%ZZ', '%00owner', '%20owner', 'a'.repeat(256), 'owner,other', '%73ynthetic-referral-owner']) {
    expect((await app.request(path, { headers: { origin, 'x-mindbliss-referral-subject': value } })).status).toBe(403);
    expect((await app.request(capture, signed({ ref: '' }, { 'x-mindbliss-referral-subject': value }))).status).toBe(403);
  }
  expect((await app.request(path, { headers: { origin } })).status).toBe(403); expect(calls).toBe(0);
});

test('canonical encoded owner is only a view fence; actual cookie identity and session remain SQL parameters', async () => {
  const owner = 'synthetic/owner.é'; let calls = 0;
  const app = application({ owner, execute: async query => {
    calls++; expect(new PgDialect().sqlToQuery(query).params).toEqual([owner, nativeSessionId]); return [{ context }];
  } });
  expect((await app.request(path, { headers: { origin, 'x-mindbliss-referral-subject': encodeURIComponent(owner) } })).status).toBe(200);
  expect((await app.request(path, { headers: { origin, 'x-mindbliss-referral-subject': encodeURIComponent(owner).replace('%2F', '%2f') } })).status).toBe(403); expect(calls).toBe(1);
});

test('capture authenticates the exact bounded body, cookie, method, path and fresh native BFF envelope', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; return [{ attribution }]; } });
  const body = { ref: 'MBsponsor' };
  for (const extra of [{ 'x-vp-auth-signature': '0'.repeat(64) }, { cookie: 'better-auth.session_token=other' },
    { 'x-vp-auth-timestamp': '1000000000' }, { 'x-vp-auth-client-ip': 'not-an-ip' }] as Record<string, string>[]) {
    expect((await app.request(capture, signed(body, extra))).status).toBe(403);
  }
  const changed = signed(body); changed.body = JSON.stringify({ ref: 'MBother' });
  expect((await app.request(capture, changed)).status).toBe(403);
  expect((await app.request(capture, { method: 'POST', body: JSON.stringify(body), headers: { origin, ...ownerHeader, 'content-type': 'application/json' } })).status).toBe(403);
  expect((await app.request(capture, signed(body, { 'content-encoding': 'gzip' }))).status).toBe(415);
  expect((await app.request(capture, signed(body, { 'content-type': 'text/plain' }))).status).toBe(415);
  expect((await app.request(capture, signed({ ref: 'A'.repeat(4096) }))).status).toBe(413); expect(calls).toBe(0);
});

test('signed ref-only body rejects owner, root, placement and financial injections before SQL', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; return [{ attribution }]; } });
  for (const body of [{}, [], { ref: null }, { ref: 'two codes' }, ...['subject', 'personId', 'sponsorId', 'companyRoot', 'preferred_side', 'commission_eligible'].map(key => ({ ref: '', [key]: 'foreign' }))]) {
    expect((await app.request(capture, signed(body))).status).toBe(400);
  }
  expect(calls).toBe(0);
});

test('native attribution errors preserve safe states without retries, leaked database data or false success', async () => {
  for (const [code, status] of [['member_referral_forbidden', 403], ['member_referral_invalid_code', 400], ['member_referral_outstanding_order', 409],
    ['member_referral_rate_limited', 429], ['member_referral_unconfigured', 503], ['private SQL password=synthetic', 503]] as const) {
    let calls = 0;
    const app = application({ execute: async () => { calls++; throw new Error('wrapper', { cause: new Error(code) }); } });
    const response = await app.request(capture, signed({ ref: '' }));
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code.startsWith('member_referral_') ? code : 'member_referral_unavailable' }); expect(calls).toBe(1);
  }
  const bad = await application({ execute: async () => [{ attribution: { ...attribution, immutable: false } }] }).request(capture, signed({ ref: '' }));
  expect(bad.status).toBe(503); expect(await bad.json()).toEqual({ error: 'member_referral_unavailable' });
});

test('dashboard own-link and attribution BFF reads can overlap while the fifth native read remains limited', async () => {
  const pending: ((rows: unknown[]) => void)[] = [];
  const app = application({ execute: () => new Promise(resolve => { pending.push(resolve); }) });
  const headers = { origin, ...ownerHeader };
  // Both public BFF GET paths project this one authenticated Native reader.
  const readFromBff = (bffPath: typeof path | typeof capture) => {
    expect([path, capture]).toContain(bffPath); return app.request(path, { headers });
  };
  const reads = [readFromBff(path), readFromBff(capture), readFromBff(path), readFromBff(capture)];
  for (let count = 0; pending.length < 4 && count < 30; count++) await Promise.resolve();
  expect(pending).toHaveLength(4);
  const limited = await readFromBff(capture);
  expect(limited.status).toBe(429); expect(await limited.json()).toEqual({ error: 'member_referral_rate_limited' });
  expect(pending).toHaveLength(4);
  pending[0]!([{ context }]); expect((await reads[0]!).status).toBe(200);
  const replacement = readFromBff(capture);
  for (let count = 0; pending.length < 5 && count < 30; count++) await Promise.resolve();
  expect(pending).toHaveLength(5);
  for (const resolve of pending.slice(1)) resolve([{ context }]);
  for (const response of await Promise.all([...reads.slice(1), replacement])) {
    expect(response.status).toBe(200); expect(await response.json()).toEqual(context);
  }
});
