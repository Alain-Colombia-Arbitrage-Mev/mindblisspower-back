import { expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { createAdministrativeSandboxSession, createPersonalFundingIntent, readAdministrativeSandboxOptions, readWalletFundingHistory,
  sandboxWidgetUrl } from './wallet-funding';
import type { IdentityDatabase } from '../identity/model';

const id = '6d492c47-80be-4e14-bc5f-54afaa56fc23';
const address = `0x${'2'.repeat(40)}`;
const createdAt = new Date('2026-11-10T20:00:00.000Z');
const input = { requestId: id, walletAddress: address, country: 'US', amount: 100 };
const adminInput = { ...input, serviceProvider: 'TRANSAK', paymentMethodType: 'CREDIT_DEBIT_CARD' };
const environment = { MELD_ADMIN_SANDBOX_ENABLED: 'true', MELD_API_SANDBOX: 'synthetic-sandbox-key' };
const assignment = { status: 'assigned', address, address_family: 'EVM', asset: 'USDT', checkout_reference: id, assigned_at: createdAt };

function withSandboxOptions(widgetFetch: typeof fetch): typeof fetch {
  return (async (url, init) => String(url).includes('/supported/routes/')
    ? Response.json([{ partner: 'TRANSAK', paymentMethods: [{ name: 'CARD', paymentType: 'CARD' }] }])
    : widgetFetch(url, init)) as typeof fetch;
}

function queuedDatabase(results: unknown[][]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  return {
    queries,
    database: { execute: async query => {
      queries.push(new PgDialect().sqlToQuery(query as SQL));
      if (!results.length) throw new Error('unexpected database call');
      return results.shift();
    } } as Pick<IdentityDatabase, 'execute'>,
  };
}

test('personal requests persist an unconfirmed Reown intent without any Meld quote, key or commission', async () => {
  const { database, queries } = queuedDatabase([[{ id, created_at: createdAt }]]);
  const result = await createPersonalFundingIntent(database, input, 'synthetic-owner');
  expect(result).toEqual({ checkoutReference: id, walletKind: 'personal', environment: 'production', provider: 'reown',
    status: 'initiated', requestedAmount: 100, createdAt: createdAt.toISOString() });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toContain('payments.create_reown_funding_intent');
  expect(queries[0]!.params).toEqual(['synthetic-owner', address, 'US', 100, id]);
  expect(Object.keys(result)).not.toContain('commission');
  expect(Object.keys(result)).not.toContain('destinationAmount');
  for (const bad of [{ ...input, amount: 49 }, { ...input, amount: 100.001 }, { ...input, walletKind: 'administrative' }]) {
    await expect(createPersonalFundingIntent(database, bad, 'synthetic-owner')).rejects.toThrow();
  }
  expect(queries).toHaveLength(1);
});

test('administrative sandbox binds the assigned address and records its session separately from production finances', async () => {
  const { database, queries } = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: true }]]);
  let calls = 0;
  const result = await createAdministrativeSandboxSession(database, adminInput, { subject: 'synthetic-owner', clientIp: '192.0.2.1', environment,
    fetchImpl: withSandboxOptions((async (url, init) => {
      calls++;
      expect(url).toBe('https://api-sb.meld.io/crypto/session/widget');
      expect(init!.redirect).toBe('error');
      expect(new Headers(init!.headers).get('authorization')).toBe('BASIC synthetic-sandbox-key');
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ sessionType: 'BUY', externalCustomerId: id, externalSessionId: id,
        sessionData: { serviceProvider: 'TRANSAK', countryCode: 'US', clientIpAddress: '192.0.2.1', sourceCurrencyCode: 'USD', sourceAmount: '100.00',
          destinationCurrencyCode: 'USDT_POLYGON', walletAddress: address, paymentMethodType: 'CREDIT_DEBIT_CARD',
          lockFields: ['walletAddress', 'destinationCurrencyCode', 'sourceCurrencyCode', 'sourceAmount', 'paymentMethodType'] } });
      return Response.json({ id: 'provider-session', widgetUrl: 'https://sb.meldcrypto.com/?wt=synthetic-token',
        externalSessionId: id, externalCustomerId: id, token: 'must-not-be-exposed', customerId: 'must-not-be-exposed' });
    }) as typeof fetch) });
  expect(calls).toBe(1);
  expect(result.environment).toBe('sandbox');
  expect(result.checkoutUrl).toBe('https://sb.meldcrypto.com/?wt=synthetic-token');
  expect(queries.map(query => query.sql).join(' ')).not.toContain('create_meld_onramp_attempt');
  expect(queries[2]!.params).toEqual(['synthetic-owner', id, 'session_created', 'provider-session']);
  expect(JSON.stringify(queries)).not.toContain('synthetic-token');
  expect(Object.keys(result)).not.toContain('token');
});

test('disabled sandbox, a live-only key, another assigned address and reused requests never reach Meld', async () => {
  const neverFetch = (async () => { throw new Error('unexpected provider call'); }) as unknown as typeof fetch;
  for (const config of [{}, { MELD_ADMIN_SANDBOX_ENABLED: 'true', MELD_API_KEY: 'must-not-be-read' },
    { ...environment, MELD_ADMIN_SANDBOX_ENABLED: 'false' }]) {
    const { database, queries } = queuedDatabase([]);
    await expect(createAdministrativeSandboxSession(database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment: config, fetchImpl: neverFetch }))
      .rejects.toThrow('wallet_funding_unconfigured');
    expect(queries).toHaveLength(0);
  }
  const mismatch = queuedDatabase([[{ ...assignment, address: `0x${'3'.repeat(40)}` }]]);
  await expect(createAdministrativeSandboxSession(mismatch.database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment, fetchImpl: neverFetch }))
    .rejects.toThrow('wallet_funding_forbidden');
  expect(mismatch.queries).toHaveLength(1);
  const duplicate = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: false, status: 'session_created' }]]);
  await expect(createAdministrativeSandboxSession(duplicate.database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment, fetchImpl: neverFetch }))
    .rejects.toThrow('wallet_funding_request_already_used');
  expect(duplicate.queries).toHaveLength(2);
});

