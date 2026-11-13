import { createHash, createHmac } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { registerWalletFundingRoutes } from './wallet-funding-routes';
import type { ApiEnvironment } from './types';
import type { IdentityDatabase } from '../modules/identity/model';
const path = '/api/member/wallet-funding/administrative/checkout', origin = 'https://wallet.mindblisspower.com';
const secret = 's'.repeat(48), address = `0x${'2'.repeat(40)}`, reference = '6d492c47-80be-4e14-bc5f-54afaa56fc23';
const customer = 'aa0ecbcc-54d8-4a6e-a0ac-4a662ac8ed44';
const input = { requestId: reference, country: 'US', sourceCurrencyCode: 'USD', amount: 100 };
const environment = { MELD_ADMIN_SANDBOX_ENABLED: 'true', MELD_CHECKOUT_ENABLED: 'true', MELD_API_SANDBOX: 'synthetic-secret',
  MELD_WIDGET_PUBLIC_KEY: 'synthetic-public', MELD_ACCOUNT_ID: 'synthetic-account' };
function signed(body: string, extra: Record<string, string> = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000)), ip = '192.0.2.1', cookie = 'better-auth.session_token=synthetic';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const signature = createHmac('sha256', secret).update(['POST', path, timestamp, ip, hash(cookie), hash(body)].join('\n')).digest('hex');
  return { method: 'POST', body, headers: { origin, cookie, 'content-type': 'application/json', 'x-vp-auth-client-ip': ip,
    'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': signature, ...extra } };
}
function application({ enabled = false, signedIn = true, execute = async () => [], fetchImpl }: {
  enabled?: boolean; signedIn?: boolean; execute?: (query: unknown) => Promise<unknown[]>; fetchImpl?: typeof fetch;
} = {}) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => { context.set('session', signedIn ? { user: { id: 'synthetic-owner' } } as never : null); await next(); });
  registerWalletFundingRoutes(app, { database: { execute } as Pick<IdentityDatabase, 'execute'>,
    environment: { BETTER_AUTH_URL: origin, BETTER_AUTH_TRUSTED_ORIGINS: origin, AUTH_BFF_SHARED_SECRET: secret, ...(enabled ? environment : {}) },
    fetchImpl: fetchImpl || (async () => { throw Error('network forbidden'); }) as unknown as typeof fetch });
  return app;
}

test('generic checkout capabilities are native private metadata; disabled mint and reads never touch DB or Meld', async () => {
  let queries = 0;
  const app = application({ execute: async () => { queries++; throw Error('must not query'); } });
  const response = await app.request(path + '/capabilities', { headers: { origin } }); expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ flow: 'meld_checkout', configured: false, environment: 'sandbox', asset: 'USDT', network: 'polygon', chainId: 137 });
  expect((await app.request(path + '/capabilities?publicKey=foreign', { headers: { origin } })).status).toBe(400);
  const post = await app.request(path, signed(JSON.stringify(input))); expect(post.status).toBe(503); expect(await post.json()).toEqual({ error: 'wallet_funding_unconfigured' });
  for (const read of ['/history', '/status?checkoutReference=' + reference]) {
    const result = await app.request(path + read, { headers: { origin } }); expect(result.status).toBe(503); expect(await result.json()).toEqual({ error: 'wallet_funding_unconfigured' });
  }
  expect(queries).toBe(0);
  for (const read of ['/capabilities', '/history', '/status?checkoutReference=' + reference]) expect((await application({ signedIn: false }).request(path + read)).status).toBe(401);
  expect((await application({ signedIn: false }).request(path, signed(JSON.stringify(input)))).status).toBe(401);
  const invalidHeaders: Record<string, string>[] = [{}, { origin: 'https://app.mindblisspower.com' }, { origin: 'https://wallet.mindblisspower.com.evil.test' },
    { origin, 'x-vp-act-as': '' }, { origin, 'x-vp-act-as': 'foreign' }];
  for (const read of ['/capabilities', '/history', '/status?checkoutReference=' + reference]) {
    for (const headers of invalidHeaders) {
      expect((await app.request(path + read, { headers })).status).toBe(403);
    }
  }
  expect(queries).toBe(0);
});

