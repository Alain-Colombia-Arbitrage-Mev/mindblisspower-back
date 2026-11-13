import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { Wallet } from 'ethers';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { registerSandboxWalletRoutes } from './sandbox-wallet-routes';
import { sandboxWalletOwnershipMessage, type SandboxWalletDatabase } from '../modules/identity/sandbox-wallet';
import type { ApiEnvironment } from './types';

const prefix = '/api/member/sandbox-wallet', origin = 'https://wallet.mindblisspower.com', subject = 'synthetic-owner', nativeSessionId = 'synthetic-session';
const secret = 's'.repeat(48), id = '6d492c47-80be-4e14-bc5f-54afaa56fc23', signer = new Wallet(`0x${'1'.repeat(64)}`), address = signer.address.toLowerCase();
const environment = { WALLET_SANDBOX_REOWN_ENABLED: 'true', MELD_ADMIN_SANDBOX_ENABLED: 'true', MELD_API_SANDBOX: 'synthetic-key', MELD_ACCOUNT_ID: 'synthetic-account' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ownerHeader = { 'x-mindbliss-sandbox-subject': encodeURIComponent(subject) };
function signed(path: string, value: unknown, headers = {}) {
  const body = JSON.stringify(value), timestamp = String(Math.floor(Date.now() / 1000)), ip = '192.0.2.1', cookie = 'better-auth.session_token=synthetic';
  const signature = createHmac('sha256', secret).update(['POST', path, timestamp, ip, hash(cookie), hash(body)].join('\n')).digest('hex');
  return { method: 'POST', body, headers: { origin, cookie, 'content-type': 'application/json', 'x-vp-auth-client-ip': ip,
    'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': signature, ...ownerHeader, ...headers } };
}
function application({ authenticated = true, native = true, enabled = true, execute = async () => [], fetchImpl = (async () => { throw Error('no external call'); }) as unknown as typeof fetch }: {
  authenticated?: boolean; native?: boolean; enabled?: boolean; execute?: (query: SQL) => Promise<unknown[]>; fetchImpl?: typeof fetch;
} = {}) {
  const app = new Hono<ApiEnvironment>(); app.use('*', async (context, next) => {
    context.set('session', authenticated ? { user: { id: subject }, ...(native ? { session: { id: nativeSessionId } } : {}) } as never : null); await next();
  });
  registerSandboxWalletRoutes(app, { database: { execute } as unknown as SandboxWalletDatabase,
    environment: { AUTH_BFF_SHARED_SECRET: secret, ...(enabled ? environment : {}) }, fetchImpl });
  return app;
}
test('wallet-only native routes reject absent/foreign origins, acting-as and missing actual native sessions before querying', async () => {
  let queries = 0; const app = application({ execute: async () => { queries++; throw Error('no DB'); }, enabled: false });
  for (const suffix of ['/capabilities', '/status', '/funding/options?country=US&sourceCurrencyCode=USD', '/funding/status?checkoutReference=' + id, '/funding/history']) {
    for (const headers of [{}, { origin: 'https://app.mindblisspower.com' }, { origin, 'x-vp-act-as': '' }] as Record<string, string>[]) {
      expect((await app.request(prefix + suffix, { headers })).status).toBe(403);
    }
    expect((await application({ authenticated: false }).request(prefix + suffix, { headers: { origin, ...ownerHeader } })).status).toBe(401);
    expect((await application({ native: false }).request(prefix + suffix, { headers: { origin, ...ownerHeader } })).status).toBe(401);
  }
  const capability = await app.request(`${prefix}/capabilities`, { headers: { origin, ...ownerHeader } }); expect(capability.status).toBe(200);
  expect(await capability.json()).toMatchObject({ configured: false, canBroadcast: false, serviceProvider: 'TRANSAK' });
  expect((await app.request(`${prefix}/status`, { headers: { origin, ...ownerHeader } })).status).toBe(503); expect(queries).toBe(0);
});
test('native writes require bounded body, raw cookie-bound HMAC and strict request fields before DB or provider calls', async () => {
  let queries = 0; const app = application({ execute: async () => { queries++; throw Error('no DB'); } });
  const path = `${prefix}/challenge`;
  expect((await app.request(path, { method: 'POST', headers: { origin, ...ownerHeader, 'content-type': 'application/json' }, body: JSON.stringify({ address }) })).status).toBe(403);
  expect((await app.request(path, signed(path, { address }, { cookie: 'better-auth.session_token=changed' }))).status).toBe(403);
  expect((await app.request(path, signed(path, { address, subject: 'foreign' }))).status).toBe(400);
  expect((await app.request(path + '?address=foreign', signed(path, { address }))).status).toBe(400);
  expect((await app.request(path, signed(path, { address, padding: 'x'.repeat(3000) }))).status).toBe(413);
  expect((await app.request(`${prefix}/funding/session`, signed(`${prefix}/funding/session`, {
    requestId: id, country: 'US', sourceCurrencyCode: 'USD', amount: 50, paymentMethodType: 'CREDIT_DEBIT_CARD', walletAddress: address,
  }))).status).toBe(400);
  expect(queries).toBe(0);
});
test('actual offline wallet signature verifies and status reload retains the same native-session binding without signing again', async () => {
  const now = new Date(), expires = new Date(now.getTime() + 300000), nonce = 'a'.repeat(64), sessionContextHash = hash(`${subject}\n${nativeSessionId}`);
  const message = sandboxWalletOwnershipMessage({ address, challengeId: id, nonce, issuedAt: now, expiresAt: expires, sessionContextHash });
  const signature = await signer.signMessage(message), queries: { sql: string; params: unknown[] }[] = [];
  const binding = { address, verified: true, binding_reference: id, verified_at: now, expires_at: new Date(now.getTime() + 3600000) };
  const app = application({ execute: async query => { const parsed = new PgDialect().sqlToQuery(query); queries.push(parsed);
    return parsed.sql.includes('read_sandbox_wallet_challenge') ? [{ id, address, chain_id: 137, nonce, message, message_hash: hash(message),
      issued_at: now, expires_at: expires, session_context_hash: sessionContextHash }] : [binding]; } });
  const response = await app.request(`${prefix}/verify`, signed(`${prefix}/verify`, { challengeId: id, signature }));
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ verified: true, address, status: 'linked' });
  const reload = await app.request(`${prefix}/status`, { headers: { origin, ...ownerHeader } }); expect(reload.status).toBe(200); expect(await reload.json()).toMatchObject({ verified: true, address });
  expect(queries).toHaveLength(3); expect(queries[1]!.params.slice(0, 2)).toEqual([subject, nativeSessionId]); expect(JSON.stringify(queries)).not.toContain(signature);
});
test('unknown or duplicated query parameters and unsupported country/currency combinations never reach provider', async () => {
  const app = application();
  for (const suffix of ['/status?owner=other', '/funding/history?address=foreign', '/funding/status?checkoutReference=' + id + '&checkoutReference=' + id,
    '/funding/options?country=CO&sourceCurrencyCode=COP', '/funding/options?country=US&sourceCurrencyCode=MXN', '/funding/options?country=US&sourceCurrencyCode=USD&provider=BANXA']) {
    expect((await app.request(prefix + suffix, { headers: { origin, ...ownerHeader } })).status).toBe(400);
  }
});
test('missing, foreign, malformed or noncanonical displayed-owner headers cannot use a changed native cookie', async () => {
  let queries = 0; const app = application({ execute: async () => { queries++; throw Error('no DB'); } });
  for (const encoded of ['', 'other-user', '%73ynthetic-owner', '%', 'synthetic%00owner', 'x'.repeat(1537)]) {
    expect((await app.request(`${prefix}/status`, { headers: { origin, 'x-mindbliss-sandbox-subject': encoded } })).status).toBe(403);
    expect((await app.request(`${prefix}/challenge`, signed(`${prefix}/challenge`, { address }, { 'x-mindbliss-sandbox-subject': encoded }))).status).toBe(403);
  }
  expect(queries).toBe(0);
});
test('signed HTTP checkout uses the verified bound destination and an exact Transak sandbox response; malformed quote fails503 before journal creation', async () => {
  for (const malformed of [false, true]) {
    const queries: string[] = [], calls: string[] = [], customer = '7d492c47-80be-4e14-bc5f-54afaa56fc23', now = new Date();
    const app = application({ execute: async query => { const parsed = new PgDialect().sqlToQuery(query); queries.push(parsed.sql);
      if (parsed.sql.includes('read_sandbox_wallet_binding')) return [{ address, verified: true, binding_reference: customer, verified_at: now, expires_at: new Date(now.getTime() + 3600000) }];
      if (parsed.sql.includes('create_connected_wallet_sandbox_attempt')) return [{ id, address, customer_reference: customer, created: true, status: 'initiated', created_at: now }];
      if (parsed.sql.includes('finish_connected_wallet_sandbox_attempt')) return [{ finished: true }]; throw Error('unexpected query');
    }, fetchImpl: (async (target: string | Request | URL, init?: RequestInit) => {
      const url = String(target); calls.push(url); expect(url).toStartWith('https://api-sb.meld.io/');
      if (url.includes('/supported/routes/')) return Response.json([{ partner: 'TRANSAK', source: 'USD', destination: 'USDT_POLYGON',
        paymentMethods: [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 20, max: 25000 } }] }]);
      if (url.includes('/quote?')) return malformed ? new Response('{', { headers: { 'content-type': 'application/json' } }) : Response.json({ quotes: [{ serviceProvider: 'TRANSAK',
        sourceCurrencyCode: 'USD', sourceAmount: 50, destinationCurrencyCode: 'USDT_POLYGON', destinationAmount: 46.5, paymentMethodType: 'CREDIT_DEBIT_CARD' }] });
      const sent = JSON.parse(init!.body as string); expect(sent.sessionData.walletAddress).toBe(address);
      return Response.json({ id: 'synthetic-session', customerId: 'synthetic-customer', externalSessionId: id, externalCustomerId: customer,
        serviceProviderWidgetUrl: 'https://global-stg.transak.com/?apiKey=synthetic&sessionId=synthetic' });
    }) as unknown as typeof fetch });
    const path = `${prefix}/funding/session`, response = await app.request(path, signed(path, { requestId: id, country: 'US', sourceCurrencyCode: 'USD', amount: 50, paymentMethodType: 'CREDIT_DEBIT_CARD' }));
    expect(response.status).toBe(malformed ? 503 : 201);
    if (malformed) { expect(queries).toHaveLength(1); expect(calls).toHaveLength(2); }
    else { expect(await response.json()).toMatchObject({ status: 'session_created', serviceProvider: 'TRANSAK', destination: { address, chainId: 137 } }); expect(queries).toHaveLength(3); expect(calls).toHaveLength(3); }
  }
});
test('reviewed immutable-binding and expiry SQL errors stay actionable without leaking arbitrary database messages', async () => {
  for (const [message, status, code] of [['sandbox_wallet_address_immutable', 409, 'sandbox_wallet_already_linked'],
    ['sandbox_wallet_binding_required', 409, 'sandbox_wallet_verification_required'],
    ['administrative_signing_forbidden', 403, 'sandbox_wallet_forbidden'], ['sandbox_wallet_funding_rate_limited', 429, 'sandbox_wallet_rate_limited'],
    ['private database message', 503, 'sandbox_wallet_unavailable']] as const) {
    const app = application({ execute: async () => { throw Error(message); } });
    const response = await app.request(`${prefix}/status`, { headers: { origin, ...ownerHeader } });
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code });
  }
});
