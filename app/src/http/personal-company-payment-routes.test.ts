import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { ApiEnvironment } from './types';
import type { IdentityDatabase } from '../modules/identity/model';
import { registerPersonalCompanyPaymentRoutes } from './personal-company-payment-routes';
import { COMPANY_PAYMENT_RECIPIENT, COMPANY_PAYMENT_TOKEN, LEGACY_POLYGON_TOKEN } from '../modules/payments/personal-company-rpc';
const PREFIX = '/api/member/company-payments', id = '11111111-1111-4111-8111-111111111111', secret = 's'.repeat(48);
const address = `0x${'2'.repeat(40)}`, hash = `0x${'3'.repeat(64)}`;
const row = { id, wallet_address: address, recipient_address: COMPANY_PAYMENT_RECIPIENT, chain_id: 1,
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
function application({ signedIn = true, enabled = true, execute = async () => [], fetchImpl = (async () => { throw Error('unexpected external call'); }) as unknown as typeof fetch }: {
  signedIn?: boolean; enabled?: boolean; execute?: (input: unknown) => Promise<unknown[]>; fetchImpl?: typeof fetch;
} = {}) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => { context.set('session', signedIn ? { user: { id: 'owner' } } as never : null); await next(); });
  registerPersonalCompanyPaymentRoutes(app, { database: { execute } as Pick<IdentityDatabase, 'execute'>,
    environment: { PERSONAL_COMPANY_PAYMENTS_ENABLED: String(enabled), AUTH_BFF_SHARED_SECRET: secret, REOWN_PROJECT_ID: 'a'.repeat(32) },
    fetchImpl });
  return app;
}
test('company payment endpoints require a native session and valid signed BFF envelope before any database access', async () => {
  let calls = 0; const app = application({ execute: async () => { calls++; return [row]; } });
  for (const path of [`${PREFIX}/status?paymentId=${id}`, `${PREFIX}/history`, `${PREFIX}/balance`, `${PREFIX}/balances`]) {
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
  for (const origin of ['https://wallet.mindblisspower.com', 'https://mindblisspower.com.evil.test', 'https://app.mindblisspower.com.evil.test',
    'http://mindblisspower.com', 'https://mindblisspower.com:443', 'https://mindblisspower.com/']) {
    expect((await app.request(path, signed(path, 'POST', body, { origin }))).status).toBe(403);
  }
  for (const extra of [{ recipientAddress: address }, { walletAddress: address }, { subject: 'other' }, { chainId: 56 }, { amountAtomic: '01' }]) {
    const raw = JSON.stringify({ ...input, ...extra });
    expect((await app.request(path, signed(path, 'POST', raw))).status).toBe(400);
  }
  expect((await app.request(path, signed(path, 'POST', body, { 'content-type': 'text/plain' }))).status).toBe(415);
  expect((await app.request(path, signed(path, 'POST', ' '.repeat(2049)))).status).toBe(413);
  expect(calls).toBe(0);
});

test('root and app personal portals keep the same owned recovery and strict mutation contract', async () => {
  let calls = 0;
  const app = application({ execute: async () => { calls++; return [row]; } });
  for (const origin of ['https://mindblisspower.com', 'https://app.mindblisspower.com']) {
    const path = `${PREFIX}/history`, response = await app.request(path, signed(path, 'GET', '', { origin }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const prepare = `${PREFIX}/prepare`, raw = JSON.stringify({ requestId: id, amountAtomic: '1', subject: 'other' });
    expect((await app.request(prepare, signed(prepare, 'POST', raw, { origin }))).status).toBe(400);
    expect((await app.request(path, signed(path, 'GET', '', { origin, 'x-vp-auth-signature': '0'.repeat(64) }))).status).toBe(403);
  }
  expect(calls).toBe(2);
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


test('balance is an uncached owner-only Ethereum read with no address, chain, token, body or mutation selectors', async () => {
  const path = `${PREFIX}/balance`, created = new Date('2026-11-10T20:00:00Z');
  const principal = { subject: 'owner', auth_email: 'synthetic@example.invalid', email_verified: true, person_id: '1', public_id: '1',
    person_email: 'synthetic@example.invalid', person_status: 'active', user_id: 'owner', blacklisted: false, access_restricted: false };
  const rows: unknown[][] = [[principal], [{ address, chain_id: 1, verified_at: created }]];
  const app = application({ execute: async () => { if (!rows.length) throw Error('unexpected write'); return rows.shift()!; },
    fetchImpl: (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const result = request.method === 'eth_chainId' ? '0x1' : request.method === 'eth_getBalance' ? '0x0'
        : `0x${(request.params[0].data === '0x313ce567' ? '6' : '0').padStart(64, '0')}`;
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }) as typeof fetch });
  const response = await app.request(path, signed(path));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(await response.json()).toEqual({ walletKind: 'personal', walletAddress: address, chainId: 1, tokenAddress: COMPANY_PAYMENT_TOKEN,
    tokenDecimals: 6, asset: 'USDT', network: 'ethereum', balanceAtomic: '0', nativeBalanceAtomic: '0', observedAt: expect.any(String) });
  let reads = 0;
  const blocked = application({ execute: async () => { reads++; throw Error('selector reached database'); } });
  for (const query of [`?walletAddress=${address}`, '?chainId=137', `?tokenAddress=${COMPANY_PAYMENT_TOKEN}`, '?subject=other', '?', '?paymentId=x']) {
    const target = path + query;
    if (query === '?') continue; // URL normalizes an empty query to no selector.
    expect((await blocked.request(target, signed(target))).status).toBe(400);
  }
  expect((await blocked.request(path, signed(path, 'GET', '', { 'content-encoding': 'gzip' }))).status).toBe(400);
  expect((await blocked.request(path, signed(path, 'POST', '{}'))).status).toBe(404);
  expect(reads).toBe(0);
});


test('dual balances retain native owner isolation, reject selectors and keep healthy network data when the other RPC fails', async () => {
  const path = `${PREFIX}/balances`, created = new Date('2026-11-10T20:00:00Z');
  const principal = { subject: 'owner', auth_email: 'synthetic@example.invalid', email_verified: true, person_id: '1', public_id: '1',
    person_email: 'synthetic@example.invalid', person_status: 'active', user_id: 'owner', blacklisted: false, access_restricted: false };
  const rows: unknown[][] = [[principal], [{ address, chain_id: 1, verified_at: created }]];
  const app = application({ execute: async () => { if (!rows.length) throw Error('unexpected write'); return rows.shift()!; },
    fetchImpl: (async (target, init) => {
      if (new URL(String(target)).searchParams.get('chainId') === 'eip155:137') throw Error('private upstream detail');
      const request = JSON.parse(String(init?.body));
      const result = request.method === 'eth_chainId' ? '0x1' : request.method === 'eth_getBalance' ? '0x0'
        : `0x${(request.params[0].data === '0x313ce567' ? '6' : '989680').padStart(64, '0')}`;
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }) as typeof fetch });
  const response = await app.request(path, signed(path));
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('vary')).toBe('Cookie');
  const payload = await response.json();
  expect(payload).toMatchObject({ walletKind: 'personal', walletAddress: address, balances: [
    { chainId: 1, network: 'ethereum', balanceAtomic: '10000000', nativeBalanceAtomic: '0' },
    { chainId: 137, network: 'polygon', balanceAtomic: null, nativeBalanceAtomic: null, observedAt: null, error: 'company_payment_rpc_unavailable' },
  ] });
  expect(JSON.stringify(payload)).not.toContain('private upstream detail');
  let reads = 0;
  const blocked = application({ execute: async () => { reads++; throw Error('selector reached database'); } });
  for (const query of [`?walletAddress=${address}`, '?chainId=137', `?tokenAddress=${COMPANY_PAYMENT_TOKEN}`, '?subject=other']) {
    const target = path + query; expect((await blocked.request(target, signed(target))).status).toBe(400);
  }
  expect((await blocked.request(path, signed(path, 'POST', '{}'))).status).toBe(404);
  expect((await blocked.request(path, signed(path, 'GET', '', { 'content-encoding': 'gzip' }))).status).toBe(400);
  expect(reads).toBe(0);
});


test('HTTP new preparation requires explicit Polygon and reports a safe network change for old Ethereum clients', async () => {
  const path = `${PREFIX}/prepare`, created = new Date('2026-11-10T20:00:00Z');
  const principal = { subject: 'owner', auth_email: 'synthetic@example.invalid', email_verified: true, person_id: '1', public_id: '1',
    person_email: 'synthetic@example.invalid', person_status: 'active', user_id: 'owner', blacklisted: false, access_restricted: false };
  for (const selector of [undefined, 1, 137]) {
    const chainId = selector ?? 1, token = chainId === 1 ? COMPANY_PAYMENT_TOKEN : LEGACY_POLYGON_TOKEN;
    const rows: unknown[][] = [[], [principal], [{ address, chain_id: 1, verified_at: created }], [{ ...row, chain_id: chainId, token_address: token }]];
    const app = application({ execute: async () => { if (!rows.length) throw Error('unexpected write'); return rows.shift()!; },
      fetchImpl: (async (target, init) => {
        expect(new URL(String(target)).searchParams.get('chainId')).toBe(`eip155:${chainId}`);
        const request = JSON.parse(String(init?.body));
        if (request.method === 'eth_call') expect(request.params[0].to).toBe(token);
        const result = request.method === 'eth_chainId' ? (chainId === 1 ? '0x1' : '0x89')
          : `0x${(request.params[0].data === '0x313ce567' ? '6' : '1312d00').padStart(64, '0')}`;
        return Response.json({ jsonrpc: '2.0', id: request.id, result });
      }) as typeof fetch });
    const body = JSON.stringify({ requestId: id, amountAtomic: row.amount_atomic, ...(selector === undefined ? {} : { chainId: selector }) });
    const response = await app.request(path, signed(path, 'POST', body));
    if (chainId === 1) {
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'company_payment_network_changed' });
      expect(rows).toHaveLength(3);
      continue;
    }
    expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ chainId, tokenAddress: token, recipientAddress: COMPANY_PAYMENT_RECIPIENT, amountAtomic: row.amount_atomic });
  }
  let calls = 0;
  const blocked = application({ execute: async () => { calls++; throw Error('invalid policy reached database'); } });
  for (const extra of [{ chainId: null }, { chainId: '1' }, { chainId: 56 }, { chainId: 137, tokenAddress: COMPANY_PAYMENT_TOKEN }, { chainId: 137, rpcUrl: 'https://evil.invalid' }]) {
    const body = JSON.stringify({ requestId: id, amountAtomic: row.amount_atomic, ...extra });
    expect((await blocked.request(path, signed(path, 'POST', body))).status).toBe(400);
  }
  expect(calls).toBe(0);
});
