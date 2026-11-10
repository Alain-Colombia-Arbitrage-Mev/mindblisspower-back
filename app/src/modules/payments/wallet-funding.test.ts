import { expect, spyOn, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { createAdministrativeSandboxSession, createPersonalFundingIntent, readAdministrativeSandboxOptions, readWalletFundingHistory,
  sandboxWidgetUrl } from './wallet-funding';
import type { IdentityDatabase } from '../identity/model';

const id = '6d492c47-80be-4e14-bc5f-54afaa56fc23';
const address = `0x${'2'.repeat(40)}`;
const createdAt = new Date('2026-11-10T20:00:00.000Z');
const input = { requestId: id, walletAddress: address, country: 'US', amount: 100, paymentMethodType: 'CREDIT_DEBIT_CARD' };
const adminInput = { ...input, serviceProvider: 'TRANSAK', paymentMethodType: 'CREDIT_DEBIT_CARD' };
const environment = { MELD_ADMIN_SANDBOX_ENABLED: 'true', MELD_API_SANDBOX: 'synthetic-sandbox-key' };
const assignment = { status: 'assigned', address, address_family: 'EVM', asset: 'USDT', checkout_reference: id, assigned_at: createdAt };
const method = (name = 'CREDIT_DEBIT_CARD', min = 20, max = 15000) => ({ name, limits: { currencyCode: 'USD', min, max } });
const route = (partner = 'TRANSAK', paymentMethods = [method()]) => ({ partner, source: 'USD', destination: 'USDT_POLYGON', paymentMethods });
const productionFetch = (async () => Response.json([route('TOPPER')])) as unknown as typeof fetch;

function withSandboxOptions(widgetFetch: typeof fetch): typeof fetch {
  return (async (url, init) => String(url).includes('/supported/routes/')
    ? Response.json([route()])
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
  const result = await createPersonalFundingIntent(database, input, 'synthetic-owner', { fetchImpl: productionFetch });
  expect(result).toEqual({ checkoutReference: id, walletKind: 'personal', environment: 'production', provider: 'reown',
    status: 'initiated', requestedAmount: 100, paymentMethodType: 'CREDIT_DEBIT_CARD', allowedProviders: ['TOPPER'], createdAt: createdAt.toISOString() });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toContain('payments.create_reown_funding_intent');
  expect(queries[0]!.params).toEqual(['synthetic-owner', address, 'US', 100, id, 'CREDIT_DEBIT_CARD']);
  expect(Object.keys(result)).not.toContain('commission');
  expect(Object.keys(result)).not.toContain('destinationAmount');
  for (const bad of [{ ...input, amount: 49 }, { ...input, amount: 100.001 }, { ...input, walletKind: 'administrative' }]) {
    await expect(createPersonalFundingIntent(database, bad, 'synthetic-owner')).rejects.toThrow();
  }
  expect(queries).toHaveLength(1);
});

test('personal intent revalidates its own production method and amount, then computes eligible providers server-side', async () => {
  const routes = [route('TOPPER', [method('CREDIT_DEBIT_CARD', 10, 80)]), route('SWAPPED', [method('CREDIT_DEBIT_CARD', 20, 500), method('BANK_TRANSFER', 200, 1000)]),
    route('TRANSAK', [method('CREDIT_DEBIT_CARD', 1, 10000)])];
  const fetchImpl = (async (url, init) => {
    expect(String(url)).toContain('https://api.meld.io/');
    expect(String(url)).not.toContain('api-sb');
    expect(new Headers(init!.headers).get('authorization')).not.toContain(environment.MELD_API_SANDBOX);
    return Response.json(routes);
  }) as typeof fetch;
  const { database, queries } = queuedDatabase([[{ id, created_at: createdAt }]]);
  const result = await createPersonalFundingIntent(database, input, 'owner', { fetchImpl });
  expect(result.allowedProviders).toEqual(['SWAPPED']);
  expect(result.paymentMethodType).toBe('CREDIT_DEBIT_CARD');
  expect(queries).toHaveLength(1);
  for (const [change, expected] of [[{ paymentMethodType: 'ACH' }, 'wallet_funding_method_unavailable'],
    [{ paymentMethodType: 'BANK_TRANSFER', amount: 100 }, 'wallet_funding_amount_unavailable'],
    [{ amount: 1000 }, 'wallet_funding_amount_unavailable']] as const) {
    const blocked = queuedDatabase([]);
    await expect(createPersonalFundingIntent(blocked.database, { ...input, ...change }, 'owner', { fetchImpl })).rejects.toThrow(expected);
    expect(blocked.queries).toHaveLength(0);
  }
  await expect(createPersonalFundingIntent(queuedDatabase([]).database, { ...input, paymentMethodType: undefined }, 'owner', { fetchImpl })).rejects.toThrow();
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
      return Response.json([route('TRANSAK', [method(), method('APPLE_PAY')]), route('BANXA', [method('BANK_TRANSFER')])]);
    }) as typeof fetch });
  expect(calls).toEqual(['https://api-sb.meld.io/network-partner/supported/routes/CRYPTO_ONRAMP/US/USD/USDT_POLYGON']);
  expect(options).toEqual({ walletKind: 'administrative', environment: 'sandbox', provider: 'meld', country: 'US',
    serviceProvider: 'TRANSAK', paymentMethods: ['CREDIT_DEBIT_CARD', 'APPLE_PAY'], routes: [{ serviceProvider: 'TRANSAK', paymentMethods: [
      { method: 'CREDIT_DEBIT_CARD', minimumUsd: 20, maximumUsd: 15000 }, { method: 'APPLE_PAY', minimumUsd: 20, maximumUsd: 15000 }] }] });
  const missing = await readAdministrativeSandboxOptions({ country: 'CO', serviceProvider: 'TRANSAK' }, { environment,
    fetchImpl: (async () => Response.json([route('BANXA')])) as unknown as typeof fetch });
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
      return Response.json([route()]);
    }) as typeof fetch,
  })).rejects.toThrow('wallet_funding_method_unavailable');
  expect(calls).toBe(1);
  expect(queries[2]!.params[2]).toBe('unavailable');
});