test('generic checkout rejects unsigned, crossed-origin, altered, extraneous and selector-bearing requests before persistence', async () => {
  let queries = 0, gets = 0;
  const app = application({ enabled: true, execute: async () => { queries++; throw Error('must not query'); },
    fetchImpl: (async () => { gets++; throw Error('must not mint'); }) as unknown as typeof fetch });
  const body = JSON.stringify(input);
  expect((await app.request(path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body })).status).toBe(403);
  expect((await app.request(path, signed(body, { origin: 'https://app.mindblisspower.com' }))).status).toBe(403);
  expect((await app.request(path, signed(body, { 'x-vp-act-as': '' }))).status).toBe(403);
  expect((await app.request(path, { ...signed(body), body: JSON.stringify({ ...input, amount: 250 }) })).status).toBe(403);
  for (const key of ['walletAddress', 'subject', 'serviceProvider', 'paymentMethodType', 'publicKey', 'redirectUrl', 'sessionType']) {
    expect((await app.request(path, signed(JSON.stringify({ ...input, [key]: 'attacker-controlled' })))).status).toBe(400);
  }
  expect((await app.request(path + '?subject=foreign', signed(body))).status).toBe(400);
  expect((await app.request(path + '/history?subject=foreign', { headers: { origin } })).status).toBe(400);
  expect((await app.request(path + '/status?checkoutReference=' + reference + '&transactionId=foreign', { headers: { origin } })).status).toBe(400);
  expect(queries).toBe(0); expect(gets).toBe(0);
});

test('generic checkout HTTP returns its own non-financial ACK from one sandbox mint and the server-assigned destination', async () => {
  const created = new Date('2026-11-13T03:00:00.000Z'); let queries = 0, mints = 0;
  const outputs = [[{ status: 'assigned', address, address_family: 'EVM', asset: 'USDT', checkout_reference: customer, assigned_at: created }],
    [{ id: reference, created_at: created, created: true, status: 'initiated', customer_reference: customer }], [{ finished: true }]];
  const app = application({ enabled: true, execute: async () => { queries++; return outputs.shift()!; },
    fetchImpl: (async (target: string | Request | URL, init?: RequestInit) => {
      mints++; expect(target).toBe('https://api-sb.meld.io/crypto/session/widget/url'); expect(queries).toBe(2);
      const payload = JSON.parse(String(init?.body)); expect(payload.prefill.walletAddress).toBe(address);
      expect(payload.externalCustomerId).toBe(customer); expect(payload.externalSessionId).toBe(reference);
      expect(payload.redirectUrl).toEndWith('?meldCheckoutReference=' + reference);
      expect(payload).not.toHaveProperty('serviceProviders'); expect(payload.prefill).not.toHaveProperty('serviceProvider');
      return Response.json({ widgetUrl: 'https://sb.meldcrypto.com/?wt=synthetic-checkout' });
    }) as unknown as typeof fetch });
  const response = await app.request(path, signed(JSON.stringify(input))); expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ flow: 'meld_checkout', status: 'checkout_minted', checkoutReference: reference, country: 'US', requestedAmount: 100,
    sourceCurrencyCode: 'USD', destination: { address, asset: 'USDT', network: 'polygon', chainId: 137 }, checkoutUrl: 'https://sb.meldcrypto.com/?wt=synthetic-checkout', createdAt: created.toISOString() });
  expect(queries).toBe(3); expect(mints).toBe(1);
  const duplicate = await app.request(path, signed(JSON.stringify(input))); expect(duplicate.status).toBe(409); expect(mints).toBe(1); expect(queries).toBe(3);
});
