import { createHash, createHmac } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiEnvironment } from './types';
import { registerMemberProfileRoutes } from './member-profile-routes';

const path = '/api/member/profile', origin = 'https://app.mindblisspower.com', secret = 's'.repeat(48);
const subject = 'synthetic-profile-owner', nativeSessionId = 'synthetic-native-session';
const environment = { MEMBER_PROFILE_ENABLED: 'true', AUTH_BFF_SHARED_SECRET: secret };
const profile = { first_name: 'Synthetic', last_name: 'Owner', phone: '+12025550123', country: 'Legacy country', payout_wallet_usdc: '0x' + '1'.repeat(40),
  sponsor_name: 'Synthetic Sponsor', sponsor_referral_code: 'SYNTHETIC', referral_code: 'OWN-SYNTHETIC' };
const patch = { name: 'Synthetic Owner', phone: '+12025550123' };
const cookie = 'better-auth.session_token=synthetic';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function signed(body: unknown, extra: Record<string, string> = {}) {
  const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000)), ip = '192.0.2.1';
  const signature = createHmac('sha256', secret).update(['POST', path, timestamp, ip, hash(cookie), hash(raw)].join('\n')).digest('hex');
  return { method: 'POST', body: raw, headers: { origin, cookie, 'content-type': 'application/json',
    'x-mindbliss-profile-subject': encodeURIComponent(subject),
    'x-vp-auth-client-ip': ip, 'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': signature, ...extra } };
}
function application({ authenticated = true, nativeSession = true, enabled = true, owner = subject, execute = async () => [profile] }: {
  authenticated?: boolean; nativeSession?: boolean; enabled?: boolean; owner?: string; execute?: (query: SQL) => Promise<unknown[]>;
} = {}) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => {
    context.set('session', authenticated ? { user: { id: owner }, ...(nativeSession ? { session: { id: nativeSessionId } } : {}) } as never : null); await next();
  });
  registerMemberProfileRoutes(app, { database: { execute } as unknown as Pick<IdentityDatabase, 'execute'>,
    environment: { ...environment, MEMBER_PROFILE_ENABLED: String(enabled) } });
  return app;
}

test('native own-profile reads use the authenticated native session, app origin and no selectors or acting-as overrides', async () => {
  let queries = 0;
  const app = application({ execute: async query => { queries++; const q = new PgDialect().sqlToQuery(query);
    expect(q.params).toEqual([subject, nativeSessionId]); return [profile]; } });
  const ownerHeader = { 'x-mindbliss-profile-subject': encodeURIComponent(subject) };
  const response = await app.request(path, { headers: { origin, ...ownerHeader } });
  expect(response.status).toBe(200); expect(await response.json()).toEqual(profile); expect(response.headers.get('cache-control')).toBe('private, no-store');
  for (const headers of [{}, { origin: 'https://wallet.mindblisspower.com' }, { origin: 'https://admin.mindblisspower.com' },
    { origin, 'x-vp-act-as': '' }, { origin, 'x-vp-act-as': 'another-user' }] as Record<string, string>[]) {
    expect((await app.request(path, { headers: { ...ownerHeader, ...headers } })).status).toBe(403);
  }
  expect((await app.request(path + '?email=other', { headers: { origin, ...ownerHeader } })).status).toBe(400);
  expect((await application({ authenticated: false }).request(path, { headers: { origin } })).status).toBe(401);
  expect((await application({ nativeSession: false }).request(path, { headers: { origin } })).status).toBe(401);
  expect(queries).toBe(1);
});

test('disabled own-profile GET and POST never touch SQL', async () => {
  let queries = 0; const app = application({ enabled: false, execute: async () => { queries++; return [profile]; } });
  for (const init of [{ headers: { origin, 'x-mindbliss-profile-subject': encodeURIComponent(subject) } }, signed(patch)]) {
    const response = await app.request(path, init); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'member_profile_unconfigured' });
  }
  expect(queries).toBe(0);
});

test('signed own-profile POST keeps identity server-side, preserves absent country and returns persisted exact values', async () => {
  let queries = 0;
  const app = application({ execute: async query => { queries++; const q = new PgDialect().sqlToQuery(query);
    expect(q.sql).toContain('identity.update_member_profile'); expect(q.params).toEqual([subject, nativeSessionId, patch.name, patch.phone, null]); return [profile]; } });
  const response = await app.request(path, signed(patch)); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, profile }); expect(queries).toBe(1);
});

