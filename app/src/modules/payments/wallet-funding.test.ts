import { expect, spyOn, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { createAdministrativeSandboxSession, createPersonalFundingIntent, readAdministrativeSandboxOptions, readWalletFundingHistory,
  readWalletFundingStatus, sandboxWidgetUrl, createAdministrativePreflightGate } from './wallet-funding';
import type { IdentityDatabase } from '../identity/model';

const id = '6d492c47-80be-4e14-bc5f-54afaa56fc23';
const customerReference = 'aa0ecbcc-54d8-4a6e-a0ac-4a662ac8ed44';
const address = `0x${'2'.repeat(40)}`;
const createdAt = new Date('2026-11-10T20:00:00.000Z');
const input = { requestId: id, walletAddress: address, country: 'US', amount: 100, paymentMethodType: 'CREDIT_DEBIT_CARD' };
const adminInput = { ...input, serviceProvider: 'TRANSAK', paymentMethodType: 'CREDIT_DEBIT_CARD' };
const environment = { MELD_ADMIN_SANDBOX_ENABLED: 'true', MELD_API_SANDBOX: 'synthetic-sandbox-key' };
const assignment = { status: 'assigned', address, address_family: 'EVM', asset: 'USDT', checkout_reference: customerReference, assigned_at: createdAt };
const method = (name = 'CREDIT_DEBIT_CARD', min = 20, max = 15000) => ({ name, limits: { currencyCode: 'USD', min, max } });
const route = (partner = 'TRANSAK', paymentMethods = [method()]) => ({ partner, source: 'USD', destination: 'USDT_POLYGON', paymentMethods });
const personalRoute = (partner = 'SWAPPED', paymentMethods = [method()]) => ({ partner, source: 'USD', destination: 'USDT_POLYGON', paymentMethods });
const productionFetch = (async () => Response.json([personalRoute('SWAPPED')])) as unknown as typeof fetch;

function withSandboxOptions(widgetFetch: typeof fetch): typeof fetch {
  return (async (url, init) => {
    if (String(url).includes('/supported/routes/')) return Response.json([route()]);
    if (String(url).includes('/payments/crypto/quote')) {
      const input = JSON.parse(String(init?.body));
      return Response.json({ quotes: [{ serviceProvider: input.serviceProviders[0], paymentMethodType: input.paymentMethodType,
        sourceCurrencyCode: input.sourceCurrencyCode, destinationCurrencyCode: input.destinationCurrencyCode,
        sourceAmount: input.sourceAmount, destinationAmount: 95 }] });
    }
    return widgetFetch(url, init);
  }) as typeof fetch;
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
    destinationCurrencyCode: 'USDT_POLYGON', destination: { address, asset: 'USDT', network: 'polygon', chainId: 137 },
    status: 'initiated', requestedAmount: 100, sourceCurrencyCode: 'USD', paymentMethodType: 'CREDIT_DEBIT_CARD', allowedProviders: ['SWAPPED'], createdAt: createdAt.toISOString() });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toContain('payments.create_reown_funding_intent_v7');
  expect(queries[0]!.params).toEqual(['synthetic-owner', address, 'US', 100, id, 'CREDIT_DEBIT_CARD', 'USD']);
  expect(Object.keys(result)).not.toContain('commission');
  expect(Object.keys(result)).not.toContain('destinationAmount');
  for (const bad of [{ ...input, amount: 19.99 }, { ...input, amount: 100.001 }, { ...input, walletKind: 'administrative' }]) {
    await expect(createPersonalFundingIntent(database, bad, 'synthetic-owner')).rejects.toThrow();
  }
  expect(queries).toHaveLength(1);
});

test('new personal intent cannot use an Ethereum route or a caller-selected destination and never writes a mismatched checkout', async () => {
  for (const destination of ['USDT', 'USDT_ETHEREUM', 'USDT_ARBITRUM']) {
    const { database, queries } = queuedDatabase([]);
    await expect(createPersonalFundingIntent(database, input, 'owner', {
      fetchImpl: (async () => Response.json([{ ...personalRoute(), destination }])) as unknown as typeof fetch,
    })).rejects.toThrow('wallet_funding_provider_unavailable');
    expect(queries).toHaveLength(0);
  }
  const { database, queries } = queuedDatabase([]);
  for (const extra of [{ chainId: 1 }, { destinationCurrencyCode: 'USDT' }, { network: 'ethereum' }]) {
    await expect(createPersonalFundingIntent(database, { ...input, ...extra }, 'owner', {
      fetchImpl: (async () => { throw Error('caller policy reached discovery'); }) as unknown as typeof fetch,
    })).rejects.toThrow();
  }
  expect(queries).toHaveLength(0);
});

test('personal intent revalidates its own production method and amount, then computes eligible providers server-side', async () => {
  const routes = [personalRoute('MERCURYO', [method('CREDIT_DEBIT_CARD', 10, 80)]), personalRoute('SWAPPED', [method('CREDIT_DEBIT_CARD', 20, 500), method('BANK_TRANSFER', 200, 1000)]),
    personalRoute('TOPPER', [method('CREDIT_DEBIT_CARD', 1, 10000)]), personalRoute('TRANSAK', [method('CREDIT_DEBIT_CARD', 1, 10000)])];
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

test('public personal USD30 to 15000 is independent of administrative USD50 and each provider can impose a higher minimum', async () => {
  const { database, queries } = queuedDatabase([[{ id, created_at: createdAt }]]);
  const result = await createPersonalFundingIntent(database, { ...input, amount: 30 }, 'owner', {
    fetchImpl: (async () => Response.json([personalRoute('SWAPPED', [method('CREDIT_DEBIT_CARD', 10, 1000)]),
      personalRoute('MERCURYO', [method('CREDIT_DEBIT_CARD', 150, 1000)]), personalRoute('TOPPER', [method('CREDIT_DEBIT_CARD', 1, 1000)])])) as unknown as typeof fetch,
  });
  expect(result.requestedAmount).toBe(30);
  expect(result.allowedProviders).toEqual(['SWAPPED']);
  expect(queries[0]!.params).toEqual(['owner', address, 'US', 30, id, 'CREDIT_DEBIT_CARD', 'USD']);
  const thirty = queuedDatabase([[{ id, created_at: createdAt }]]);
  const both = await createPersonalFundingIntent(thirty.database, { ...input, amount: 200 }, 'owner', {
    fetchImpl: (async () => Response.json([personalRoute('SWAPPED', [method('CREDIT_DEBIT_CARD', 10, 1000)]),
      personalRoute('MERCURYO', [method('CREDIT_DEBIT_CARD', 150, 1000)])])) as unknown as typeof fetch,
  });
  expect(both.allowedProviders).toEqual(['SWAPPED', 'MERCURYO']);
  const blocked = queuedDatabase([]);
  await expect(createPersonalFundingIntent(blocked.database, { ...input, amount: 100 }, 'owner', {
    fetchImpl: (async () => Response.json([personalRoute('MERCURYO', [method('CREDIT_DEBIT_CARD', 150, 1000)])])) as unknown as typeof fetch,
  })).rejects.toThrow('wallet_funding_amount_unavailable');
  for (const amount of [20, 29.99, 15000.01]) await expect(createPersonalFundingIntent(blocked.database, { ...input, amount }, 'owner', {
    fetchImpl: (async () => { throw new Error('outside public bounds must not query providers'); }) as unknown as typeof fetch,
  })).rejects.toThrow('wallet_funding_amount_unavailable');
  const maximum = queuedDatabase([[{ id, created_at: createdAt }]]);
  expect((await createPersonalFundingIntent(maximum.database, { ...input, amount: 15000 }, 'owner', { fetchImpl: productionFetch })).requestedAmount).toBe(15000);
  for (const amount of [20, 49.99]) await expect(createAdministrativeSandboxSession(blocked.database, { ...adminInput, amount }, {
    subject: 'owner', clientIp: '192.0.2.1', environment,
    fetchImpl: (async () => { throw new Error('must not contact provider'); }) as unknown as typeof fetch,
  })).rejects.toThrow('wallet_funding_amount_unavailable');
  expect(blocked.queries).toHaveLength(0);
  const administrative = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: true }]]);
  const adminResult = await createAdministrativeSandboxSession(administrative.database, { ...adminInput, amount: 50 }, {
    subject: 'owner', clientIp: '192.0.2.1', environment, fetchImpl: withSandboxOptions((async (_url, init) => {
      expect(JSON.parse(String(init?.body)).sessionData.sourceAmount).toBe('50.00');
      return Response.json({ id: 'synthetic-session', widgetUrl: 'https://sb.meldcrypto.com/?wt=synthetic-token' });
    }) as typeof fetch),
  });
  expect(adminResult.requestedAmount).toBe(50);
});

