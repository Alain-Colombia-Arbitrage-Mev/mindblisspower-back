import { expect, test } from 'bun:test';
import type { IdentityDatabase } from '../identity/model';
import walletCoverage from './app-meld-wallet-coverage.json';
import { createAppMeldFunding, readAppMeldOptions } from './app-meld-funding';

const environment = { MELD_PRODUCTION_API_KEYS: 'fixture-only', MELD_PRODUCTION_ACCOUNT_ID: 'fixture-account' };
const networks: Record<string, { network: string; chainId: number }> = {
  USDT_POLYGON: { network: 'polygon', chainId: 137 },
  USDC_POLYGON: { network: 'polygon', chainId: 137 },
  USDC_ARBITRUM: { network: 'arbitrum', chainId: 42161 },
  USDC: { network: 'ethereum', chainId: 1 },
};

test('App exposes every Wallet catalog rail on its exact network with independent fiat bounds', async () => {
  const pairs = new Set(walletCoverage.rows.map(row => row.country + ':' + row.sourceCurrencyCode));
  const calls = new Set<string>();
  const fetchImpl = (async (target, init) => {
    const url = new URL(String(target));
    expect(url.origin).toBe('https://api.meld.io');
    expect(new Headers(init?.headers).get('Meld-Account-Id')).toBe('fixture-account');
    const [country, fiat, asset] = url.pathname.split('/').slice(-3);
    const rows = walletCoverage.rows.filter(row => row.country === country && row.sourceCurrencyCode === fiat
      && (row.destinationCurrencyCode ?? walletCoverage.asset) === asset);
    const providers = [...new Set(rows.map(row => row.serviceProvider))];
    expect(url.searchParams.get('partners')).toBe(providers.join(','));
    expect(url.searchParams.get('checkout')).toBe('true');
    calls.add([country, fiat, asset].join(':'));
    return Response.json(providers.map(partner => ({ partner, source: fiat, destination: asset,
      paymentMethods: [...rows.filter(row => row.serviceProvider === partner).map(row => ({
        name: row.paymentMethodType, limits: { currencyCode: fiat, min: 0, max: 1_000_000_000 },
      })), { name: 'NETELLER', limits: { currencyCode: fiat, min: 0, max: 1_000_000_000 } }],
    })));
  }) as typeof fetch;
  let count = 0;
  for (const key of pairs) {
    const [country, fiat] = key.split(':') as [string, string];
    const options = await readAppMeldOptions(country, fiat, { environment, fetchImpl });
    const expected = walletCoverage.rows.filter(row => row.country === country && row.sourceCurrencyCode === fiat);
    expect<number>(options.minorUnits).toBe(expected[0]!.minorUnits);
    expect<string>(options.destinationCurrencyCode).toBe(expected[0]!.destinationCurrencyCode ?? walletCoverage.asset);
    const actual = options.routes.flatMap(route => route.paymentMethods.map(method => ({
      provider: route.serviceProvider, asset: route.destinationCurrencyCode, method: method.method, currency: method.currencyCode,
      minimum: method.minimumAmount, maximum: method.maximumAmount, network: route.network, chainId: route.chainId,
    })));
    expect(actual).toHaveLength(expected.length);
    for (const row of expected) {
      const asset = row.destinationCurrencyCode ?? walletCoverage.asset;
      const scale = 10 ** row.minorUnits;
      const minimum = Math.ceil(Math.max(row.minimumAmount, fiat === 'USD' ? 50 : 1 / scale) * scale - 0.000001) / scale;
      const maximum = Math.floor(Math.min(row.maximumAmount, fiat === 'USD' ? 25_000 : 1_000_000_000) * scale + 0.000001) / scale;
      expect<unknown[]>(actual).toContainEqual({ provider: row.serviceProvider, asset, method: row.paymentMethodType, currency: fiat, minimum, maximum,
        ...networks[asset] });
    }
    count += actual.length;
  }
  expect(pairs.size).toBe(74);
  expect(count).toBe(149);
  expect(walletCoverage.rows.filter(row => row.serviceProvider === 'RAMPNOW')
    .map(row => [row.country, row.sourceCurrencyCode, row.paymentMethodType, row.destinationCurrencyCode]))
    .toEqual([['DE', 'EUR', 'SEPA', 'USDC_POLYGON']]);
  expect(calls.size).toBe(81);
});

