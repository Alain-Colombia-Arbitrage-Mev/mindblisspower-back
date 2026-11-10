import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { registerWalletFundingRoutes } from './wallet-funding-routes';
import type { ApiEnvironment } from './types';
import type { IdentityDatabase } from '../modules/identity/model';
import { createHash, createHmac } from 'node:crypto';

const origin = 'https://app.example.test';
const personalPath = '/api/member/wallet-funding/personal/intent';
const administrativePath = '/api/member/wallet-funding/administrative/session';
const input = { requestId: '6d492c47-80be-4e14-bc5f-54afaa56fc23', walletAddress: `0x${'2'.repeat(40)}`, country: 'US', amount: 100 };
const secret = 's'.repeat(48);

function signedRequest(path: string, body: string, extraHeaders: Record<string, string> = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const ip = '192.0.2.1';
  const cookie = 'better-auth.session_token=synthetic';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const signature = createHmac('sha256', secret).update(['POST', path, timestamp, ip, hash(cookie), hash(body)].join('\n')).digest('hex');
  return { method: 'POST', headers: { origin, 'content-type': 'application/json', cookie,
    'x-vp-auth-client-ip': ip, 'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': signature, ...extraHeaders }, body };
}

function application({ signedIn = true, execute = async () => [] }: { signedIn?: boolean; execute?: (input: unknown) => Promise<unknown[]> } = {}) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => {
    context.set('session', signedIn ? { user: { id: 'synthetic-owner' } } as never : null);
    await next();
  });
  registerWalletFundingRoutes(app, { database: { execute } as Pick<IdentityDatabase, 'execute'>,
    environment: { BETTER_AUTH_URL: origin, AUTH_BFF_SHARED_SECRET: secret },
    fetchImpl: (async () => { throw new Error('unexpected provider call'); }) as unknown as typeof fetch });
  return app;
}

test('funding mutations require a native session, exact origin and bounded strict JSON before database work', async () => {
  let calls = 0;
  const app = application({ execute: async () => { calls++; throw new Error('unexpected database call'); } });
  for (const path of [personalPath, administrativePath]) {
    const absent = application({ signedIn: false });
    expect((await absent.request(path, { method: 'POST' })).status).toBe(401);
    expect((await app.request(path, signedRequest(path, '{}', { origin: 'https://other.test' }))).status).toBe(403);
    expect((await app.request(path, signedRequest(path, '{}', { 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await app.request(path, signedRequest(path, ' '.repeat(4097)))).status).toBe(413);
    expect((await app.request(path, signedRequest(path, JSON.stringify({ ...input, subject: 'other-owner' })))).status).toBe(400);
  }
  expect(calls).toBe(0);
});

test('personal funding returns an uncached initiated acknowledgement while sandbox configuration fails safely', async () => {
  const app = application({ execute: async () => [{ id: input.requestId, created_at: new Date('2026-11-10T20:00:00Z') }] });
  const response = await app.request(personalPath, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect((await response.json() as { environment: string }).environment).toBe('production');
  const sandbox = await app.request(administrativePath, signedRequest(administrativePath, JSON.stringify({ ...input, serviceProvider: 'TRANSAK' })));
  expect(sandbox.status).toBe(503);
  expect(await sandbox.json()).toEqual({ error: 'wallet_funding_unconfigured' });
});

test('the administrative provider IP must come from a signed proxy envelope bound to path, cookie and body', async () => {
  let calls = 0;
  const app = application({ execute: async () => { calls++; throw new Error('unexpected database call'); } });
  const body = JSON.stringify({ ...input, serviceProvider: 'TRANSAK' });
  const mutations: Record<string, string>[] = [{ 'x-vp-auth-client-ip': '198.51.100.1' }, { 'x-vp-auth-signature': '0'.repeat(64) },
    { 'x-vp-auth-timestamp': '1000000000' }, { cookie: 'better-auth.session_token=other-session' }];
  for (const headers of mutations) {
    expect((await app.request(administrativePath, signedRequest(administrativePath, body, headers))).status).toBe(403);
  }
  const changedBody = { ...signedRequest(administrativePath, body), body: JSON.stringify({ ...input, amount: 250, serviceProvider: 'TRANSAK' }) };
  expect((await app.request(administrativePath, changedBody)).status).toBe(403);
  expect(calls).toBe(0);
});

test('history rejects owner selectors, duplicate query keys, missing sessions and arbitrary database diagnostics', async () => {
  let calls = 0;
  const app = application({ execute: async () => { calls++; throw new Error('postgres://private:secret@private-target'); } });
  for (const query of ['', '?walletKind=personal&subject=other', '?walletKind=personal&walletKind=administrative', '?walletKind=other']) {
    expect((await app.request(`/api/member/wallet-funding/history${query}`)).status).toBe(400);
  }
  expect(calls).toBe(0);
  const response = await app.request('/api/member/wallet-funding/history?walletKind=personal');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'wallet_funding_unavailable' });
  expect((await application({ signedIn: false }).request('/api/member/wallet-funding/history?walletKind=personal')).status).toBe(401);
});

test('administrative options require a session and one exact country/provider without account selectors', async () => {
  const app = application();
  const path = '/api/member/wallet-funding/administrative/options';
  for (const query of ['', '?country=US&serviceProvider=TOPPER', '?country=US&country=CO&serviceProvider=TRANSAK',
    '?country=US&serviceProvider=TRANSAK&subject=other']) {
    expect((await app.request(path + query)).status).toBe(400);
  }
  expect((await application({ signedIn: false }).request(path + '?country=US&serviceProvider=TRANSAK')).status).toBe(401);
  const response = await app.request(path + '?country=US&serviceProvider=TRANSAK');
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ error: 'wallet_funding_unconfigured' });
});
