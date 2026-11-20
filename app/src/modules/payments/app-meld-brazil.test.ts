import { expect, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { IdentityDatabase } from '../identity/model';
import { createAppMeldFunding, readAppMeldOptions } from './app-meld-funding';

const environment = { MELD_PRODUCTION_API_KEYS: 'test-key', MELD_PRODUCTION_ACCOUNT_ID: 'test-account' };
const walletAddress = '0x' + '7'.repeat(40);
const requestId = '6d492c47-80be-4e14-bc5f-54afaa56fc23';
const customerReference = 'fa8a2909-60ff-4988-bd5e-88435701c75f';
const sessionId = 'merchant-session';
const asset = 'USDC_ARBITRUM';

function routes() {
  return [
    { partner: 'ALCHEMYPAY', source: 'BRL', destination: asset, paymentMethods: [
      { name: 'PIX', limits: { currencyCode: 'BRL', min: 50, max: 20_000 } },
      { name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'BRL', min: 50, max: 20_000 } },
    ] },
    { partner: 'MERCURYO', source: 'BRL', destination: asset, paymentMethods: [
      { name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'BRL', min: 155.65, max: 93_387.41 } },
      { name: 'PIX', limits: { currencyCode: 'BRL', min: 50, max: 20_000 } },
    ] },
    { partner: 'ONRAMPMONEY', source: 'BRL', destination: asset, paymentMethods: [
      { name: 'PIX', limits: { currencyCode: 'BRL', min: 50, max: 20_000 } },
    ] },
  ];
}

test('App Brazil exposes exact approved Arbitrum methods, currencies and limits', async () => {
  const fetchImpl = (async target => {
    const url = new URL(String(target));
    expect(url.pathname).toBe('/network-partner/supported/routes/CRYPTO_ONRAMP/BR/BRL/USDC_ARBITRUM');
    expect(url.searchParams.get('partners')).toBe('ALCHEMYPAY,MERCURYO');
    return Response.json(routes());
  }) as typeof fetch;
  expect(await readAppMeldOptions('BR', 'BRL', { environment, fetchImpl })).toMatchObject({
    destinationCurrencyCode: asset, network: 'arbitrum', chainId: 42161,
    paymentMethods: ['PIX', 'CREDIT_DEBIT_CARD'],
    routes: [
      { serviceProvider: 'ALCHEMYPAY', paymentMethods: [{ method: 'PIX', currencyCode: 'BRL', minimumAmount: 50, maximumAmount: 20_000 }] },
      { serviceProvider: 'MERCURYO', paymentMethods: [{ method: 'CREDIT_DEBIT_CARD', currencyCode: 'BRL', minimumAmount: 155.65, maximumAmount: 93_387.41 }] },
    ],
  });
});

type Provider = 'ALCHEMYPAY' | 'MERCURYO';
type Patch = [string, string];

