import { createHash } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { expect, test } from 'bun:test';
import { createMeldSandboxCheckout, meldCheckoutCapabilities, meldCheckoutInput, meldSandboxCheckoutReturnUrl,
  meldSandboxCheckoutUrl } from './meld-sandbox-checkout';
import type { IdentityDatabase } from '../identity/model';

const id = '6d492c47-80be-4e14-bc5f-54afaa56fc23', customer = 'aa0ecbcc-54d8-4a6e-a0ac-4a662ac8ed44';
const address = `0x${'2'.repeat(40)}`, created = new Date('2026-11-13T03:00:00.000Z');
const input = { requestId: id, country: 'US', sourceCurrencyCode: 'USD', amount: 100 };
const environment = { MELD_CHECKOUT_ENABLED: 'true', MELD_ADMIN_SANDBOX_ENABLED: 'true', MELD_API_SANDBOX: 'synthetic-secret',
  MELD_WIDGET_PUBLIC_KEY: 'synthetic-public-key', MELD_ACCOUNT_ID: 'synthetic-account' };
const assignment = { status: 'assigned', address, address_family: 'EVM', asset: 'USDT', checkout_reference: customer, assigned_at: created };
const initiated = { id, created_at: created, created: true, status: 'initiated', customer_reference: customer };
const checkoutUrl = 'https://sb.meldcrypto.com/?wt=synthetic-session_token';
function database(outputs: unknown[][] = [[assignment], [initiated], [{ finished: true }]]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  return { queries, database: { execute: async (query: SQL) => {
    queries.push(new PgDialect().sqlToQuery(query));
    const next = outputs.shift(); if (!next) throw Error('unexpected database operation'); return next;
  } } as unknown as Pick<IdentityDatabase, 'execute'> };
}
const options = { subject: 'synthetic-owner', clientIp: '192.0.2.1', environment };

test('generic sandbox checkout mints once with server-owned destination and references, five locks and no provider/quote parameters', async () => {
  const db = database(); let calls = 0;
  const result = await createMeldSandboxCheckout(db.database, input, { ...options,
    fetchImpl: (async (target: string | Request | URL, init?: RequestInit) => {
      calls++; expect(target).toBe('https://api-sb.meld.io/crypto/session/widget/url'); expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe('BASIC synthetic-secret'); expect(db.queries).toHaveLength(2);
      expect(JSON.parse(String(init?.body))).toEqual({ publicKey: environment.MELD_WIDGET_PUBLIC_KEY, sessionType: 'BUY',
        prefill: { countryCode: 'US', sourceCurrencyCode: 'USD', sourceAmount: 100, destinationCurrencyCode: 'USDT_POLYGON', walletAddress: address },
        locked: ['countryCode', 'sourceCurrencyCode', 'sourceAmount', 'destinationCurrencyCode', 'walletAddress'],
        redirectUrl: `https://wallet.mindblisspower.com/dashboard/wallet-administrative?meldCheckoutReference=${id}`,
        externalCustomerId: customer, externalSessionId: id });
      return Response.json({ widgetUrl: checkoutUrl, token: 'must-not-expose', providerSessionId: 'not-a-real-binding' });
    }) as unknown as typeof fetch });
  expect(calls).toBe(1); expect(result).toEqual({ flow: 'meld_checkout', status: 'checkout_minted', checkoutReference: id,
    country: 'US', requestedAmount: 100, sourceCurrencyCode: 'USD', destination: { address, asset: 'USDT', network: 'polygon', chainId: 137 },
    checkoutUrl, createdAt: created.toISOString() });
  expect(db.queries[1]!.params).toEqual(['synthetic-owner', address, 'US', 100, id, 'USD', 'synthetic-account']);
  expect(db.queries[2]!.params).toEqual(['synthetic-owner', id, 'minted', createHash('sha256').update(checkoutUrl).digest('hex')]);
  expect(JSON.stringify(db.queries)).not.toMatch(/wt=|synthetic-session_token|public-key|synthetic-secret|commission|wallet_movement|reown|providerSessionId/);
});

