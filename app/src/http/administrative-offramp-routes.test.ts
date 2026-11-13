import { Hono } from 'hono';
import { expect, test } from 'bun:test';
import type { Session } from '../auth';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiEnvironment } from './types';
import { registerAdministrativeOfframpRoutes } from './administrative-offramp-routes';

function fixture(subject: string | null = 'synthetic-owner', assigned = true) {
  let reads = 0, calls = 0;
  const database = { execute: async () => { reads++; return [{ status: assigned ? 'assigned' : 'exhausted',
    address: assigned ? `0x${'a'.repeat(40)}` : null, address_family: 'EVM', asset: 'USDT',
    checkout_reference: assigned ? 'd8a4c010-cc33-44da-a297-8b3c6440f491' : null,
    assigned_at: assigned ? new Date('2026-11-12T12:00:00Z') : null }]; } } as unknown as Pick<IdentityDatabase, 'execute'>;
  const fetchImpl = (async () => { calls++; return Response.json([]); }) as unknown as typeof fetch;
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => { context.set('session', subject ? { user: { id: subject } } as unknown as Session : null); await next(); });
  registerAdministrativeOfframpRoutes(app, { database, fetchImpl,
    environment: { MELD_ADMIN_SANDBOX_ENABLED: 'true', MELD_API_SANDBOX: 'synthetic-only-sandbox' } });
  return { app, counters: () => ({ reads, calls }) };
}
const path = 'https://auth.core.internal/api/member/wallet-funding/administrative/offramp/options';
const origin = { origin: 'https://wallet.mindblisspower.com' };

test('offramp catalog is authenticated and confined to the administrative portal', async () => {
  const anonymous = fixture(null), signed = fixture();
  expect((await anonymous.app.request(`${path}?country=US&destinationCurrencyCode=USD`, { headers: origin })).status).toBe(401);
  expect(anonymous.counters()).toEqual({ reads: 0, calls: 0 });
  expect((await signed.app.request(`${path}?country=US&destinationCurrencyCode=USD`, { headers: { origin: 'https://app.mindblisspower.com' } })).status).toBe(403);
  expect((await signed.app.request(`${path}?country=US&destinationCurrencyCode=USD`, { headers: { ...origin, 'x-vp-act-as': 'other-user' } })).status).toBe(403);
  expect((await signed.app.request(`${path}?country=US&destinationCurrencyCode=USD`, { headers: { ...origin, 'x-vp-act-as': '' } })).status).toBe(403);
  expect(signed.counters()).toEqual({ reads: 0, calls: 0 });
});

test('duplicate, extra and forged address query arguments cause no provider work', async () => {
  const f = fixture();
  for (const query of ['country=US&country=MX&destinationCurrencyCode=USD', 'country=US&destinationCurrencyCode=USD&walletAddress=forged', 'country=US&destinationCurrencyCode=USD&subject=someone-else', 'country=CO&destinationCurrencyCode=MXN']) {
    expect((await f.app.request(`${path}?${query}`, { headers: origin })).status).toBe(400);
  }
  expect(f.counters()).toEqual({ reads: 0, calls: 0 });
});

test('only an assigned owner can read the catalog; a successful empty catalog cannot authorize spending', async () => {
  const pending = fixture('synthetic-owner', false), assigned = fixture();
  expect((await pending.app.request(`${path}?country=US&destinationCurrencyCode=USD`, { headers: origin })).status).toBe(409);
  expect(pending.counters().calls).toBe(0);
  const response = await assigned.app.request(`${path}?country=US&destinationCurrencyCode=USD`, { headers: origin });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const data = await response.json() as { routes: unknown[]; execution: { canTransfer: boolean; canCreateSession: boolean } };
  expect(data.routes).toEqual([]);
  expect(data.execution.canTransfer).toBe(false);
  expect(data.execution.canCreateSession).toBe(false);
  expect(assigned.counters()).toEqual({ reads: 1, calls: 1 });
});
