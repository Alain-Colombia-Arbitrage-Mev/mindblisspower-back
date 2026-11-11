import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { ApiEnvironment } from './types';
import type { IdentityDatabase } from '../modules/identity/model';
import { registerPersonalCompanyPaymentRoutes } from './personal-company-payment-routes';
import { COMPANY_PAYMENT_RECIPIENT, COMPANY_PAYMENT_TOKEN } from '../modules/payments/personal-company-rpc';
const PREFIX = '/api/member/company-payments', id = '11111111-1111-4111-8111-111111111111', secret = 's'.repeat(48);
const address = `0x${'2'.repeat(40)}`, hash = `0x${'3'.repeat(64)}`;
const row = { id, wallet_address: address, recipient_address: COMPANY_PAYMENT_RECIPIENT, chain_id: 137,
  token_address: COMPANY_PAYMENT_TOKEN, token_decimals: 6, amount_atomic: '20000000', status: 'prepared',
  expires_at: new Date('2026-11-10T20:15:00Z'), created_at: new Date('2026-11-10T20:00:00Z'), transaction_hash: null,
  block_number: null, block_hash: null, confirmations: 0, failure_reason: null, abandoned_at: null };
function signed(path: string, method = 'GET', body = '', extra: Record<string, string> = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000)), ip = '192.0.2.1', cookie = 'better-auth.session_token=synthetic';
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const message = [method, path.split('?')[0], timestamp, ip, digest(cookie), digest(body)].join('\n');
  return { method, headers: { origin: 'https://app.mindblisspower.com', cookie, 'content-type': 'application/json',
    'x-vp-auth-client-ip': ip, 'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': createHmac('sha256', secret).update(message).digest('hex'), ...extra },
    ...(method === 'POST' ? { body } : {}) };
}
function application({ signedIn = true, enabled = true, execute = async () => [] }: {
  signedIn?: boolean; enabled?: boolean; execute?: (input: unknown) => Promise<unknown[]>;
} = {}) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => { context.set('session', signedIn ? { user: { id: 'owner' } } as never : null); await next(); });
  registerPersonalCompanyPaymentRoutes(app, { database: { execute } as Pick<IdentityDatabase, 'execute'>,
    environment: { PERSONAL_COMPANY_PAYMENTS_ENABLED: String(enabled), AUTH_BFF_SHARED_SECRET: secret, REOWN_PROJECT_ID: 'a'.repeat(32) },
    fetchImpl: (async () => { throw Error('unexpected external call'); }) as unknown as typeof fetch });
  return app;
}
test('company payment endpoints require a native session and valid signed BFF envelope before any database access', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; return [row]; } });
  for (const path of [`${PREFIX}/status?paymentId=${id}`, `${PREFIX}/history`]) {
    expect((await application({ signedIn: false }).request(path, signed(path))).status).toBe(401);
    expect((await app.request(path)).status).toBe(403);
    expect((await app.request(path, signed(path, 'GET', '', { 'x-vp-auth-signature': '0'.repeat(64) }))).status).toBe(403);
    expect((await app.request(path, signed(path, 'GET', '', { origin: 'https://wallet.mindblisspower.com' }))).status).toBe(403);
    expect((await application({ enabled: false }).request(path, signed(path))).status).toBe(503);
  }
  expect(calls).toBe(0);
});
test('only the personal portal may mutate a payment and all input selectors are strict and bounded', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; throw Error('unexpected database access'); } });
  const path = `${PREFIX}/prepare`, input = { requestId: id, amountAtomic: '20000000' }, body = JSON.stringify(input);
  for (const origin of ['https://wallet.mindblisspower.com', 'https://mindblisspower.com', 'https://app.mindblisspower.com.evil.test']) {
    expect((await app.request(path, signed(path, 'POST', body, { origin }))).status).toBe(403);
  }
  for (const extra of [{ recipientAddress: address }, { walletAddress: address }, { subject: 'other' }, { chainId: 1 }, { amountAtomic: '01' }]) {
    const raw = JSON.stringify({ ...input, ...extra });
    expect((await app.request(path, signed(path, 'POST', raw))).status).toBe(400);
  }
  expect((await app.request(path, signed(path, 'POST', body, { 'content-type': 'text/plain' }))).status).toBe(415);
  expect((await app.request(path, signed(path, 'POST', ' '.repeat(2049)))).status).toBe(413);
  expect(calls).toBe(0);
});
test('owned status and recovery history are uncached and cannot select another owner or forge confirmation', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; return [row]; } });
  const path = `${PREFIX}/status?paymentId=${id}`;
  const response = await app.request(path, signed(path));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toMatchObject({ paymentId: id, status: 'prepared', transactionHash: null, membershipAssignment: 'pending' });
  const history = `${PREFIX}/history`, listed = await app.request(history, signed(history));
  expect(listed.status).toBe(200); expect(await listed.json()).toMatchObject({ walletKind: 'personal', membershipAssignment: 'pending' });
  for (const query of [`?paymentId=${id}&subject=other`, `?paymentId=${id}&paymentId=${id}`, `?paymentId=%31${id.slice(1)}`]) {
    const route = `${PREFIX}/status${query}`; expect((await app.request(route, signed(route))).status).toBe(400);
  }
  expect(calls).toBe(2);
});
test('safe conflicts and provider unavailability are returned without leaking SQL or RPC details', async () => {
  const path = `${PREFIX}/submit`, body = JSON.stringify({ paymentId: id, transactionHash: hash });
  for (const [message, status, error] of [['company_payment_hash_reused', 409, 'company_payment_hash_reused'],
    ['company_payment_pending_exists', 409, 'company_payment_pending_exists'],
    ['private PostgreSQL password and RPC response', 503, 'company_payment_unavailable']] as const) {
    const app = application({ execute: async () => { throw Error(message); } });
    const response = await app.request(path, signed(path, 'POST', body));
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error });
  }
  const wrapped = application({ execute: async () => { throw new Error('private SQL statement', { cause: new Error('company_payment_pending_exists') }); } });
  const response = await wrapped.request(path, signed(path, 'POST', body));
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'company_payment_pending_exists' });
});

test('abandon uses the same personal native-session signature boundary and cannot abandon submitted payments', async () => {
  const path = `${PREFIX}/abandon`, body = JSON.stringify({ paymentId: id });
  const abandonedAt = new Date('2026-11-10T20:01:00Z');
  const app = application({ execute: async () => [{ ...row, abandoned_at: abandonedAt }] });
  const accepted = await app.request(path, signed(path, 'POST', body));
  expect(accepted.status).toBe(200); expect(await accepted.json()).toMatchObject({ paymentId: id, abandonedAt: abandonedAt.toISOString() });
  expect((await app.request(path, signed(path, 'POST', body, { origin: 'https://wallet.mindblisspower.com' }))).status).toBe(403);
  const terminal = application({ execute: async () => { throw Error('company_payment_invalid_transition'); } });
  const rejected = await terminal.request(path, signed(path, 'POST', body));
  expect(rejected.status).toBe(409); expect(await rejected.json()).toEqual({ error: 'company_payment_invalid_transition' });
});