test('local checkout keeps the exact bank rail, wallet and fiat precision through the provider handoff', async () => {
  const requestId = '6d492c47-80be-4e14-bc5f-54afaa56fc23';
  const customer = 'aa0ecbcc-54d8-4a6e-a0ac-4a662ac8ed44';
  const walletAddress = '0x' + '3'.repeat(40);
  const sessionId = 'provider-session';
  for (const row of walletCoverage.rows.slice(-6)) {
    const { country, sourceCurrencyCode: fiat, destinationCurrencyCode: asset, paymentMethodType: method,
      serviceProvider: provider, verifiedAmount: amount, minorUnits, minimumAmount, maximumAmount } = row;
    const database = { execute: async () => [{ id: requestId, wallet_address: walletAddress, customer_reference: customer,
      created: true, status: 'initiated', created_at: new Date(), finished: true }] } as unknown as Pick<IdentityDatabase, 'execute'>;
    const fetchImpl = (async (target, init) => {
      const path = new URL(String(target)).pathname;
      if (path.includes('/supported/routes/')) return Response.json([{ partner: provider, source: fiat, destination: asset,
        paymentMethods: [{ name: method, limits: { currencyCode: fiat, min: minimumAmount, max: maximumAmount } }] }]);
      const body = JSON.parse(String(init?.body));
      const selection = { countryCode: country, sourceCurrencyCode: fiat, destinationCurrencyCode: asset, walletAddress, paymentMethodType: method };
      if (path === '/payments/crypto/quote') {
        expect(body).toMatchObject({ ...selection, sourceAmount: amount, serviceProviders: [provider] });
        return Response.json({ quotes: [{ ...selection, sourceAmount: amount, serviceProvider: provider,
          transactionType: 'CRYPTO_PURCHASE', totalFee: 1, destinationAmount: 50 }] });
      }
      const amountText = amount.toFixed(minorUnits);
      expect(body.sessionData).toMatchObject({ ...selection, serviceProvider: provider, sourceAmount: amountText,
        lockFields: expect.arrayContaining(['walletAddress', 'sourceCurrencyCode', 'sourceAmount', 'destinationCurrencyCode', 'paymentMethodType']) });
      const redirectUrl = body.sessionData.redirectUrl;
      const widgetUrl = 'https://meldcrypto.com/?token=fixture';
      const banxa = 'https://meldshared.banxa.com/papi/transit/?initId=fixture';
      const rampNow = new URL('https://app.rampnow.io/order/quote');
      rampNow.search = new URLSearchParams({ orderType: 'buy', srcCurrency: fiat, srcChain: 'fiat', dstCurrency: 'USDC', dstChain: 'polygon',
        srcAmount: amountText, walletAddress, lockFields: 'walletAddress', paymentMode: 'sepa', prefill: 'true',
        externalOrderId: sessionId, returnUrl: redirectUrl }).toString();
      const alchemy = new URL('https://ramp.alchemypay.org/');
      alchemy.search = new URLSearchParams({ address: walletAddress, country, fiat, fiatAmount: amountText, crypto: 'USDC', network: 'ARBITRUM',
        redirectUrl, showTable: 'buy', merchantOrderNo: sessionId, appId: 'fixture', timestamp: '1795616000000', sign: 'a'.repeat(43) + '=',
        callbackUrl: 'https://api.meld.io/webhooks/alchemypay/fixture' }).toString();
      return Response.json({ id: sessionId, customerId: 'provider-customer', externalSessionId: requestId,
        externalCustomerId: customer, serviceProvider: provider, widgetUrl,
        serviceProviderWidgetUrl: { BANXA: banxa, RAMPNOW: rampNow.href, ALCHEMYPAY: alchemy.href }[provider] });
    }) as typeof fetch;
    await expect(createAppMeldFunding(database, { requestId, country, sourceCurrencyCode: fiat, amount,
      paymentMethodType: method, destinationCurrencyCode: asset, serviceProvider: provider, walletAddress },
    { subject: 'member', nativeSessionId: 'fixture-session', clientIp: '192.0.2.1', environment, fetchImpl })).resolves.toMatchObject({
      serviceProvider: provider, paymentMethodType: method, sourceCurrencyCode: fiat, requestedAmount: amount,
      destinationCurrencyCode: asset, destination: { address: walletAddress }, status: 'session_created',
    });
  }
});