test('personal SPEI uses the actual MXN amount and provider limits without manufacturing a USD valuation', async () => {
  const speiInput = { ...input, country: 'MX', sourceCurrencyCode: 'MXN', paymentMethodType: 'SPEI', amount: 931 };
  const fetchImpl = (async (url, init) => {
    expect(String(url)).toContain('https://api.meld.io/network-partner/supported/routes/CRYPTO_ONRAMP/MX/MXN/USDT_POLYGON');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).not.toContain(environment.MELD_API_SANDBOX);
    return Response.json([{ partner: 'SWAPPED', source: 'MXN', destination: 'USDT_POLYGON', paymentMethods: [
      { name: 'SPEI', limits: { currencyCode: 'MXN', min: 148.66, max: 212_370.61 } },
      { name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'MXN', min: 100, max: 500_000 } },
    ] }, { partner: 'TOPPER', source: 'MXN', destination: 'USDT_POLYGON', paymentMethods: [
      { name: 'SPEI', limits: { currencyCode: 'MXN', min: 1, max: 500_000 } },
    ] }]);
  }) as typeof fetch;
  const { database, queries } = queuedDatabase([[{ id, created_at: createdAt }]]);
  const result = await createPersonalFundingIntent(database, speiInput, 'owner', { fetchImpl });
  expect(result).toMatchObject({ requestedAmount: 931, sourceCurrencyCode: 'MXN', paymentMethodType: 'SPEI', allowedProviders: ['SWAPPED'] });
  expect(queries[0]!.params).toEqual(['owner', address, 'MX', 931, id, 'SPEI', 'MXN']);
  for (const amount of [148.66, 930.99, 212_370.62]) {
    const blocked = queuedDatabase([]);
    await expect(createPersonalFundingIntent(blocked.database, { ...speiInput, amount }, 'owner', { fetchImpl }))
      .rejects.toThrow('wallet_funding_amount_unavailable');
    expect(blocked.queries).toHaveLength(0);
  }
  const higher = queuedDatabase([]);
  await expect(createPersonalFundingIntent(higher.database, speiInput, 'owner', { fetchImpl: (async () => Response.json([
    { partner: 'MERCURYO', source: 'MXN', destination: 'USDT_POLYGON', paymentMethods: [
      { name: 'SPEI', limits: { currencyCode: 'MXN', min: 1200, max: 10000 } },
    ] },
  ])) as unknown as typeof fetch })).rejects.toThrow('wallet_funding_amount_unavailable');
  expect(higher.queries).toHaveLength(0);
  const below = queuedDatabase([]);
  await expect(createPersonalFundingIntent(below.database, { ...speiInput, amount: 930.99 }, 'owner', {
    fetchImpl: (async () => { throw new Error('below business minimum must not query a quote'); }) as unknown as typeof fetch,
  })).rejects.toThrow('wallet_funding_amount_unavailable');
  expect(below.queries).toHaveLength(0);
  for (const change of [{ country: 'US' }, { paymentMethodType: 'PSE' }, { sourceCurrencyCode: 'COP' }]) {
    const blocked = queuedDatabase([]);
    await expect(createPersonalFundingIntent(blocked.database, { ...speiInput, ...change }, 'owner', {
      fetchImpl: (async () => { throw new Error('must not query an unsupported source'); }) as unknown as typeof fetch,
    })).rejects.toThrow('wallet_funding_valuation_unavailable');
    expect(blocked.queries).toHaveLength(0);
  }
});

test('personal cancellation at the final discovery boundary never starts intent persistence', async () => {
  const controller = new AbortController();
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  // The read completed successfully, but cancellation arrives while it releases
  // its parent listener and before createPersonalFundingIntent resumes.
  Object.defineProperty(controller.signal, 'removeEventListener', { value: (...args: Parameters<AbortSignal['removeEventListener']>) => {
    remove(...args);
    controller.abort();
  } });
  const { database, queries } = queuedDatabase([]);
  let reads = 0;
  await expect(createPersonalFundingIntent(database, input, 'owner', { signal: controller.signal,
    fetchImpl: (async () => { reads++; return Response.json([personalRoute('SWAPPED')]); }) as unknown as typeof fetch,
  })).rejects.toMatchObject({ name: 'AbortError' });
  expect(reads).toBe(1);
  expect(queries).toHaveLength(0);
});

test('US Venmo and PayPal bind only Topper while every Mexico MXN method retains actual pesos and provider limits', async () => {
  for (const paymentMethodType of ['VENMO', 'PAYPAL']) {
    const selectedMethod = { ...method(paymentMethodType, 10, 1000), checkoutSupported: true };
    const fetchImpl = (async () => Response.json([personalRoute('TOPPER', [selectedMethod]), personalRoute('SWAPPED', [selectedMethod])])) as unknown as typeof fetch;
    expect(await createPersonalFundingIntent(queuedDatabase([[{ id, created_at: createdAt }]]).database, { ...input, paymentMethodType }, 'owner', { fetchImpl }))
      .toMatchObject({ sourceCurrencyCode: 'USD', requestedAmount: 100, allowedProviders: ['TOPPER'], paymentMethodType });
    for (const country of ['MX', 'CO']) await expect(createPersonalFundingIntent(queuedDatabase([]).database,
      { ...input, country, paymentMethodType }, 'owner', { fetchImpl })).rejects.toThrow('wallet_funding_method_unavailable');
  }
  for (const paymentMethodType of ['SPEI', 'CREDIT_DEBIT_CARD', 'APPLE_PAY', 'GOOGLE_PAY']) {
    const selected = { ...input, country: 'MX', sourceCurrencyCode: 'MXN', paymentMethodType, amount: 931 };
    const fetchImpl = (async () => Response.json([{ partner: 'MERCURYO', source: 'MXN', destination: 'USDT_POLYGON', paymentMethods: [
      { name: paymentMethodType, checkoutSupported: true, limits: { currencyCode: 'MXN', min: 520.03, max: 312013.70 } },
    ] }])) as unknown as typeof fetch;
    const captured = queuedDatabase([[{ id, created_at: createdAt }]]);
    expect(await createPersonalFundingIntent(captured.database, selected, 'owner', { fetchImpl }))
      .toMatchObject({ requestedAmount: 931, sourceCurrencyCode: 'MXN', paymentMethodType, allowedProviders: ['MERCURYO'] });
    expect(captured.queries[0]!.params).toEqual(['owner', address, 'MX', 931, id, paymentMethodType, 'MXN']);
    await expect(createPersonalFundingIntent(queuedDatabase([]).database, { ...selected, amount: 930.99 }, 'owner', { fetchImpl })).rejects.toThrow('wallet_funding_amount_unavailable');
    await expect(createPersonalFundingIntent(queuedDatabase([]).database, { ...selected, amount: 312013.71 }, 'owner', { fetchImpl })).rejects.toThrow('wallet_funding_amount_unavailable');
  }
});