test('configuration capabilities expose no keys and disabled or incomplete minting fails before any database or network work', async () => {
  const empty = database([]); let calls = 0;
  for (const changed of [{ MELD_CHECKOUT_ENABLED: 'false' }, { MELD_ADMIN_SANDBOX_ENABLED: 'false' }, { MELD_API_SANDBOX: '' },
    { MELD_WIDGET_PUBLIC_KEY: '' }, { MELD_ACCOUNT_ID: '' }, { MELD_ACCOUNT_ID: '..' }, { MELD_WIDGET_PUBLIC_KEY: 'with space' },
    { MELD_WIDGET_PUBLIC_KEY: environment.MELD_API_SANDBOX }]) {
    const env = { ...environment, ...changed };
    expect(meldCheckoutCapabilities(env)).toEqual({ flow: 'meld_checkout', configured: false, environment: 'sandbox', asset: 'USDT', network: 'polygon', chainId: 137 });
    await expect(createMeldSandboxCheckout(empty.database, input, { ...options, environment: env,
      fetchImpl: (async () => { calls++; throw Error('must not run'); }) as unknown as typeof fetch })).rejects.toThrow('wallet_funding_unconfigured');
  }
  expect(empty.queries).toHaveLength(0); expect(calls).toBe(0); expect(meldCheckoutCapabilities({}).configured).toBe(false);
  expect(meldCheckoutCapabilities(environment).configured).toBe(true);
  expect(JSON.stringify(meldCheckoutCapabilities(environment))).not.toMatch(/key|account|secret|token/i);
});

test('mint input retains exact audited country/fiat/amount bounds and rejects every browser-controlled routing or ownership field', async () => {
  expect(meldCheckoutInput.parse({ ...input, requestId: id.toUpperCase() }).requestId).toBe(id);
  for (const country of ['US', 'MX', 'CO']) for (const amount of [50, 100, 25_000]) expect(meldCheckoutInput.safeParse({ ...input, country, amount }).success).toBe(true);
  for (const amount of [1, 93, 10_000_000]) expect(meldCheckoutInput.safeParse({ ...input, country: 'MX', sourceCurrencyCode: 'MXN', amount }).success).toBe(true);
  const invalid = [{ walletAddress: address }, { serviceProvider: 'BANXA' }, { paymentMethodType: 'CREDIT_DEBIT_CARD' }, { subject: 'other' },
    { accountId: 'other' }, { publicKey: 'other' }, { redirectUrl: 'https://evil.test' }, { locked: [] }, { sessionType: 'SELL' },
    { country: 'ES' }, { country: 'co' }, { sourceCurrencyCode: 'COP' }, { sourceCurrencyCode: 'MXN' }, { amount: 49.99 }, { amount: 25000.01 },
    { amount: '100' }, { amount: NaN }, { amount: 50.001 }, { requestId: 'foreign' }];
  const db = database([]); let calls = 0;
  for (const change of invalid) await expect(createMeldSandboxCheckout(db.database, { ...input, ...change }, { ...options,
    fetchImpl: (async () => { calls++; throw Error('must not run'); }) as unknown as typeof fetch })).rejects.toThrow();
  for (const amount of [0.99, 10000000.01]) expect(meldCheckoutInput.safeParse({ ...input, country: 'MX', sourceCurrencyCode: 'MXN', amount }).success).toBe(false);
  expect(db.queries).toHaveLength(0); expect(calls).toBe(0);
});