test('sandbox checks its selected method USD limits and logs only safe correlation metadata on rejection', async () => {
  const diagnostics: unknown[] = [];
  const outside = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: true }]]);
  let calls = 0;
  await expect(createAdministrativeSandboxSession(outside.database, { ...adminInput, amount: 100 }, { subject: 'owner', clientIp: '192.0.2.1', environment,
    diagnostic: event => diagnostics.push(event), fetchImpl: (async url => {
      calls++; expect(String(url)).toContain('/supported/routes/'); return Response.json([route('TRANSAK', [method('CREDIT_DEBIT_CARD', 200, 500)])]);
    }) as typeof fetch,
  })).rejects.toThrow('wallet_funding_amount_unavailable');
  expect(calls).toBe(1);
  expect(outside.queries[2]!.params[2]).toBe('unavailable');
  expect(diagnostics).toEqual([{ event: 'wallet_funding_provider_failure', environment: 'sandbox', phase: 'session', status: null, requestId: id, code: 'AMOUNT_OUTSIDE_ROUTE_LIMITS' }]);
  diagnostics.length = 0;
  const rejected = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: true }]]);
  await expect(createAdministrativeSandboxSession(rejected.database, adminInput, { subject: 'private-owner', clientIp: '192.0.2.1', environment,
    diagnostic: event => diagnostics.push(event), fetchImpl: withSandboxOptions((async () => Response.json({ code: 'PRIVATE_TOKEN', message: 'private-user@example.invalid',
      token: 'private-token', walletAddress: address, widgetUrl: 'https://sb.meldcrypto.com/?wt=private-token' }, { status: 422 })) as unknown as typeof fetch),
  })).rejects.toThrow('wallet_funding_provider_unavailable');
  expect(diagnostics).toEqual([{ event: 'wallet_funding_provider_failure', environment: 'sandbox', phase: 'session', status: 422, requestId: id, code: 'UPSTREAM_REJECTED' }]);
  expect(JSON.stringify(diagnostics)).not.toMatch(/private|0x|@|wt=|192\.0\.2/);
  diagnostics.length = 0;
  const knownFailure = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: true }]]);
  const providerRequestId = '11111111-1111-4111-8111-111111111111';
  await expect(createAdministrativeSandboxSession(knownFailure.database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment,
    diagnostic: event => diagnostics.push(event), fetchImpl: withSandboxOptions((async () => Response.json({ code: 'INCOMPATIBLE_REQUEST', requestId: providerRequestId,
      message: 'private@example.invalid', serviceProviderDetails: { code: 'PRIVATE_TOKEN', requestId: 'secret', walletAddress: address } }, { status: 400 })) as unknown as typeof fetch),
  })).rejects.toThrow('wallet_funding_provider_unavailable');
  expect(diagnostics).toEqual([{ event: 'wallet_funding_provider_failure', environment: 'sandbox', phase: 'session', status: 400, requestId: id,
    code: 'UPSTREAM_REJECTED', providerCode: 'INCOMPATIBLE_REQUEST', providerRequestId }]);
  expect(JSON.stringify(diagnostics)).not.toMatch(/private|secret|0x|@|wt=/);
});