test('personal country and method restrictions cannot be bypassed by forging an intent or another catalogue', async () => {
  const blocked = queuedDatabase([]);
  for (const country of ['PA', 'GB', 'ES']) {
    await expect(createPersonalFundingIntent(blocked.database, { ...input, country }, 'owner', {
      fetchImpl: (async () => { throw new Error('unsupported country must not fetch'); }) as unknown as typeof fetch,
    })).rejects.toThrow('wallet_funding_invalid_country');
  }
  for (const paymentMethodType of ['NETELLER', 'PAYSAFECARD', 'PAYSAFE_CARD', 'SKRILL', 'SKIRLL', 'ASTROPAY']) {
    await expect(createPersonalFundingIntent(blocked.database, { ...input, paymentMethodType }, 'owner', {
      fetchImpl: (async () => { throw new Error('A prohibited personal method must not request provider discovery'); }) as unknown as typeof fetch,
    })).rejects.toThrow('wallet_funding_method_unavailable');
  }
  expect(blocked.queries).toHaveLength(0);
  const admin = await readAdministrativeSandboxOptions({ country: 'CO', serviceProvider: 'BANXA' }, { environment,
    fetchImpl: (async () => Response.json([route('BANXA', [method('NETELLER'), method('SKRILL')])])) as unknown as typeof fetch });
  expect(admin.country).toBe('CO');
  expect(admin.paymentMethods).toEqual(['NETELLER', 'SKRILL']);
});

test('Colombia personal funding records USD30 through its production routes and rejects local-currency substitutions before a write', async () => {
  const captured = queuedDatabase([[{ id, created_at: createdAt }]]);
  const result = await createPersonalFundingIntent(captured.database, { ...input, country: 'CO', amount: 30 }, 'owner', {
    fetchImpl: (async (url, init) => {
      expect(String(url)).toBe('https://api.meld.io/network-partner/supported/routes/CRYPTO_ONRAMP/CO/USD/USDT_POLYGON?partners=SWAPPED');
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).not.toContain(environment.MELD_API_SANDBOX);
      return Response.json([personalRoute('SWAPPED'), personalRoute('MERCURYO')]);
    }) as typeof fetch,
  });
  expect(result).toMatchObject({ requestedAmount: 30, sourceCurrencyCode: 'USD', walletKind: 'personal',
    environment: 'production', allowedProviders: ['SWAPPED'] });
  expect(captured.queries[0]!.params).toEqual(['owner', address, 'CO', 30, id, 'CREDIT_DEBIT_CARD', 'USD']);
  const blocked = queuedDatabase([]);
  for (const sourceCurrencyCode of ['COP', 'MXN']) await expect(createPersonalFundingIntent(blocked.database,
    { ...input, country: 'CO', sourceCurrencyCode, paymentMethodType: 'SPEI', amount: 931 }, 'owner', {
      fetchImpl: (async () => { throw new Error('invalid currency must not fetch'); }) as unknown as typeof fetch,
    })).rejects.toThrow('wallet_funding_valuation_unavailable');
  expect(blocked.queries).toHaveLength(0);
});

test('new COP intents stop before provider lookup or persistence while historical COP readers remain independent',async()=>{
  for(const paymentMethodType of ['PSE','LOCAL_BANK_TRANSFER','CREDIT_DEBIT_CARD'])for(const amount of [42300,100000,170000,4000000]){
    const captured=queuedDatabase([]);let calls=0;
    await expect(createPersonalFundingIntent(captured.database,{...input,country:'CO',sourceCurrencyCode:'COP',paymentMethodType,amount},'owner',{fetchImpl:(async()=>{calls++;throw Error('COP checkout disabled');}) as unknown as typeof fetch})).rejects.toThrow('wallet_funding_valuation_unavailable');
    expect(calls).toBe(0);expect(captured.queries).toHaveLength(0);
  }
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
      expect(body).toEqual({ sessionType: 'BUY', externalCustomerId: customerReference, externalSessionId: id,
        sessionData: { serviceProvider: 'TRANSAK', countryCode: 'US', clientIpAddress: '192.0.2.1', sourceCurrencyCode: 'USD', sourceAmount: '100.00',
          destinationCurrencyCode: 'USDT_POLYGON', walletAddress: address, paymentMethodType: 'CREDIT_DEBIT_CARD',
          lockFields: ['walletAddress', 'destinationCurrencyCode', 'sourceCurrencyCode', 'sourceAmount', 'paymentMethodType'] } });
      return Response.json({ id: 'provider-session', widgetUrl: 'https://sb.meldcrypto.com/?wt=synthetic-token',
        externalSessionId: id, externalCustomerId: customerReference, token: 'must-not-be-exposed', customerId: 'must-not-be-exposed' });
    }) as typeof fetch) });
  expect(calls).toBe(1);
  expect(result.environment).toBe('sandbox');
  expect(result.checkoutUrl).toBe('https://sb.meldcrypto.com/?wt=synthetic-token');
  expect(queries.map(query => query.sql).join(' ')).not.toContain('create_meld_onramp_attempt');
  expect(queries[2]!.params).toEqual(['synthetic-owner', id, 'session_created', 'provider-session']);
  expect(JSON.stringify(queries)).not.toContain('synthetic-token');
  expect(Object.keys(result)).not.toContain('token');
});

test('administrative retries keep one trusted customer identity while each attempt has a unique session reference', async () => {
  const requestIds = [id, '11111111-1111-4111-8111-111111111111'];
  const seen: { customer: string; session: string }[] = [];
  for (const requestId of requestIds) {
    const { database } = queuedDatabase([[assignment], [{ id: requestId, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: true }]]);
    const result = await createAdministrativeSandboxSession(database, { ...adminInput, requestId }, {
      subject: 'owner', clientIp: '192.0.2.1', environment: { ...environment, MELD_API_KEY: 'unused-live-key' },
      fetchImpl: withSandboxOptions((async (url, init) => {
        expect(url).toBe('https://api-sb.meld.io/crypto/session/widget');
        expect(new Headers(init!.headers).get('authorization')).toBe('BASIC synthetic-sandbox-key');
        const body = JSON.parse(init!.body as string);
        seen.push({ customer: body.externalCustomerId, session: body.externalSessionId });
        return Response.json({ id: `provider-${requestId}`, widgetUrl: 'https://sb.meldcrypto.com/?wt=synthetic',
          externalCustomerId: body.externalCustomerId, externalSessionId: body.externalSessionId });
      }) as typeof fetch),
    });
    expect(result.checkoutReference).toBe(requestId);
  }
  expect(seen.map(value => value.customer)).toEqual([customerReference, customerReference]);
  expect(seen.map(value => value.session)).toEqual(requestIds);
  expect(new Set(seen.map(value => value.session)).size).toBe(2);
});

