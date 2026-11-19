import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { ApiEnvironment } from './types';
import type { SandboxWalletDatabase } from '../modules/identity/sandbox-wallet';
import { registerProductionWalletFundingRoutes } from './wallet-meld-production-routes';

const prefix = '/api/member/wallet-funding', subject = 'synthetic-owner', origin = 'https://wallet.mindblisspower.com', secret = 's'.repeat(48);
const environment = { WALLET_MELD_PRODUCTION_ENABLED: 'true', MELD_PRODUCTION_API_KEYS: 'synthetic-production-key', MELD_PRODUCTION_ACCOUNT_ID: 'production-account', AUTH_BFF_SHARED_SECRET: secret };
const headers = { origin, 'x-mindbliss-wallet-subject': encodeURIComponent(subject) };
const id = '6d492c47-80be-4e14-bc5f-54afaa56fc23', wallet = `0x${'1'.repeat(40)}`;
function application({ authenticated = true, native = true, enabled = true, database = { execute: async () => { throw Error('no SQL'); } } as unknown as SandboxWalletDatabase,
  fetchImpl = (async () => { throw Error('no network'); }) as unknown as typeof fetch } = {}) {
  const app = new Hono<ApiEnvironment>(); app.use('*', async (c, next) => {
    c.set('session', authenticated ? { user: { id: subject }, ...(native ? { session: { id: 'native-session' } } : {}) } as never : null); await next();
  });
  registerProductionWalletFundingRoutes(app, { database, environment: enabled ? environment : {}, fetchImpl }); return app;
}
function signed(path: string, input: unknown, extra = {}) {
  const body = JSON.stringify(input), cookie = 'better-auth.session_token=synthetic', timestamp = String(Math.floor(Date.now() / 1000)), ip = '192.0.2.1';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const signature = createHmac('sha256', secret).update(['POST', path, timestamp, ip, hash(cookie), hash(body)].join('\n')).digest('hex');
  return { method: 'POST', body, headers: { ...headers, cookie, 'content-type': 'application/json', 'x-vp-auth-client-ip': ip,
    'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': signature, ...extra } };
}
test('production HTTP authentication and mounted-owner fences reject before SQL/network; only capability reads while unconfigured', async () => {
  let calls = 0; const database = { execute: async () => { calls++; return []; } } as unknown as SandboxWalletDatabase;
  const app = application({ database, enabled: false });
  for (const suffix of ['/capabilities', '/discovery', '/options?country=MX&sourceCurrencyCode=MXN', '/history', '/status?checkoutReference=' + id]) {
    for (const change of [{ origin: 'https://app.mindblisspower.com' }, { 'x-vp-act-as': '' }, { 'x-mindbliss-wallet-subject': 'other' }, { 'x-mindbliss-wallet-subject': '%73ynthetic-owner' }] as Record<string, string>[])
      expect((await app.request(prefix + suffix, { headers: { ...headers, ...change } })).status).toBe(403);
    expect((await application({ authenticated: false }).request(prefix + suffix, { headers })).status).toBe(401);
    expect((await application({ native: false }).request(prefix + suffix, { headers })).status).toBe(401);
  }
  const result = await app.request(prefix + '/capabilities', { headers }); expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ configured: false, environment: 'production', canBroadcast: false });
  expect((await app.request(prefix + '/history', { headers })).status).toBe(503); expect(calls).toBe(0);
});
test('both quote and session POST are cookie/body/IP-bound HMAC writes; owner/address/provider payload injection stays invalid', async () => {
  let queries = 0; const app = application({ database: { execute: async () => { queries++; throw Error('no SQL'); } } as unknown as SandboxWalletDatabase });
  for (const action of ['/quote', '/session']) {
    const path = prefix + action, raw = { country: 'MX', sourceCurrencyCode: 'MXN', amount: 2000, paymentMethodType: 'SPEI', ...(action === '/session' ? { requestId: id, serviceProvider: 'BANXA' } : {}) };
    expect((await app.request(path, { method: 'POST', body: JSON.stringify(raw), headers: { ...headers, 'content-type': 'application/json' } })).status).toBe(403);
    expect((await app.request(path, signed(path, raw, { cookie: 'changed' }))).status).toBe(403);
    for (const extra of [{ address: wallet }, { subject: 'other' }, { accountId: 'other' }, { nativeSessionId: 'other' }])
      expect((await app.request(path, signed(path, { ...raw, ...extra }))).status).toBe(400);
    expect((await app.request(path + '?owner=other', signed(path, raw))).status).toBe(400);
    expect((await app.request(path, signed(path, { ...raw, padding: 'x'.repeat(3000) }))).status).toBe(413);
  }
  expect(queries).toBe(0);
});
test('malformed or duplicate discovery/status/options query cannot reach transport; upstream errors are sanitized', async () => {
  const app = application();
  for (const suffix of ['/discovery?country=MX&country=CO', '/discovery?owner=other', '/options?country=MX&sourceCurrencyCode=MXN&provider=BANXA',
    '/status?checkoutReference=' + id + '&checkoutReference=' + id, '/history?country=MX', '/capabilities?key=other'])
    expect((await app.request(prefix + suffix, { headers })).status).toBe(400);
  const unavailable = application({ database: { execute: async () => { throw Error('private database secret'); } } as unknown as SandboxWalletDatabase });
  const result = await unavailable.request(prefix + '/history', { headers }); expect(result.status).toBe(503);
  expect(await result.json()).toEqual({ error: 'wallet_production_unavailable' });
});
test('read concurrency allows ordinary simultaneous views but bounds the fifth and releases permits', async () => {
  let release: (() => void) | undefined, calls = 0; const wait = new Promise<void>(resolve => { release = resolve; });
  const database = { execute: async () => { calls++; await wait; return []; } } as unknown as SandboxWalletDatabase;
  const app = application({ database });
  const running = Array.from({ length: 4 }, () => app.request(prefix + '/history', { headers }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect((await app.request(prefix + '/history', { headers })).status).toBe(429); expect(calls).toBe(4);
  release!(); expect((await Promise.all(running)).every(result => result.status === 200)).toBe(true);
  expect((await app.request(prefix + '/history', { headers })).status).toBe(200);
});