function checkout(provider: Provider, patch?: Patch) {
  const method = provider === 'ALCHEMYPAY' ? 'PIX' : 'CREDIT_DEBIT_CARD';
  const calls: string[] = [];
  const query = new PgDialect();
  const database = { execute: async (operation: SQL) => {
    const value = query.sqlToQuery(operation);
    if (value.sql.includes('reserve_app_meld_funding')) {
      calls.push('reserve');
      expect(value.params).toEqual(['owner', 'native-session', requestId, walletAddress, 'BR', 'BRL', 500,
        method, provider, environment.MELD_PRODUCTION_ACCOUNT_ID, asset]);
      return [{ id: requestId, wallet_address: walletAddress, customer_reference: customerReference,
        created: true, status: 'initiated', created_at: new Date('2026-11-20T13:00:00.000Z') }];
    }
    calls.push(patch ? 'unavailable' : 'session-created');
    expect(value.params).toEqual(['owner', 'native-session', requestId,
      patch ? 'unavailable' : 'session_created', patch ? null : sessionId, patch ? null : 'merchant-customer']);
    return [{ finished: true }];
  } } as unknown as Pick<IdentityDatabase, 'execute'>;
  const fetchImpl = (async (target, init) => {
    const url = new URL(String(target));
    if (url.pathname.includes('/routes/')) {
      calls.push('routes');
      return Response.json(routes());
    }
    const payload = JSON.parse(String(init?.body));
    if (url.pathname.endsWith('/quote')) {
      calls.push('quote');
      expect(payload).toMatchObject({ countryCode: 'BR', sourceCurrencyCode: 'BRL', sourceAmount: 500,
        serviceProviders: [provider], paymentMethodType: method, destinationCurrencyCode: asset, walletAddress });
      return Response.json({ quotes: [{ serviceProvider: provider, countryCode: 'BR', sourceCurrencyCode: 'BRL',
        sourceAmount: 500, destinationAmount: 77.66, totalFee: 13.25, paymentMethodType: method,
        destinationCurrencyCode: asset, transactionType: 'CRYPTO_PURCHASE' }] });
    }
    calls.push('widget');
    expect(payload.sessionData).toMatchObject({ countryCode: 'BR', sourceCurrencyCode: 'BRL',
      sourceAmount: '500.00', walletAddress, destinationCurrencyCode: asset, paymentMethodType: method,
      lockFields: expect.arrayContaining(['walletAddress', 'destinationCurrencyCode', 'paymentMethodType']) });
    const params = new URLSearchParams(provider === 'ALCHEMYPAY'
      ? { address: walletAddress, country: 'BR', fiat: 'BRL', fiatAmount: '500.00', crypto: 'USDC', network: 'ARBITRUM',
        redirectUrl: payload.sessionData.redirectUrl, showTable: 'buy', merchantOrderNo: sessionId, appId: 'app-id',
        callbackUrl: 'https://api.meld.io/webhooks/alchemypay/merchant-callback', timestamp: '1790000000000', sign: 'a'.repeat(43) + '=' }
      : { widget_id: customerReference, type: 'buy', currency: 'USDC', network: 'ARBITRUM', fix_currency: 'true',
        country_code: 'BR', fiat_currency: 'BRL', fiat_amount: '500.00', fix_fiat_currency: 'true', fix_fiat_amount: 'true',
        payment_method: 'card', address: walletAddress, redirect_url: payload.sessionData.redirectUrl,
        merchant_transaction_id: sessionId, signature: 'v2:' + 'a'.repeat(128) });
    if (patch) params.set(...patch);
    const host = provider === 'ALCHEMYPAY' ? 'ramp.alchemypay.org' : 'exchange.mercuryo.io';
    return Response.json({ id: sessionId, customerId: 'merchant-customer', externalSessionId: requestId,
      externalCustomerId: customerReference, serviceProvider: provider, widgetUrl: 'https://meldcrypto.com/?token=fixture',
      serviceProviderWidgetUrl: 'https://' + host + '/?' + params.toString() });
  }) as typeof fetch;
  const result = createAppMeldFunding(database, { requestId, country: 'BR', sourceCurrencyCode: 'BRL', amount: 500,
    paymentMethodType: method, destinationCurrencyCode: asset, serviceProvider: provider, walletAddress },
  { subject: 'owner', nativeSessionId: 'native-session', clientIp: '203.0.113.10', environment, fetchImpl });
  return { result, calls };
}

test('App Brazil reserves the linked address and validates both exact production checkout contracts', async () => {
  for (const provider of ['ALCHEMYPAY', 'MERCURYO'] as const) {
    const { result, calls } = checkout(provider);
    expect(await result).toMatchObject({ destinationCurrencyCode: 'USDC_ARBITRUM',
      destination: { address: walletAddress, asset: 'USDC', network: 'arbitrum', chainId: 42161 },
      serviceProvider: provider, checkoutUrl: 'https://meldcrypto.com/?token=fixture' });
    expect(calls).toEqual(['routes', 'reserve', 'quote', 'widget', 'session-created']);
  }
});

test('App Brazil rejects a changed method, wallet, network, amount, return URL or issuer callback', async () => {
  const alternatives: [Provider, Patch][] = [
    ['ALCHEMYPAY', ['network', 'POLYGON']], ['ALCHEMYPAY', ['address', '0x' + '1'.repeat(40)]],
    ['ALCHEMYPAY', ['fiatAmount', '501.00']], ['ALCHEMYPAY', ['payWayCode', '10001']],
    ['ALCHEMYPAY', ['redirectUrl', 'https://example.test/']], ['ALCHEMYPAY', ['callbackUrl', 'https://example.test/']],
    ['MERCURYO', ['payment_method', 'PIX']], ['MERCURYO', ['signature', 'a'.repeat(128)]],
  ];
  for (const [provider, patch] of alternatives) {
    const { result, calls } = checkout(provider, patch);
    await expect(result).rejects.toThrow('wallet_funding_provider_unavailable');
    expect(calls).toEqual(['routes', 'reserve', 'quote', 'widget', 'unavailable']);
  }
});