test('invalid assignment customer identities stop before persistence or provider calls, and mismatched echoes fail closed', async () => {
  let calls = 0;
  const neverFetch = (async () => { calls++; throw new Error('unexpected provider call'); }) as unknown as typeof fetch;
  for (const checkout_reference of [customerReference.toUpperCase(), '12345678-1234-7123-8123-123456789abc']) {
    const bad = queuedDatabase([[{ ...assignment, checkout_reference }]]);
    await expect(createAdministrativeSandboxSession(bad.database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment,
      fetchImpl: neverFetch })).rejects.toThrow('wallet_funding_unconfigured');
    expect(bad.queries).toHaveLength(1);
  }
  expect(calls).toBe(0);
  const badEcho = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: true }]]);
  await expect(createAdministrativeSandboxSession(badEcho.database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment,
    diagnostic: () => {}, fetchImpl: withSandboxOptions((async () => Response.json({ id: 'provider-id', widgetUrl: 'https://sb.meldcrypto.com/?wt=synthetic',
      externalCustomerId: id, externalSessionId: id })) as unknown as typeof fetch) })).rejects.toThrow('wallet_funding_invalid_provider');
  expect(badEcho.queries[2]!.params[2]).toBe('failed');
});

test('disabled sandbox and foreign addresses never reach providers; persisted duplicate requests cannot open another widget', async () => {
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
  await expect(createAdministrativeSandboxSession(duplicate.database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment, fetchImpl: withSandboxOptions(neverFetch) }))
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
  expect(options).toEqual({ walletKind: 'administrative', environment: 'sandbox', provider: 'meld', country: 'US', sourceCurrencyCode: 'USD',
    serviceProvider: 'TRANSAK', paymentMethods: ['CREDIT_DEBIT_CARD', 'APPLE_PAY'], routes: [{ serviceProvider: 'TRANSAK', paymentMethods: [
      { method: 'CREDIT_DEBIT_CARD', currencyCode: 'USD', minimumAmount: 20, maximumAmount: 15000, minimumUsd: 20, maximumUsd: 15000 },
      { method: 'APPLE_PAY', currencyCode: 'USD', minimumAmount: 20, maximumAmount: 15000, minimumUsd: 20, maximumUsd: 15000 }] }] });
  const missing = await readAdministrativeSandboxOptions({ country: 'CO', serviceProvider: 'TRANSAK' }, { environment,
    fetchImpl: (async () => Response.json([route('BANXA')])) as unknown as typeof fetch });
  expect(missing.paymentMethods).toEqual([]);
});

test('administrative MXN methods belong to the sandbox account and selected provider only', async () => {
  const result = await readAdministrativeSandboxOptions({ country: 'MX', sourceCurrencyCode: 'MXN', serviceProvider: 'TRANSAK' }, {
    environment, fetchImpl: (async (url, init) => {
      expect(String(url)).toBe('https://api-sb.meld.io/network-partner/supported/routes/CRYPTO_ONRAMP/MX/MXN/USDT_POLYGON');
      expect(new Headers(init!.headers).get('authorization')).toBe('BASIC synthetic-sandbox-key');
      return Response.json([{ partner: 'TRANSAK', source: 'MXN', destination: 'USDT_POLYGON',
        paymentMethods: [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'MXN', min: 150, max: 200_000 } }] },
      { partner: 'SWAPPED', source: 'MXN', destination: 'USDT_POLYGON',
        paymentMethods: [{ name: 'NETELLER', limits: { currencyCode: 'MXN', min: 100, max: 250_000 } }] }]);
    }) as typeof fetch,
  });
  expect(result).toMatchObject({ walletKind: 'administrative', environment: 'sandbox', provider: 'meld', country: 'MX',
    sourceCurrencyCode: 'MXN', paymentMethods: ['CREDIT_DEBIT_CARD'], routes: [{ serviceProvider: 'TRANSAK', paymentMethods: [
      { method: 'CREDIT_DEBIT_CARD', currencyCode: 'MXN', minimumAmount: 150, maximumAmount: 200_000 },
    ] }] });
  expect(JSON.stringify(result)).not.toContain('minimumUsd');
  const bad = await readAdministrativeSandboxOptions({ country: 'MX', sourceCurrencyCode: 'MXN', serviceProvider: 'BANXA' }, {
    environment, fetchImpl: (async () => Response.json([{ partner: 'BANXA', source: 'USD', destination: 'USDT_POLYGON', paymentMethods: [method()] }])) as unknown as typeof fetch,
  }).then(() => null, error => error);
  expect(bad?.message).toBe('wallet_funding_provider_unavailable');
});

test('local fiat cannot be relabelled as a USD minimum before a verified provider valuation exists', async () => {
  const never = (async () => { throw new Error('must not contact provider'); }) as unknown as typeof fetch;
  for (const sourceCurrencyCode of ['MXN', 'COP']) {
    const { database, queries } = queuedDatabase([]);
    await expect(createPersonalFundingIntent(database, { ...input, country: 'MX', sourceCurrencyCode, paymentMethodType: 'VENMO' }, 'owner', { fetchImpl: never }))
      .rejects.toThrow('wallet_funding_valuation_unavailable');
    await expect(createAdministrativeSandboxSession(database, { ...adminInput, sourceCurrencyCode }, {
      subject: 'owner', clientIp: '192.0.2.1', environment, fetchImpl: never,
    })).rejects.toThrow('wallet_funding_valuation_unavailable');
    expect(queries).toHaveLength(0);
  }
  for (const amount of [19.99, 25_000.01]) {
    const { database, queries } = queuedDatabase([]);
    await expect(createPersonalFundingIntent(database, { ...input, amount }, 'owner', { fetchImpl: never }))
      .rejects.toThrow('wallet_funding_amount_unavailable');
    await expect(createAdministrativeSandboxSession(database, { ...adminInput, amount }, {
      subject: 'owner', clientIp: '192.0.2.1', environment, fetchImpl: never,
    })).rejects.toThrow('wallet_funding_amount_unavailable');
    expect(queries).toHaveLength(0);
  }
});

test('the shared Banxa sandbox authentication failure is actionable without exposing provider messages', async () => {
  const diagnostics: unknown[] = [];
  const { database, queries } = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: true }]]);
  await expect(createAdministrativeSandboxSession(database, { ...adminInput, serviceProvider: 'BANXA', country: 'CO' }, {
    subject: 'owner', clientIp: '192.0.2.1', environment, diagnostic: event => diagnostics.push(event),
    fetchImpl: (async url => String(url).includes('/supported/routes/') ? Response.json([route('BANXA')])
      : Response.json({ code: 'SERVICE_PROVIDER_AUTHENTICATION_EXCEPTION', message: 'private provider message with secret',
        serviceProviderDetails: { address, token: 'private-token' } }, { status: 401 })) as typeof fetch,
  })).rejects.toThrow('wallet_funding_provider_authentication_unavailable');
  expect(queries).toHaveLength(1);
  expect(diagnostics).toEqual([{ event: 'wallet_funding_provider_failure', environment: 'sandbox', phase: 'quote', status: 401,
    code: 'UPSTREAM_REJECTED', providerCode: 'SERVICE_PROVIDER_AUTHENTICATION_EXCEPTION' }]);
  expect(JSON.stringify(diagnostics)).not.toMatch(/private|secret|0x|token/);
});