test('assigned ownership, immutable customer reference and persistent replay checks precede all mint calls', async () => {
  let calls = 0;
  for (const outputs of [
    [[{ ...assignment, status: 'pending', address: null, checkout_reference: null, assigned_at: null }]],
    [[assignment], [{ ...initiated, customer_reference: '11111111-1111-4111-8111-111111111111' }]],
    [[assignment], [{ ...initiated, id: '11111111-1111-4111-8111-111111111111' }]],
    [[assignment], [{ ...initiated, status: 'minted', created: false }]],
  ]) {
    const db = database(outputs);
    await expect(createMeldSandboxCheckout(db.database, input, { ...options,
      fetchImpl: (async () => { calls++; throw Error('must not mint'); }) as unknown as typeof fetch })).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test('provider failures, malformed JSON and unsafe mint links store only an unavailable technical attempt without retrying', async () => {
  for (const response of [new Response('private-provider-secret', { status: 401 }), new Response('{invalid'),
    Response.json({ widgetUrl: 'https://meldcrypto.com/?wt=production' }), Response.json({ widgetUrl: 'https://evil.test/?wt=unsafe' }),
    Response.json({ widgetUrl: {} }), new Response('x'.repeat(32769))]) {
    const db = database(); let calls = 0;
    await expect(createMeldSandboxCheckout(db.database, input, { ...options, fetchImpl: (async () => { calls++; return response; }) as unknown as typeof fetch }))
      .rejects.toThrow('wallet_funding_provider_unavailable');
    expect(calls).toBe(1); expect(db.queries).toHaveLength(3);
    expect(db.queries[2]!.params).toEqual(['synthetic-owner', id, 'unavailable', null]);
  }
});

test('sandbox mint URLs and returns reject ambiguous hosts, ports, fields, encoding, fragments and redirect injection', () => {
  expect(meldSandboxCheckoutUrl(checkoutUrl.replace('/?', '?'))).toBe(checkoutUrl);
  for (const value of [checkoutUrl.replace('sb.', ''), checkoutUrl.replace('.com/', '.com:443/'), checkoutUrl.replace('.com/', '.com.evil.test/'),
    checkoutUrl.replace('/?', '/widget?'), checkoutUrl.replace('https:', 'http:'), checkoutUrl.replace('https://', 'https://user:pass@'), checkoutUrl + '#',
    checkoutUrl + '&wt=second', checkoutUrl + '&redirectUrl=https://evil.test', checkoutUrl.replace('wt=', '%77t='), checkoutUrl + '\n',
    checkoutUrl.replace('wt=', 'token='), checkoutUrl.replace('synthetic-session_token', ''), checkoutUrl.replace('synthetic-session_token', 'a'.repeat(4097))]) {
    expect(() => meldSandboxCheckoutUrl(value)).toThrow('wallet_funding_provider_unavailable');
  }
  expect(meldSandboxCheckoutReturnUrl(id.toUpperCase())).toBe(`https://wallet.mindblisspower.com/dashboard/wallet-administrative?meldCheckoutReference=${id}`);
  expect(() => meldSandboxCheckoutReturnUrl(id + '&paid=true')).toThrow();
});

test('duplicate clicks and cancelled requests never mint twice or retry ambiguous sessions', async () => {
  const db = database(); let calls = 0;
  const deps = { ...options, fetchImpl: (async () => { calls++; return Response.json({ widgetUrl: checkoutUrl }); }) as unknown as typeof fetch };
  await createMeldSandboxCheckout(db.database, input, deps);
  await expect(createMeldSandboxCheckout(db.database, input, deps)).rejects.toThrow('wallet_funding_request_already_used');
  expect(calls).toBe(1); expect(db.queries).toHaveLength(3);
  const cancelled = database([]), controller = new AbortController(); controller.abort();
  await expect(createMeldSandboxCheckout(cancelled.database, input, { ...deps, signal: controller.signal })).rejects.toThrow();
  expect(cancelled.queries).toHaveLength(0); expect(calls).toBe(1);
  const pending = database(), active = new AbortController(); let pendingCalls = 0;
  const operation = createMeldSandboxCheckout(pending.database, input, { ...options, signal: active.signal,
    fetchImpl: (() => { pendingCalls++; active.abort(); return new Promise(() => {}); }) as unknown as typeof fetch });
  await expect(operation).rejects.toThrow('wallet_funding_provider_unavailable');
  expect(pendingCalls).toBe(1); expect(pending.queries).toHaveLength(2);
});

test('an overlapping second mint is refused before database work while the first owner operation is pending', async () => {
  let reads = 0;
  const controller = new AbortController();
  const db = { execute: async () => { reads++; return new Promise(() => {}); } } as unknown as Pick<IdentityDatabase, 'execute'>;
  const first = createMeldSandboxCheckout(db, input, { ...options, signal: controller.signal,
    fetchImpl: (async () => { throw Error('pending assignment cannot mint'); }) as unknown as typeof fetch });
  await Promise.resolve();
  await expect(createMeldSandboxCheckout(db, { ...input, requestId: '11111111-1111-4111-8111-111111111111' }, options)).rejects.toThrow('wallet_funding_request_pending');
  controller.abort(); await expect(first).rejects.toThrow('wallet_funding_provider_unavailable');
  expect(reads).toBe(1);
});