test('one whole-operation deadline stops a slow sandbox widget and never retries or marks an ambiguous session failed', async () => {
  const originalTimeout = globalThis.setTimeout;
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof globalThis.setTimeout>[0], milliseconds?: number, ...args: unknown[]) =>
    originalTimeout(callback, milliseconds === 15_000 ? 30 : milliseconds, ...args)) as typeof setTimeout);
  const { database, queries } = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }]]);
  let widgetCalls = 0;
  let widgetSignal: AbortSignal | null | undefined;
  let finishLate: (value: Response) => void = () => {};
  try {
    const started = performance.now();
    await expect(createAdministrativeSandboxSession(database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment,
      diagnostic: () => {}, fetchImpl: (async (url, init) => {
        if (String(url).includes('/supported/routes/')) { await new Promise(resolve => originalTimeout(resolve, 5)); return Response.json([route()]); }
        widgetCalls++; widgetSignal = init!.signal;
        return new Promise<Response>(resolve => { finishLate = resolve; });
      }) as typeof fetch,
    })).rejects.toThrow('wallet_funding_provider_unavailable');
    expect(performance.now() - started).toBeLessThan(250);
    expect(widgetSignal?.aborted).toBe(true);
    expect(widgetCalls).toBe(1);
    expect(queries).toHaveLength(2);
    finishLate(Response.json({ id: 'late-created-session', widgetUrl: 'https://sb.meldcrypto.com/?wt=late-token' }));
    await new Promise(resolve => originalTimeout(resolve, 5));
    expect(widgetCalls).toBe(1);
    expect(queries).toHaveLength(2);
    expect(timers.mock.calls.some(([, milliseconds]) => milliseconds === 15_000)).toBe(true);
    expect(timers.mock.calls.some(([, milliseconds]) => milliseconds === 12_000)).toBe(false);
  } finally { timers.mockRestore(); }
});

test('caller cancellation reaches sandbox options and prevents every database/provider call when already aborted', async () => {
  const controller = new AbortController(); controller.abort();
  const { database, queries } = queuedDatabase([]);
  let calls = 0;
  const fetchImpl = (async () => { calls++; throw new Error('should not fetch'); }) as unknown as typeof fetch;
  await expect(createAdministrativeSandboxSession(database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment,
    signal: controller.signal, fetchImpl, diagnostic: () => {} })).rejects.toThrow('wallet_funding_provider_unavailable');
  await expect(readAdministrativeSandboxOptions({ country: 'US', serviceProvider: 'TRANSAK' }, { environment, signal: controller.signal,
    fetchImpl, diagnostic: () => {} })).rejects.toThrow('wallet_funding_provider_unavailable');
  expect(calls).toBe(0);
  expect(queries).toHaveLength(0);
});

test('sandbox cannot invent methods from labels, absent limits, wrong fiat or another provider', async () => {
  for (const payload of [[route('TRANSAK', [{ name: 'CREDIT_DEBIT_CARD', limits: null } as never])],
    [route('BANXA')]]) {
    const options = await readAdministrativeSandboxOptions({ country: 'CO', serviceProvider: 'TRANSAK' }, { environment,
      fetchImpl: (async () => Response.json(payload)) as unknown as typeof fetch });
    expect(options.paymentMethods).toEqual([]);
    expect(options.routes).toEqual([]);
  }
  const wrongFiat = [{ ...route(), paymentMethods: [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'EUR', min: 20, max: 1000 } }] }];
  await expect(readAdministrativeSandboxOptions({ country: 'US', serviceProvider: 'TRANSAK' }, { environment,
    diagnostic: () => {}, fetchImpl: (async () => Response.json(wrongFiat)) as unknown as typeof fetch })).rejects.toThrow('wallet_funding_provider_unavailable');
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