test('provider failures and hostile successful-looking URLs record an isolated terminal failure without returning session secrets', async () => {
  for (const response of [Response.json({ code: 'BAD_REQUEST', message: 'private provider details' }, { status: 400 }),
    Response.json({ id: 'session', widgetUrl: 'https://meldcrypto.com/?wt=production-token' }),
    Response.json({ id: 'session', widgetUrl: 'https://sb.meldcrypto.com/?wt=token', externalSessionId: 'another-owner' }),
    Response.json({ id: 'session', widgetUrl: 'https://sb.meldcrypto.com.evil.test/?wt=token' })]) {
    const { database, queries } = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: true }]]);
    let calls = 0;
    await expect(createAdministrativeSandboxSession(database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment,
      fetchImpl: withSandboxOptions((async () => { calls++; return response; }) as unknown as typeof fetch) })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(queries).toHaveLength(3);
    expect(['unavailable', 'failed']).toContain(queries[2]!.params[2] as string);
  }
  for (const url of ['http://sb.meldcrypto.com/?wt=token', 'https://user@sb.meldcrypto.com/?wt=token',
    'https://sb.meldcrypto.com:8443/?wt=token', 'https://sb.meldcrypto.com/?wt=token#fragment']) {
    expect(() => sandboxWidgetUrl(url)).toThrow();
  }
});

test('ambiguous persistence after a provider success cannot retry the provider or update outcome twice', async () => {
  const { database, queries } = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: false }]]);
  let calls = 0;
  await expect(createAdministrativeSandboxSession(database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment,
    fetchImpl: withSandboxOptions((async () => { calls++; return Response.json({ id: 'session', widgetUrl: 'https://sb.meldcrypto.com/?wt=token' }); }) as unknown as typeof fetch) }))
    .rejects.toThrow('wallet_funding_unavailable');
  expect(calls).toBe(1);
  expect(queries).toHaveLength(3);
});

test('sandbox methods are resolved with its own key and selected provider without cross-provider defaults', async () => {
  const calls: string[] = [];
  const options = await readAdministrativeSandboxOptions({ country: 'US', serviceProvider: 'TRANSAK' }, { environment,
    fetchImpl: (async (url, init) => {
      calls.push(String(url));
      expect(new Headers(init!.headers).get('authorization')).toBe('BASIC synthetic-sandbox-key');
      return Response.json([{ partner: 'TRANSAK', paymentMethods: [{ name: 'VISA' }, { name: 'CARD' }, { name: 'APPLE_PAY' }] },
        { partner: 'BANXA', paymentMethods: [{ name: 'BANK_TRANSFER' }] }]);
    }) as typeof fetch });
  expect(calls).toEqual(['https://api-sb.meld.io/network-partner/supported/routes/CRYPTO_ONRAMP/US/USD/USDT_POLYGON']);
  expect(options).toEqual({ walletKind: 'administrative', environment: 'sandbox', provider: 'meld', country: 'US',
    serviceProvider: 'TRANSAK', paymentMethods: ['CREDIT_DEBIT_CARD', 'APPLE_PAY'] });
  const missing = await readAdministrativeSandboxOptions({ country: 'CO', serviceProvider: 'TRANSAK' }, { environment,
    fetchImpl: (async () => Response.json([{ partner: 'BANXA', paymentMethods: [{ name: 'CARD' }] }])) as unknown as typeof fetch });
  expect(missing.paymentMethods).toEqual([]);
});

test('a method not returned by the selected sandbox route never opens a widget and records unavailable', async () => {
  const { database, queries } = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: true }]]);
  let calls = 0;
  await expect(createAdministrativeSandboxSession(database, { ...adminInput, paymentMethodType: 'BANK_TRANSFER' }, {
    subject: 'owner', clientIp: '192.0.2.1', environment,
    fetchImpl: (async url => {
      calls++;
      expect(String(url)).toContain('/supported/routes/');
      return Response.json([{ partner: 'TRANSAK', paymentMethods: [{ name: 'CARD' }] }]);
    }) as typeof fetch,
  })).rejects.toThrow('wallet_funding_method_unavailable');
  expect(calls).toBe(1);
  expect(queries[2]!.params[2]).toBe('unavailable');
});

test('history accepts only the requested wallet environment and strips every financial or private extra', async () => {
  const row = { id, wallet_kind: 'personal', environment: 'production', provider: 'reown', status: 'initiated',
    wallet_address: address, country_code: 'US', requested_amount: '100.00', created_at: createdAt,
    token: 'private', commission: 20, subject: 'private-owner' };
  const { database, queries } = queuedDatabase([[row]]);
  expect(await readWalletFundingHistory(database, 'owner', 'personal')).toEqual({ walletKind: 'personal', environment: 'production',
    records: [{ checkoutReference: id, provider: 'reown', status: 'initiated', country: 'US', requestedAmount: 100, createdAt: createdAt.toISOString() }],
    settlement: 'unconfirmed' });
  expect(queries[0]!.params).toEqual(['owner', 'personal']);
  for (const bad of [{ ...row, environment: 'sandbox' }, { ...row, wallet_kind: 'administrative' }, { ...row, status: 'complete' }]) {
    const queued = queuedDatabase([[bad]]);
    await expect(readWalletFundingHistory(queued.database, 'owner', 'personal')).rejects.toThrow();
  }
});