test('own-profile mutation rejects inspector-injected wallets, identities, roles and unsigned or modified bodies before SQL', async () => {
  let queries = 0; const app = application({ execute: async () => { queries++; throw Error('must not query'); } });
  for (const field of ['email', 'subject', 'nativeSessionId', 'payout_wallet_usdc', 'userId', 'isAdmin', 'contactWhatsapp', 'phoneNumberVerified', 'sponsor_name', 'sponsor_referral_code', 'referral_code']) {
    expect((await app.request(path, signed({ ...patch, [field]: 'forged' }))).status).toBe(400);
  }
  expect((await app.request(path, { method: 'POST', body: JSON.stringify(patch), headers: { origin, 'content-type': 'application/json' } })).status).toBe(403);
  const changed = signed(patch); changed.body = JSON.stringify({ ...patch, phone: '+573009999999' });
  expect((await app.request(path, changed)).status).toBe(403);
  expect((await app.request(path, signed(patch, { cookie: 'better-auth.session_token=foreign' }))).status).toBe(403);
  expect((await app.request(path, signed(patch, { origin: 'https://wallet.mindblisspower.com' }))).status).toBe(403);
  expect((await app.request(path, signed(patch, { 'x-vp-act-as': '' }))).status).toBe(403);
  expect(queries).toBe(0);
});

test('a stale mounted profile cannot read or overwrite another native cookie owner, and absent/malformed view guards never select identity', async () => {
  let queries = 0;
  const app = application({ owner: 'synthetic-new-cookie-owner', execute: async () => { queries++; throw Error('must not query'); } });
  for (const init of [{ headers: { origin, 'x-mindbliss-profile-subject': encodeURIComponent(subject) } }, signed(patch)]) {
    const response = await app.request(path, init); expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'member_profile_owner_changed' });
  }
  const matching = application({ execute: async () => { queries++; throw Error('must not query'); } });
  for (const value of ['', '%ZZ', '%00owner', 'a'.repeat(256), '%61'.repeat(1025), 'owner,other']) {
    const headers = { origin, 'x-mindbliss-profile-subject': value };
    expect((await matching.request(path, { headers })).status).toBe(403);
    expect((await matching.request(path, signed(patch, { 'x-mindbliss-profile-subject': value }))).status).toBe(403);
  }
  expect((await matching.request(path, { headers: { origin } })).status).toBe(403);
  expect(queries).toBe(0);
});

test('a canonical URI-encoded view subject is decoded exactly but SQL still uses the actual native session subject', async () => {
  const owner = 'synthetic/owner.é'; let queries = 0;
  const app = application({ owner, execute: async query => { queries++; const q = new PgDialect().sqlToQuery(query);
    expect(q.params).toEqual([owner, nativeSessionId]); return [profile]; } });
  const response = await app.request(path, { headers: { origin, 'x-mindbliss-profile-subject': encodeURIComponent(owner) } });
  expect(response.status).toBe(200); expect(queries).toBe(1);
  const alias = await app.request(path, { headers: { origin, 'x-mindbliss-profile-subject': encodeURIComponent(owner).replace('%2F', '%2f') } });
  expect(alias.status).toBe(403); expect(queries).toBe(1);
});

test('own-profile raw writes are byte-bounded and error responses never leak SQL or pretend an unmatched save succeeded', async () => {
  let queries = 0; const app = application({ execute: async () => { queries++; throw Error('private SQL password=secret customer-name'); } });
  const oversized = signed({ ...patch, name: 'A'.repeat(4096) }); expect((await app.request(path, oversized)).status).toBe(413);
  expect((await app.request(path, signed(patch, { 'content-encoding': 'gzip' }))).status).toBe(415);
  const failed = await app.request(path, signed(patch)); expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ error: 'member_profile_unavailable' });
  expect(queries).toBe(1);
  const mismatch = await application({ execute: async () => [{ ...profile, phone: '+573009999999' }] }).request(path, signed(patch));
  expect(mismatch.status).toBe(503); expect(await mismatch.json()).toEqual({ error: 'member_profile_outcome_unconfirmed' });
  const forbidden = await application({ execute: async () => { throw Error('member_profile_forbidden'); } }).request(path, signed(patch));
  expect(forbidden.status).toBe(403);
});