test('a missing sandbox method never opens a widget or consumes an attempt', async () => {
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
  expect(queries).toHaveLength(1);
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
  expect(outside.queries).toHaveLength(1);
  expect(diagnostics).toEqual([{ event: 'wallet_funding_provider_failure', environment: 'sandbox', phase: 'options', status: null, code: 'AMOUNT_OUTSIDE_ROUTE_LIMITS' }]);
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

test('documented widget quote, timeout and authentication failures retain only their top-level code and bounded reference', async () => {
  for (const providerRequestId of ['01JB2K7C9XQZ4M8N2P5R6T3V', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'A1111111-1111-4111-8111-11111111111A']) {
    for (const [status, providerCode] of [[408, 'QUOTE_TIMEOUT'], [422, 'TRANSACTION_FAILED_GETTING_CRYPTO_QUOTE_FROM_PROVIDER'],
      [500, 'TRANSACTION_FAILED_GETTING_CRYPTO_QUOTE'], [500, 'KYC_TOKEN_GENERATION_FAILED'], [500, 'PRIOR_AUTHENTICATION_ERROR']] as const) {
      const diagnostics: unknown[] = [];
      const { database, queries } = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: true }]]);
      await expect(createAdministrativeSandboxSession(database, adminInput, { subject: 'private-owner', clientIp: '192.0.2.1', environment,
        diagnostic: event => diagnostics.push(event), fetchImpl: withSandboxOptions((async () => Response.json({ code: providerCode, requestId: providerRequestId,
          message: 'private-user@example.invalid', errors: ['private-token'], serviceProviderDetails: { code: 'PRIVATE_CODE', message: 'private-message', walletAddress: address },
          token: 'private-token', widgetUrl: 'https://sb.meldcrypto.com/?wt=private-token' }, { status })) as unknown as typeof fetch),
      })).rejects.toThrow('wallet_funding_provider_unavailable');
      expect(diagnostics).toEqual([{ event: 'wallet_funding_provider_failure', environment: 'sandbox', phase: 'session', status, requestId: id,
        code: 'UPSTREAM_REJECTED', providerCode, providerRequestId }]);
      expect(queries[2]!.params).toEqual(['private-owner', id, 'unavailable', null]);
      expect(JSON.stringify(diagnostics)).not.toMatch(/private|0x|@|wt=|192\.0\.2/);
    }
  }
});

test('sandbox diagnostics reject malformed references and never promote nested provider data', async () => {
  const validReference = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const documentedReference = '01JB2K7C9XQZ4M8N2P5R6T3V';
  for (const requestId of ['private-user@example.invalid', 'Bearer private-token', 'https://example.invalid/private-token',
    `${validReference}\n`, `${validReference}\nprivate-token`, `${validReference}?token=private-token`,
    '81ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAI', validReference.toLowerCase(), validReference.slice(1),
    `${documentedReference}\n`, documentedReference.toLowerCase(), documentedReference.slice(1), '01JB2K7C9XQZ4M8N2P5R6T3I',
    { value: validReference }, [validReference], null]) {
    const diagnostics: unknown[] = [];
    await expect(readAdministrativeSandboxOptions({ country: 'CO', serviceProvider: 'BANXA' }, { environment,
      diagnostic: event => diagnostics.push(event), fetchImpl: (async () => Response.json({ code: 'PRIVATE_CODE', requestId,
        message: 'private-message', errors: ['private-token'], serviceProviderDetails: { code: 'QUOTE_TIMEOUT', requestId: validReference, walletAddress: address },
        token: 'private-token', widgetUrl: 'https://sb.meldcrypto.com/?wt=private-token' }, { status: 500 })) as unknown as typeof fetch,
    })).rejects.toThrow('wallet_funding_provider_unavailable');
    expect(diagnostics).toEqual([{ event: 'wallet_funding_provider_failure', environment: 'sandbox', phase: 'options', status: 500, code: 'UPSTREAM_REJECTED' }]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/private|0x|@|wt=|QUOTE_TIMEOUT|01AR/);
  }
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
        if (String(url).includes('/payments/crypto/quote')) return Response.json({ quotes: [{ serviceProvider: 'TRANSAK', paymentMethodType: 'CREDIT_DEBIT_CARD', sourceCurrencyCode: 'USD', destinationCurrencyCode: 'USDT_POLYGON', sourceAmount: 100, destinationAmount: 95 }] });
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
    wallet_address: address, country_code: 'US', requested_amount: '100.00', destination_currency: 'USDT_POLYGON', source_currency: 'USD', payment_method: null, created_at: createdAt,
    token: 'private', commission: 20, subject: 'private-owner' };
  const { database, queries } = queuedDatabase([[row]]);
  expect(await readWalletFundingHistory(database, 'owner', 'personal')).toEqual({ walletKind: 'personal', environment: 'production',
    records: [{ checkoutReference: id, provider: 'reown', status: 'initiated', country: 'US', requestedAmount: 100, sourceCurrencyCode: 'USD', destination: { address, asset: 'USDT', network: 'polygon', chainId: 137 }, createdAt: createdAt.toISOString() }],
    settlement: 'unconfirmed' });
  expect(queries[0]!.params).toEqual(['owner', 'personal']);
  for (const bad of [{ ...row, environment: 'sandbox' }, { ...row, wallet_kind: 'administrative' }, { ...row, status: 'complete' }]) {
    const queued = queuedDatabase([[bad]]);
    await expect(readWalletFundingHistory(queued.database, 'owner', 'personal')).rejects.toThrow();
  }
});

test('history and owned status accept personal USD20 while rejecting an administrative record below USD50', async () => {
  const personal = { id, wallet_kind: 'personal', environment: 'production', provider: 'reown', status: 'initiated',
    wallet_address: address, country_code: 'US', requested_amount: '20.00', destination_currency: 'USDT_POLYGON', source_currency: 'USD', payment_method: null, created_at: createdAt };
  const history = await readWalletFundingHistory(queuedDatabase([[personal]]).database, 'owner', 'personal');
  expect(history.records[0]!.requestedAmount).toBe(20);
  const status = await readWalletFundingStatus(queuedDatabase([[personal]]).database, 'owner', 'personal', id);
  expect(status.requestedAmount).toBe(20);
  expect(status.confirmation).toEqual({ state: 'unconfirmed', source: 'none', testMode: false });
  for (const amount of ['50.00', '25000.00']) {
    const legacy = { ...personal, requested_amount: amount };
    expect((await readWalletFundingHistory(queuedDatabase([[legacy]]).database, 'owner', 'personal')).records[0]!.requestedAmount).toBe(Number(amount));
    expect((await readWalletFundingStatus(queuedDatabase([[legacy]]).database, 'owner', 'personal', id)).requestedAmount).toBe(Number(amount));
  }
  const administrative = { ...personal, wallet_kind: 'administrative', environment: 'sandbox', provider: 'meld', status: 'session_created' };
  await expect(readWalletFundingHistory(queuedDatabase([[administrative]]).database, 'owner', 'administrative'))
    .rejects.toThrow('wallet_funding_unavailable');
  await expect(readWalletFundingStatus(queuedDatabase([[administrative]]).database, 'owner', 'administrative', id))
    .rejects.toThrow('wallet_funding_unavailable');
});

test('V2 history and status expose explicit MXN/SPEI metadata and reject currency relabelling or crossed wallets', async () => {
  const row = { id, wallet_kind: 'personal', environment: 'production', provider: 'reown', status: 'initiated',
    wallet_address: address, country_code: 'MX', requested_amount: '148.66', destination_currency: 'USDT_POLYGON', source_currency: 'MXN', payment_method: 'SPEI', created_at: createdAt };
  const history = queuedDatabase([[row]]);
  const result = await readWalletFundingHistory(history.database, 'owner', 'personal');
  expect(history.queries[0]!.sql).toContain('payments.read_wallet_funding_history_v4');
  expect(result.records[0]).toMatchObject({ requestedAmount: 148.66, sourceCurrencyCode: 'MXN', paymentMethodType: 'SPEI' });
  const status = queuedDatabase([[row]]);
  const snapshot = await readWalletFundingStatus(status.database, 'owner', 'personal', id);
  expect(status.queries[0]!.sql).toContain('payments.read_wallet_funding_status_v4');
  expect(snapshot).toMatchObject({ requestedAmount: 148.66, sourceCurrencyCode: 'MXN', paymentMethodType: 'SPEI', country: 'MX',
    confirmation: { state: 'unconfirmed', source: 'none', testMode: false } });
  for (const change of [{ source_currency: undefined }, { source_currency: 'COP' }, { country_code: 'US' },
    { payment_method: null }, { payment_method: 'LOCAL_BANK_TRANSFER' }, { requested_amount: '148.666' }]) {
    await expect(readWalletFundingHistory(queuedDatabase([[{ ...row, ...change }]]).database, 'owner', 'personal')).rejects.toThrow();
    await expect(readWalletFundingStatus(queuedDatabase([[{ ...row, ...change }]]).database, 'owner', 'personal', id)).rejects.toThrow();
  }
  const administrative = { ...row, wallet_kind: 'administrative', environment: 'sandbox', provider: 'meld', status: 'session_created' };
  await expect(readWalletFundingHistory(queuedDatabase([[administrative]]).database, 'owner', 'administrative'))
    .rejects.toThrow('wallet_funding_unavailable');
});