test('App accepts only an issuer-bound Banxa transit or an opaque Meld session for the linked wallet', async () => {
  const id = '6d492c47-80be-4e14-bc5f-54afaa56fc23';
  const customer = 'aa0ecbcc-54d8-4a6e-a0ac-4a662ac8ed44';
  const walletAddress = `0x${'a'.repeat(40)}`;
  const input = { requestId: id, country: 'DE', sourceCurrencyCode: 'EUR', amount: 100,
    paymentMethodType: 'SEPA', serviceProvider: 'BANXA', destinationCurrencyCode: 'USDT_POLYGON', walletAddress };
  const trusted = 'https://meldshared.banxa.com/papi/transit/?initId=opaque%2Freference%3D';
  for (const [serviceProviderWidgetUrl, widgetUrl, expectedUrl] of [
    [trusted, 'https://meldcrypto.com/?token=opaque', trusted],
    [trusted + '&redirect=https://invalid.test/', 'https://meldcrypto.com/?token=opaque', 'https://meldcrypto.com/?token=opaque'],
    [trusted + '&initId=duplicate', null, null],
    [trusted.replace('meldshared.banxa.com', 'payments.invalid.test'), null, null],
  ] as const) {
    let calls = 0;
    const database = { execute: async () => ++calls === 1 ? [{ id, wallet_address: walletAddress,
      customer_reference: customer, created: true, status: 'initiated', created_at: new Date() }] : [{ finished: true }]
    } as unknown as Pick<IdentityDatabase, 'execute'>;
    const fetchImpl = (async (target, init) => {
      const url = new URL(String(target));
      if (url.pathname.startsWith('/network-partner/')) return Response.json([{ partner: 'BANXA', source: 'EUR', destination: 'USDT_POLYGON',
        paymentMethods: [{ name: 'SEPA', limits: { currencyCode: 'EUR', min: 10, max: 30_000 } }] }]);
      const body = JSON.parse(String(init?.body));
      if (url.pathname === '/payments/crypto/quote') {
        expect(body).toMatchObject({ countryCode: 'DE', sourceCurrencyCode: 'EUR', sourceAmount: 100,
          paymentMethodType: 'SEPA', destinationCurrencyCode: 'USDT_POLYGON', walletAddress, serviceProviders: ['BANXA'] });
        return Response.json({ quotes: [{ serviceProvider: 'BANXA', sourceCurrencyCode: 'EUR', sourceAmount: 100,
          paymentMethodType: 'SEPA', destinationCurrencyCode: 'USDT_POLYGON', destinationAmount: 99, totalFee: 1,
          transactionType: 'CRYPTO_PURCHASE', countryCode: 'DE', walletAddress }] });
      }
      expect(url.pathname).toBe('/crypto/session/widget');
      expect(body).toMatchObject({ externalSessionId: id, externalCustomerId: customer, sessionData: { walletAddress,
        lockFields: ['walletAddress', 'destinationCurrencyCode', 'sourceCurrencyCode', 'sourceAmount', 'paymentMethodType'] } });
      return Response.json({ id: 'provider-session', customerId: 'provider-user', externalSessionId: id, externalCustomerId: customer,
        serviceProvider: 'BANXA', serviceProviderWidgetUrl, widgetUrl });
    }) as typeof fetch;
    const result = createAppMeldFunding(database, input, { subject: 'member', nativeSessionId: 'fixture-session',
      clientIp: '192.0.2.1', environment, fetchImpl });
    if (expectedUrl) await expect(result).resolves.toMatchObject({ checkoutUrl: expectedUrl, status: 'session_created' });
    else await expect(result).rejects.toThrow('wallet_funding_provider_unavailable');
    expect(calls).toBe(2);
  }
});
