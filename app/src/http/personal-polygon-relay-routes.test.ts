import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { ApiEnvironment } from './types';
import type { IdentityDatabase } from '../modules/identity/model';
import { registerPersonalPolygonRelayRoutes } from './personal-polygon-relay-routes';
const PREFIX = '/api/member/polygon-relay', id = '11111111-1111-4111-8111-111111111111', secret = 's'.repeat(48);
function signed(path: string, method = 'GET', raw = '', extra: Record<string, string> = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000)), ip = '192.0.2.1', cookie = 'better-auth.session_token=synthetic';
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  return { method, headers: { cookie, origin: 'https://app.mindblisspower.com', 'content-type': 'application/json',
    'x-vp-auth-client-ip': ip, 'x-vp-auth-timestamp': timestamp,
    'x-vp-auth-signature': createHmac('sha256', secret).update([method, path.split('?')[0], timestamp, ip, digest(cookie), digest(raw)].join('\n')).digest('hex'), ...extra },
    ...(method === 'POST' ? { body: raw } : {}) };
}
function application({ signedIn = true, enabled = true, execute = async () => [] }: {
  signedIn?: boolean; enabled?: boolean; execute?: () => Promise<unknown[]>;
} = {}) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => { context.set('session', signedIn ? { user: { id: 'owner' } } as never : null); await next(); });
  registerPersonalPolygonRelayRoutes(app, { database: { execute } as unknown as Pick<IdentityDatabase, 'execute'>,
    environment: { PERSONAL_POLYGON_RELAY_ENABLED: String(enabled), PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED: 'true', AUTH_BFF_SHARED_SECRET: secret,
      POLYGON_RELAYER_PRIVATE_KEY: `0x${'1'.repeat(64)}`, POLYGON_RELAY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), REOWN_PROJECT_ID: 'a'.repeat(32), PIMLICO_API_KEY: 'synthetic-key-123456' },
    fetchImpl: (async () => { throw Error('unexpected provider access'); }) as unknown as typeof fetch });
  return app;
}
test('relay ingress requires native session, BFF HMAC, exact personal origin and independent feature flag', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; return []; } });
  for (const action of ['capabilities', 'history', `status?paymentId=${id}`]) {
    const path = `${PREFIX}/${action}`;
    expect((await application({ signedIn: false }).request(path, signed(path))).status).toBe(401);
    expect((await app.request(path)).status).toBe(403);
    expect((await app.request(path, signed(path, 'GET', '', { origin: 'https://wallet.mindblisspower.com' }))).status).toBe(403);
    expect((await app.request(path, signed(path, 'GET', '', { 'x-vp-auth-signature': '0'.repeat(64) }))).status).toBe(403);
    expect((await application({ enabled: false }).request(path, signed(path))).status).toBe(503);
  }
  expect(calls).toBe(0);
  const path = `${PREFIX}/capabilities`, result = await app.request(path, signed(path));
  expect(await result.json()).toEqual({ walletKind: 'personal', executionMode: 'polygon_native_meta_aa', chainId: 137,
    transferEnabled: true, sponsorship: 'mindbliss', authorizationHasOnchainExpiry: false });
  expect(result.headers.get('cache-control')).toBe('private, no-store'); expect(result.headers.get('vary')).toBe('Cookie');
});
test('relay forms reject selectors, raw transaction instructions, forged statuses, unbounded or incorrectly encoded bodies before storage', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; throw Error('unexpected database access'); } });
  const inputs = { prepare: { requestId: id, amountAtomic: '30000000' }, authorize: { paymentId: id, signature: `0x${'2'.repeat(130)}` }, submit: { paymentId: id }, verify: { paymentId: id }, abandon: { paymentId: id } };
  for (const [action, payload] of Object.entries(inputs)) {
    const path = `${PREFIX}/${action}`;
    for (const extra of [{ subject: 'other' }, { recipientAddress: `0x${'2'.repeat(40)}` }, { tokenAddress: 'other' }, { chainId: 1 }, { status: 'confirmed' }, { userOperation: {} }, { rpcUrl: 'https://invalid.test' }]) {
      const raw = JSON.stringify({ ...payload, ...extra });
      expect((await app.request(path, signed(path, 'POST', raw))).status).toBe(400);
    }
    expect((await app.request(`${path}?subject=other`, signed(`${path}?subject=other`, 'POST', JSON.stringify(payload)))).status).toBe(400);
    expect((await app.request(path, signed(path, 'POST', JSON.stringify(payload), { 'content-type': 'text/plain' }))).status).toBe(415);
  }
  const path = `${PREFIX}/prepare`;
  expect((await app.request(path, signed(path, 'POST', 'x'.repeat(4097)))).status).toBe(413);
  expect(calls).toBe(0);
});
test('relay status/history queries cannot select another owner or parse duplicate/encoded identifiers; errors contain safe codes only', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; return []; } });
  for (const suffix of [`status?paymentId=${id}&subject=other`, `status?paymentId=${id}&paymentId=${id}`, `status?paymentId=%31${id.slice(1)}`,
    'history?owner=other', 'capabilities?chainId=1']) {
    const path = `${PREFIX}/${suffix}`; expect((await app.request(path, signed(path))).status).toBe(400);
  }
  expect(calls).toBe(0);
  const path = `${PREFIX}/history`, response = await app.request(path, signed(path)); expect(await response.json()).toEqual({ walletKind: 'personal', payments: [] });
  for (const [message, code, status] of [['polygon_relay_rate_limited', 'polygon_relay_rate_limited', 429], ['polygon_relay_queue_busy', 'polygon_relay_queue_busy', 409],
    ['polygon_relay_not_found', 'polygon_relay_not_found', 404], ['private SQL password RPC key signature', 'polygon_relay_unavailable', 503]] as const) {
    const result = await application({ execute: async () => { throw Error(message); } }).request(path, signed(path)); expect(result.status).toBe(status); expect(await result.json()).toEqual({ error: code });
  }
});