test('COP history and status retain old PSE amounts and separate local-bank Polygon units without crossed fiat, networks or sandbox wallets', async () => {
  const row = { id, wallet_kind: 'personal', environment: 'production', provider: 'reown', status: 'initiated', wallet_address: address,
    country_code: 'CO', requested_amount: '42300.00', destination_currency: 'USDT_POLYGON', source_currency: 'COP', payment_method: 'PSE', created_at: createdAt };
  expect((await readWalletFundingHistory(queuedDatabase([[row]]).database, 'owner', 'personal')).records[0]).toMatchObject({ requestedAmount: 42300,
    sourceCurrencyCode: 'COP', paymentMethodType: 'PSE', country: 'CO', destination: { network: 'polygon', chainId: 137 } });
  expect(await readWalletFundingStatus(queuedDatabase([[row]]).database, 'owner', 'personal', id)).toMatchObject({ requestedAmount: 42300,
    sourceCurrencyCode: 'COP', paymentMethodType: 'PSE', confirmation: { state: 'unconfirmed', source: 'none', testMode: false } });
  const old = { ...row, requested_amount: '100000.00' };
  expect((await readWalletFundingHistory(queuedDatabase([[old]]).database, 'owner', 'personal')).records[0]!.requestedAmount).toBe(100000);
  const local = { ...row, requested_amount: '170000.00', payment_method: 'LOCAL_BANK_TRANSFER' };
  expect((await readWalletFundingHistory(queuedDatabase([[local]]).database, 'owner', 'personal')).records[0]).toMatchObject({ requestedAmount: 170000, sourceCurrencyCode: 'COP', paymentMethodType: 'LOCAL_BANK_TRANSFER' });
  for (const change of [{ country_code: 'MX' }, { country_code: 'US' }, { payment_method: 'SPEI' }, { payment_method: null },
    { destination_currency: 'USDT' }, { wallet_kind: 'administrative' }, { environment: 'sandbox' }, { provider: 'meld' }, { requested_amount: '42300.001' }]) {
    await expect(readWalletFundingHistory(queuedDatabase([[{ ...row, ...change }]]).database, 'owner', 'personal')).rejects.toThrow();
    await expect(readWalletFundingStatus(queuedDatabase([[{ ...row, ...change }]]).database, 'owner', 'personal', id)).rejects.toThrow();
  }
  const administrative = { ...row, wallet_kind: 'administrative', environment: 'sandbox', provider: 'meld', status: 'session_created' };
  await expect(readWalletFundingHistory(queuedDatabase([[administrative]]).database, 'owner', 'administrative')).rejects.toThrow('wallet_funding_unavailable');
});

test('new MXN card/mobile and US Venmo histories retain exact fiat and Polygon while old SPEI Ethereum remains readable', async () => {
  const row = { id, wallet_kind: 'personal', environment: 'production', provider: 'reown', status: 'initiated', wallet_address: address,
    country_code: 'MX', requested_amount: '931.00', destination_currency: 'USDT_POLYGON', source_currency: 'MXN', payment_method: 'CREDIT_DEBIT_CARD', created_at: createdAt };
  for (const payment_method of ['CREDIT_DEBIT_CARD', 'APPLE_PAY', 'GOOGLE_PAY']) {
    expect((await readWalletFundingHistory(queuedDatabase([[{ ...row, payment_method }]]).database, 'owner', 'personal')).records[0])
      .toMatchObject({ requestedAmount: 931, sourceCurrencyCode: 'MXN', paymentMethodType: payment_method });
    await expect(readWalletFundingStatus(queuedDatabase([[{ ...row, payment_method, destination_currency: 'USDT' }]]).database, 'owner', 'personal', id)).rejects.toThrow();
  }
  expect((await readWalletFundingHistory(queuedDatabase([[{ ...row, payment_method: 'SPEI', destination_currency: 'USDT', requested_amount: '148.66' }]]).database, 'owner', 'personal')).records[0])
    .toMatchObject({ requestedAmount: 148.66, sourceCurrencyCode: 'MXN', paymentMethodType: 'SPEI', destination: { network: 'ethereum' } });
  const venmo = { ...row, country_code: 'US', source_currency: 'USD', payment_method: 'VENMO', requested_amount: '100.00' };
  expect((await readWalletFundingStatus(queuedDatabase([[venmo]]).database, 'owner', 'personal', id)).requestedAmount).toBe(100);
  for (const change of [{ country_code: 'MX' }, { source_currency: 'MXN' }, { destination_currency: 'USDT' }]) {
    await expect(readWalletFundingHistory(queuedDatabase([[{ ...venmo, ...change }]]).database, 'owner', 'personal')).rejects.toThrow();
  }
});

