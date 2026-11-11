import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { ApiEnvironment } from './types';
import type { IdentityDatabase } from '../modules/identity/model';
import { registerPersonalCompanyPaymentRoutes } from './personal-company-payment-routes';
import { COMPANY_PAYMENT_RECIPIENT, COMPANY_PAYMENT_TOKEN } from '../modules/payments/personal-company-rpc';
const PREFIX = '/api/member/company-payments', id = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222', secret = 's'.repeat(48);
const row = { event_id: eventId, payment_id: id, attempt_id: null, source: 'client_reported', event: 'wallet_failed', canonical_status: null,
  chain_id: 1, token_address: COMPANY_PAYMENT_TOKEN, wallet_address: `0x${'3'.repeat(40)}`, recipient_address: COMPANY_PAYMENT_RECIPIENT,
  amount_atomic: '30000000', transaction_hash: null, code: null, created_at: new Date('2026-11-11T04:00:00Z') };
function signed(path: string, method = 'GET', raw = '', extra: Record<string, string> = {}) {
  const ip = '192.0.2.1', timestamp = String(Math.floor(Date.now() / 1000)), cookie = 'better-auth.session_token=synthetic';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const signature = createHmac('sha256', secret).update([method, path.split('?')[0], timestamp, ip, hash(cookie), hash(raw)].join('\n')).digest('hex');
  return { method, headers: { cookie, origin: 'https://app.mindblisspower.com', 'content-type': 'application/json',
    'x-vp-auth-client-ip': ip, 'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': signature, ...extra }, ...(method === 'POST' ? { body: raw } : {}) };
}
function application({ signedIn = true, enabled = true, execute = async () => [row] }: {
  signedIn?: boolean; enabled?: boolean; execute?: () => Promise<unknown[]>;
} = {}) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => { context.set('session', signedIn ? { user: { id: 'owner' } } as never : null); await next(); });
  registerPersonalCompanyPaymentRoutes(app, { database: { execute } as unknown as Pick<IdentityDatabase, 'execute'>,
    environment: { PERSONAL_COMPANY_PAYMENTS_ENABLED: String(enabled), AUTH_BFF_SHARED_SECRET: secret },
    fetchImpl: (async () => { throw Error('journal contacted a provider'); }) as unknown as typeof fetch });
  return app;
}

test('journal ingress and both readers preserve native session, signed BFF, personal origin and enabled capability gates', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; return [row]; } });
  const payload = JSON.stringify({ eventId, paymentId: id, event: 'wallet_failed' });
  for (const [path, method, raw] of [[`${PREFIX}/events`, 'POST', payload], [`${PREFIX}/events?paymentId=${id}`, 'GET', ''], [`${PREFIX}/activity`, 'GET', '']]) {
    expect((await application({ signedIn: false }).request(path!, signed(path!, method, raw))).status).toBe(401);
    expect((await app.request(path!, signed(path!, method, raw, { origin: 'https://wallet.mindblisspower.com' }))).status).toBe(403);
    expect((await app.request(path!, signed(path!, method, raw, { 'x-vp-auth-signature': '0'.repeat(64) }))).status).toBe(403);
    expect((await application({ enabled: false }).request(path!, signed(path!, method, raw))).status).toBe(503);
  }
  expect(calls).toBe(0);
});

test('journal never accepts client confirmation, source, owner, balance, signature, timestamp or arbitrary error payloads', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; return [row]; } }), path = `${PREFIX}/events`;
  for (const extra of [{ event: 'confirmed' }, { source: 'canonical' }, { subject: 'other' }, { chainId: 137 }, { amountAtomic: '1' },
    { signature: 'private' }, { recordedAt: '2026-11-11T04:00:00Z' }, { code: 'private provider detail' }, { event: 'broadcast_observed' }]) {
    const raw = JSON.stringify({ eventId, paymentId: id, event: 'wallet_failed', ...extra });
    expect((await app.request(path, signed(path, 'POST', raw))).status).toBe(400);
  }
  expect((await app.request(path, signed(path, 'POST', 'x'.repeat(2049)))).status).toBe(413);
  expect((await app.request(path, signed(path, 'POST', '{}', { 'content-type': 'text/plain' }))).status).toBe(415);
  expect(calls).toBe(0);
  const valid = JSON.stringify({ eventId, paymentId: id, event: 'wallet_failed' });
  const response = await app.request(path, signed(path, 'POST', valid));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ walletKind: 'personal', eventId, paymentId: id, attemptId: null,
    source: 'client_reported', event: 'wallet_failed', recordedAt: row.created_at.toISOString() });
});

test('root and app journals admit only signed client reports without promoting payment state', async () => {
  let calls = 0;
  const app = application({ execute: async () => { calls++; return [row]; } });
  const path = `${PREFIX}/events`, raw = JSON.stringify({ eventId, paymentId: id, event: 'wallet_failed' });
  for (const origin of ['https://mindblisspower.com', 'https://app.mindblisspower.com']) {
    const response = await app.request(path, signed(path, 'POST', raw, { origin }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: 'client_reported', event: 'wallet_failed' });
    const forged = JSON.stringify({ eventId, paymentId: id, event: 'confirmed' });
    expect((await app.request(path, signed(path, 'POST', forged, { origin }))).status).toBe(400);
  }
  expect(calls).toBe(2);
});

test('journal pagination rejects duplicate, encoded, cross-owner and arbitrary selectors while preserving uncached activity', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; return [row]; } });
  for (const path of [`${PREFIX}/events`, `${PREFIX}/events?paymentId=${id}&subject=other`, `${PREFIX}/events?paymentId=${id}&paymentId=${id}`,
    `${PREFIX}/events?paymentId=%31${id.slice(1)}`, `${PREFIX}/activity?paymentId=${id}`, `${PREFIX}/activity?cursor=no`,
    `${PREFIX}/activity?limit=0`, `${PREFIX}/activity?limit=51`, `${PREFIX}/activity?limit=01`, `${PREFIX}/activity?walletAddress=${row.wallet_address}`]) {
    expect((await app.request(path, signed(path))).status).toBe(400);
  }
  expect(calls).toBe(0);
  for (const path of [`${PREFIX}/activity?limit=50&cursor=${eventId}`, `${PREFIX}/events?paymentId=${id}&limit=1`]) {
    const response = await app.request(path, signed(path));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ walletKind: 'personal', events: [{ eventId, canonicalStatus: null }], nextCursor: null });
  }
  expect(calls).toBe(2);
});

test('owned journal conflict, rate limit and invalid cursor errors are safe and cannot leak SQL or promote payment state', async () => {
  const path = `${PREFIX}/events`, raw = JSON.stringify({ eventId, paymentId: id, event: 'wallet_failed' });
  for (const [message, status, code] of [['company_payment_event_conflict', 409, 'company_payment_event_conflict'],
    ['company_payment_rate_limited', 429, 'company_payment_rate_limited'], ['company_payment_invalid_cursor', 400, 'company_payment_invalid_cursor'],
    ['private SQL details and credentials', 503, 'company_payment_unavailable']] as const) {
    const response = await application({ execute: async () => { throw new Error(message); } }).request(path, signed(path, 'POST', raw));
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code });
  }
});
