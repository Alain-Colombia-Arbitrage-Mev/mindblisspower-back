import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { registerWalletLinkRoutes } from './wallet-link-routes';
import type { ApiEnvironment } from './types';
import type { IdentityDatabase } from '../modules/identity/model';

const origin = 'https://app.mindblisspower.com';
const address = `0x${'2'.repeat(40)}`;
const principal = { subject: 'member', auth_email: 'synthetic@example.invalid', email_verified: true, name: 'Synthetic',
  person_id: '1', public_id: 'synthetic-public', person_email: 'synthetic@example.invalid', person_status: 'active',
  blacklisted: false, user_id: 'member', is_admin: false, access_restricted: false };

function application({ signedIn = true, rows = [[principal], []] as unknown[][], error = undefined as unknown } = {}) {
  let calls = 0;
  const diagnostics: unknown[] = [];
  const database = { execute: async () => {
    calls++; if (error) throw error;
    if (!rows.length) throw new Error('unexpected synthetic database call');
    return rows.shift();
  }, transaction: async (callback: (value: unknown) => unknown) => callback(database) } as unknown as IdentityDatabase;
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => { context.set('session', signedIn ? { user: { id: 'member' } } as never : null); await next(); });
  registerWalletLinkRoutes(app, { database, environment: { BETTER_AUTH_URL: origin }, diagnostic: event => diagnostics.push(event) });
  return { app, diagnostics, calls: () => calls };
}

test('wallet status uses native identity and an absent binding is unlinked without issuing any challenge', async () => {
  const { app, calls, diagnostics } = application();
  const result = await app.request('/api/member/wallet-link');
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(await result.json()).toEqual({ linked: false });
  expect(calls()).toBe(2);
  expect(diagnostics).toEqual([]);
});

test('native session, exact origin and strict challenge/confirm input precede all identity database calls', async () => {
  const { app, calls } = application();
  const absent = application({ signedIn: false });
  for (const path of ['/api/member/wallet-link/challenge', '/api/member/wallet-link/confirm']) {
    expect((await absent.app.request(path, { method: 'POST' })).status).toBe(401);
    expect((await app.request(path, { method: 'POST', headers: { origin: 'https://other.example.test', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await app.request(path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ address, subject: 'other' }) })).status).toBe(400);
  }
  expect((await absent.app.request('/api/member/wallet-link')).status).toBe(401);
  expect(calls()).toBe(0);
  expect(absent.calls()).toBe(0);
});

test('failed link stages expose a correlation id and only an allowlisted SQLSTATE in private diagnostics', async () => {
  const privateError = new Error('postgres://private:secret@db.invalid private@example.invalid signature=private');
  Object.assign(privateError, { cause: Object.assign(new Error('private query'), { code: '42501' }) });
  for (const [path, phase, body] of [['/api/member/wallet-link', 'status', undefined],
    ['/api/member/wallet-link/challenge', 'challenge', { address }],
    ['/api/member/wallet-link/confirm', 'confirm', { challengeId: '11111111-1111-4111-8111-111111111111', signature: `0x${'1'.repeat(130)}` }]] as const) {
    const { app, diagnostics } = application({ error: privateError });
    const result = await app.request(path, body ? { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: 'wallet_link_unavailable' });
    expect(result.headers.get('x-mindbliss-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(diagnostics).toEqual([{ event: 'wallet_link_failure', phase, requestId: result.headers.get('x-mindbliss-request-id'), status: 503, code: '42501' }]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/private|secret|postgres:|signature|0x|@/);
  }
});