test('owned status returns the immutable stored destination and cannot turn checkout creation into payment confirmation', async () => {
  for (const walletKind of ['personal', 'administrative'] as const) {
    const personal = walletKind === 'personal';
    const row = { id, wallet_kind: walletKind, environment: personal ? 'production' : 'sandbox', provider: personal ? 'reown' : 'meld',
      status: personal ? 'initiated' : 'session_created', wallet_address: address, country_code: 'CO', requested_amount: '100.00',
      destination_currency: 'USDT_POLYGON', source_currency: 'USD', payment_method: null, created_at: createdAt,
      confirmation: { state: 'confirmed' }, paid: true, token: 'private', subject: 'private-owner', checkout_url: 'https://sb.meldcrypto.com/?wt=private' };
    const { database, queries } = queuedDatabase([[row]]);
    expect(await readWalletFundingStatus(database, 'native-owner', walletKind, id)).toEqual({
      checkoutReference: id, walletKind, environment: personal ? 'production' : 'sandbox', provider: personal ? 'reown' : 'meld',
      requestedAmount: 100, sourceCurrencyCode: 'USD', country: 'CO', requestStatus: personal ? 'initiated' : 'session_created',
      destination: { address, asset: 'USDT', network: 'polygon', chainId: 137 },
      confirmation: { state: 'unconfirmed', source: 'none', testMode: !personal },
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('payments.read_wallet_funding_status');
    expect(queries[0]!.params).toEqual(['native-owner', walletKind, id]);
    expect(queries[0]!.sql).not.toContain('wallet_binding');
  }
});

test('status fails closed on another wallet, wrong reference, duplicate rows or success-looking untrusted state', async () => {
  const row = { id, wallet_kind: 'personal', environment: 'production', provider: 'reown', status: 'initiated',
    wallet_address: address, country_code: 'US', requested_amount: '100', destination_currency: 'USDT_POLYGON', source_currency: 'USD', payment_method: null, created_at: createdAt };
  await expect(readWalletFundingStatus(queuedDatabase([[]]).database, 'owner', 'personal', id)).rejects.toThrow('wallet_funding_not_found');
  for (const rows of [[{ ...row, wallet_kind: 'administrative' }], [{ ...row, environment: 'sandbox' }], [{ ...row, provider: 'meld' }],
    [{ ...row, id: '11111111-1111-4111-8111-111111111111' }], [{ ...row, status: 'complete' }], [row, row]]) {
    await expect(readWalletFundingStatus(queuedDatabase([rows]).database, 'owner', 'personal', id)).rejects.toThrow();
  }
  const invalid = queuedDatabase([]);
  for (const reference of ['not-a-uuid', `${id}' OR true`, { checkoutReference: id }, null]) {
    await expect(readWalletFundingStatus(invalid.database, 'owner', 'personal', reference)).rejects.toThrow();
  }
  expect(invalid.queries).toHaveLength(0);
});


test('funding destinations preserve Ethereum personal requests and legacy Polygon without mixing the administrative wallet', async () => {
  const base = { id, wallet_kind: 'personal', environment: 'production', provider: 'reown', status: 'initiated',
    wallet_address: address, country_code: 'US', requested_amount: '30.00', destination_currency: 'USDT', source_currency: 'USD',
    payment_method: 'CREDIT_DEBIT_CARD', created_at: createdAt };
  const ethereum = { address, asset: 'USDT', network: 'ethereum', chainId: 1 } as const;
  const polygon = { address, asset: 'USDT', network: 'polygon', chainId: 137 } as const;
  const history = await readWalletFundingHistory(queuedDatabase([[base, { ...base, id: '11111111-1111-4111-8111-111111111111', destination_currency: 'USDT_POLYGON' }]]).database, 'owner', 'personal');
  expect(history.records.map(row => row.destination)).toEqual([ethereum, polygon]);
  expect((await readWalletFundingStatus(queuedDatabase([[base]]).database, 'owner', 'personal', id)).destination).toEqual(ethereum);
  const administrative = { ...base, wallet_kind: 'administrative', environment: 'sandbox', provider: 'meld', status: 'session_created', requested_amount: '100.00' };
  await expect(readWalletFundingStatus(queuedDatabase([[administrative]]).database, 'owner', 'administrative', id)).rejects.toThrow('wallet_funding_unavailable');
  expect((await readWalletFundingStatus(queuedDatabase([[{ ...administrative, destination_currency: 'USDT_POLYGON' }]]).database, 'owner', 'administrative', id)).destination).toEqual(polygon);
  for (const destination_currency of [undefined, 'USDT_ARBITRUM', 'ETH', 'USDT_POLYGON ']) {
    await expect(readWalletFundingStatus(queuedDatabase([[{ ...base, destination_currency }]]).database, 'owner', 'personal', id)).rejects.toThrow();
  }
});

test('administrative MXN quote, durable attempt and widget retain the exact fiat/provider/assigned destination using provider minima', async () => {
  for (const [serviceProvider, paymentMethodType, amount, minimum] of [
    ['TRANSAK', 'CREDIT_DEBIT_CARD', 93, 93], ['TRANSAK', 'APPLE_PAY', 560, 560],
    ['TRANSAK', 'GOOGLE_PAY', 560, 560], ['BANXA', 'CREDIT_DEBIT_CARD', 650, 650],
  ] as const) {
    const db = queuedDatabase([[assignment], [{ id, created_at: createdAt, created: true, status: 'initiated' }], [{ finished: true }]]);
    const calls: string[] = [];
    const selected = { ...adminInput, country: 'MX', sourceCurrencyCode: 'MXN', serviceProvider, paymentMethodType, amount };
    const result = await createAdministrativeSandboxSession(db.database, selected, { subject: 'admin-owner', clientIp: '192.0.2.1',
      environment: { ...environment, MELD_API_KEY: 'must-never-be-used' }, fetchImpl: (async (target, init) => {
        const url = String(target); calls.push(url);
        expect(url).toStartWith('https://api-sb.meld.io/');
        expect(new Headers(init?.headers).get('authorization')).toBe('BASIC synthetic-sandbox-key');
        if (url.includes('/supported/routes/')) return Response.json([{ partner: serviceProvider, source: 'MXN', destination: 'USDT_POLYGON',
          paymentMethods: [{ name: paymentMethodType, limits: { currencyCode: 'MXN', min: minimum, max: 20000 } }] }]);
        const body = JSON.parse(String(init?.body));
        if (url.includes('/payments/crypto/quote')) {
          expect(db.queries).toHaveLength(1);
          expect(body).toEqual({ countryCode: 'MX', sourceCurrencyCode: 'MXN', destinationCurrencyCode: 'USDT_POLYGON', sourceAmount: amount,
            paymentMethodType, serviceProviders: [serviceProvider] });
          return Response.json({ quotes: [{ serviceProvider, paymentMethodType, sourceCurrencyCode: 'MXN', destinationCurrencyCode: 'USDT_POLYGON', sourceAmount: amount, destinationAmount: 4.2 }] });
        }
        expect(db.queries).toHaveLength(2);
        expect(body.sessionData).toMatchObject({ countryCode: 'MX', sourceCurrencyCode: 'MXN', sourceAmount: amount.toFixed(2), serviceProvider,
          paymentMethodType, walletAddress: assignment.address, destinationCurrencyCode: 'USDT_POLYGON' });
        return Response.json({ id: 'sandbox-session', widgetUrl: 'https://sb.meldcrypto.com/?wt=synthetic' });
      }) as typeof fetch });
    expect(result).toMatchObject({ requestedAmount: amount, sourceCurrencyCode: 'MXN', environment: 'sandbox', walletKind: 'administrative' });
    expect(db.queries[1]!.sql).toContain('create_meld_sandbox_funding_attempt_v2');
    expect(db.queries[1]!.params).toEqual(['admin-owner', address, 'MX', amount, id, serviceProvider, paymentMethodType, 'MXN']);
    expect(calls).toHaveLength(3);
    expect(db.queries.map(q => q.sql).join(' ')).not.toMatch(/create_reown|commission|meld_onramp_attempt|ledger/i);
  }
});

test('administrative MXN enforces exact country, provider rail and discovered limits without a personal 931 or USD-equivalent floor', async () => {
  const never = (async () => { throw Error('unsupported source reached provider'); }) as unknown as typeof fetch;
  for (const change of [{ country: 'US' }, { country: 'CO' }, { sourceCurrencyCode: 'COP' }, { sourceCurrencyCode: 'EUR' },
    { paymentMethodType: 'SPEI' }, { paymentMethodType: 'PSE' }, { serviceProvider: 'BANXA', paymentMethodType: 'APPLE_PAY' }]) {
    const db = queuedDatabase([]);
    await expect(createAdministrativeSandboxSession(db.database, { ...adminInput, country: 'MX', sourceCurrencyCode: 'MXN', amount: 93, ...change },
      { subject: 'owner', clientIp: '192.0.2.1', environment, fetchImpl: never })).rejects.toThrow('wallet_funding_valuation_unavailable');
    expect(db.queries).toHaveLength(0);
  }
  for (const amount of [92.99, 20000.01]) {
    const db = queuedDatabase([[assignment]]); let calls = 0;
    await expect(createAdministrativeSandboxSession(db.database, { ...adminInput, country: 'MX', sourceCurrencyCode: 'MXN', amount }, {
      subject: 'owner', clientIp: '192.0.2.1', environment, diagnostic: () => {}, fetchImpl: (async () => { calls++;
        return Response.json([{ partner: 'TRANSAK', source: 'MXN', destination: 'USDT_POLYGON', paymentMethods: [{ name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'MXN', min: 93, max: 20000 } }] }]);
      }) as unknown as typeof fetch })).rejects.toThrow('wallet_funding_amount_unavailable');
    expect(calls).toBe(1); expect(db.queries).toHaveLength(1);
  }
});

test('untrusted sandbox quotes cannot consume an attempt, open a widget or manufacture a settlement', async () => {
  const canonical = { serviceProvider: 'TRANSAK', paymentMethodType: 'CREDIT_DEBIT_CARD', sourceCurrencyCode: 'USD',
    destinationCurrencyCode: 'USDT_POLYGON', sourceAmount: 100, destinationAmount: 95 };
  for (const quotes of [[], [canonical, canonical], [{ ...canonical, sourceAmount: 101 }], [{ ...canonical, countryCode: 'CO' }], [{ ...canonical, sourceCurrencyCode: 'MXN' }],
    [{ ...canonical, destinationCurrencyCode: 'USDT' }], [{ ...canonical, serviceProvider: 'BANXA' }], [{ ...canonical, paymentMethodType: 'APPLE_PAY' }],
    [{ ...canonical, destinationAmount: 0 }], [{ ...canonical, destinationAmount: -1 }], [{ ...canonical, destinationAmount: '95' }],
    [{ ...canonical, transactionType: 'CRYPTO_SELL' }]]) {
    const db = queuedDatabase([[assignment]]); let calls = 0;
    await expect(createAdministrativeSandboxSession(db.database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment,
      diagnostic: () => {}, fetchImpl: (async target => { calls++; if (String(target).includes('/supported/routes/')) return Response.json([route()]);
        expect(String(target)).toContain('/payments/crypto/quote'); return Response.json({ quotes });
      }) as typeof fetch })).rejects.toThrow('wallet_funding_provider_unavailable');
    expect(calls).toBe(2); expect(db.queries).toHaveLength(1);
  }
  const disabled = queuedDatabase([[assignment]]);
  await expect(createAdministrativeSandboxSession(disabled.database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment,
    diagnostic: () => {}, fetchImpl: (async target => { expect(String(target)).toContain('/supported/routes/'); return Response.json([{ ...route(), checkoutSupported: false }]); }) as typeof fetch,
  })).rejects.toThrow('wallet_funding_method_unavailable');
  expect(disabled.queries).toHaveLength(1);
});

test('sandbox preflight quota, duplicate ids and overlapping operations are bounded separately from financial attempts', async () => {
  let now = 1000; const gate = createAdministrativePreflightGate(() => now, 2);
  const release = gate('alice', 'first');
  expect(() => gate('alice', 'second')).toThrow('wallet_funding_request_pending');
  release(); expect(() => gate('alice', 'first')).toThrow('wallet_funding_request_already_used');
  for (let i = 1; i < 10; i++) gate('alice', String(i))();
  expect(() => gate('alice', 'eleventh')).toThrow('wallet_funding_rate_limited');
  gate('bob', 'first')(); expect(() => gate('charlie', 'first')).toThrow('wallet_funding_rate_limited');
  now += 600001; gate('alice', 'first')(); gate('charlie', 'first')();
  const db = queuedDatabase(Array.from({ length: 12 }, () => [assignment])); let providerCalls = 0;
  const fetchImpl = (async target => { providerCalls++; if (String(target).includes('/supported/routes/')) return Response.json([route()]);
    return Response.json({ code: 'SERVICE_PROVIDER_AUTHENTICATION_EXCEPTION' }, { status: 401 }); }) as typeof fetch;
  for (let i = 0; i < 10; i++) await expect(createAdministrativeSandboxSession(db.database, { ...adminInput, requestId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` },
    { subject: 'owner', clientIp: '192.0.2.1', environment, fetchImpl, diagnostic: () => {} })).rejects.toThrow('wallet_funding_provider_authentication_unavailable');
  expect(providerCalls).toBe(20);
  await expect(createAdministrativeSandboxSession(db.database, { ...adminInput, requestId: '00000000-0000-4000-8000-999999999999' },
    { subject: 'owner', clientIp: '192.0.2.1', environment, fetchImpl })).rejects.toThrow('wallet_funding_rate_limited');
  expect(providerCalls).toBe(20); expect(db.queries.every(q => q.sql.includes('read_administrative_wallet'))).toBe(true);
});

test('administrative MXN history and status keep pesos and sandbox-only unconfirmed receipts under owner-scoped readers', async () => {
  const row = { id, wallet_kind: 'administrative', environment: 'sandbox', provider: 'meld', status: 'session_created', wallet_address: address,
    country_code: 'MX', requested_amount: '93.00', source_currency: 'MXN', payment_method: 'CREDIT_DEBIT_CARD', destination_currency: 'USDT_POLYGON', created_at: createdAt };
  const history = queuedDatabase([[row]]), status = queuedDatabase([[row]]);
  expect((await readWalletFundingHistory(history.database, 'owner', 'administrative')).records[0]).toMatchObject({ requestedAmount: 93, sourceCurrencyCode: 'MXN' });
  expect(await readWalletFundingStatus(status.database, 'owner', 'administrative', id)).toMatchObject({ requestedAmount: 93, sourceCurrencyCode: 'MXN', confirmation: { state: 'unconfirmed', source: 'none', testMode: true } });
  expect(history.queries[0]!.params).toEqual(['owner', 'administrative']); expect(status.queries[0]!.params).toEqual(['owner', 'administrative', id]);
  for (const change of [{ country_code: 'US' }, { payment_method: 'SPEI' }, { source_currency: 'COP' }, { destination_currency: 'USDT' }, { environment: 'production' }]) {
    await expect(readWalletFundingHistory(queuedDatabase([[{ ...row, ...change }]]).database, 'owner', 'administrative')).rejects.toThrow();
  }
});

test('concurrent or cancelled administrative quote preflights never open a second provider operation or consume attempts', async () => {
  const db = queuedDatabase([[assignment], [assignment]]); const controller = new AbortController();
  let quoteStarted = () => {}; const started = new Promise<void>(resolve => { quoteStarted = resolve; }); let providerCalls = 0;
  const fetchImpl = (async target => { providerCalls++; if (String(target).includes('/supported/routes/')) return Response.json([route()]);
    quoteStarted(); return new Promise<Response>(() => {});
  }) as typeof fetch;
  const first = createAdministrativeSandboxSession(db.database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment,
    signal: controller.signal, fetchImpl, diagnostic: () => {} });
  const outcome = first.then(() => null, error => error as Error); await started;
  await expect(createAdministrativeSandboxSession(db.database, { ...adminInput, requestId: '00000000-0000-4000-8000-123456789012' },
    { subject: 'owner', clientIp: '192.0.2.1', environment, fetchImpl })).rejects.toThrow('wallet_funding_request_pending');
  expect(providerCalls).toBe(2); expect(db.queries).toHaveLength(2); controller.abort(); expect((await outcome)?.message).toBe('wallet_funding_provider_unavailable');
  expect(db.queries.every(q => q.sql.includes('read_administrative_wallet'))).toBe(true);
});

test('explicitly disabled sandbox method-level hosted support cannot be quoted or opened', async () => {
  const db = queuedDatabase([[assignment]]); let calls = 0;
  await expect(createAdministrativeSandboxSession(db.database, adminInput, { subject: 'owner', clientIp: '192.0.2.1', environment,
    diagnostic: () => {}, fetchImpl: (async target => { calls++; expect(String(target)).toContain('/supported/routes/');
      return Response.json([{ ...route(), paymentMethods: [{ ...method(), checkoutSupported: false }] }]);
    }) as typeof fetch })).rejects.toThrow('wallet_funding_method_unavailable');
  expect(calls).toBe(1); expect(db.queries).toHaveLength(1);
});
