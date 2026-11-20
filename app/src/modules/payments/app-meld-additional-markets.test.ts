import { expect, test } from 'bun:test';
import type { IdentityDatabase } from '../identity/model';
import { APP_MELD_ORIGIN, createAppMeldFunding, readAppMeldOptions } from './app-meld-funding';

const cases = [
  ['PE', 'PEN', 'LOCAL_BANK_TRANSFER', 100, 19, 4_500_000, '8', '2'],
  ['AR', 'ARS', 'LOCAL_BANK_TRANSFER', 50_000, 25_000, 6_600_000, '29', '1'],
  ['DE', 'EUR', 'SEPA', 50, 10, 100_000, '12', '2'],
  ['KE', 'KES', 'MPESA', 2_000, 1_850, 700_000, '15', '2'],
  ['VN', 'VND', 'VIETQR', 500_000, 55_000, 450_000_000, '5', '1'],
] as const;

const requestId = '938a35a5-1362-4ac6-80de-800435f00b76';
const customerReference = '013e0687-4389-4f1f-b7a6-79503e76a9c5';
const walletAddress = '0x' + '1'.repeat(40);
const destinationCurrencyCode = 'USDT_POLYGON';
const serviceProvider = 'ONRAMPMONEY';
const environment = { MELD_PRODUCTION_API_KEYS: 'synthetic-only', MELD_PRODUCTION_ACCOUNT_ID: 'synthetic-account' };
const principal = { subject: 'synthetic-owner', nativeSessionId: 'synthetic-session', clientIp: '192.0.2.10', environment };
const locked = ['walletAddress', 'destinationCurrencyCode', 'sourceCurrencyCode', 'sourceAmount', 'paymentMethodType'];

for (const [country, sourceCurrencyCode, paymentMethodType, amount, minimumAmount, maximumAmount, fiatType, paymentMethod] of cases) {
  test('App verifies ' + country + ' price, recipient, network and exact Onramp Money widget rail before exposing checkout', async () => {
    let calls = 0, writes = 0, currentRequestId = requestId;
    const record = { id: requestId, wallet_address: walletAddress, customer_reference: customerReference, created: true,
      status: 'initiated', created_at: new Date('2026-11-20T02:00:00Z') };
    const database = { execute: async () => ++writes === 1 ? [{ ...record, id: currentRequestId }] : [{ finished: true }] } as unknown as Pick<IdentityDatabase, 'execute'>;
    const query = new URLSearchParams({ coinCode: 'usdt', network: 'matic20', walletAddress, fiatAmount: amount.toFixed(2),
      fiatType, paymentMethod, redirectUrl: APP_MELD_ORIGIN + '/dashboard/wallet-personal?walletCheckoutReference=' + requestId });
    const fetchImpl = (async (url, options) => {
      const target = new URL(String(url));
      expect(target.origin).toBe('https://api.meld.io');
      calls++;
      if (target.pathname.startsWith('/network-partner/')) {
        expect(target.pathname).toBe('/network-partner/supported/routes/CRYPTO_ONRAMP/' + country + '/' + sourceCurrencyCode + '/' + destinationCurrencyCode);
        expect(target.searchParams.get('partners')?.split(',')).toContain(serviceProvider);
        return Response.json([
          { partner: serviceProvider, source: sourceCurrencyCode, destination: destinationCurrencyCode,
            paymentMethods: [{ name: paymentMethodType, limits: { currencyCode: sourceCurrencyCode, min: minimumAmount - 1, max: maximumAmount + 1 } },
              { name: 'PIX', limits: { currencyCode: sourceCurrencyCode, min: 1, max: maximumAmount } }] },
          { partner: 'BANXA', source: sourceCurrencyCode, destination: destinationCurrencyCode,
            paymentMethods: [{ name: paymentMethodType, limits: { currencyCode: sourceCurrencyCode, min: 1, max: maximumAmount } }] },
        ]);
      }
      const body = JSON.parse(String(options?.body));
      if (target.pathname === '/payments/crypto/quote') {
        expect(body).toEqual({ countryCode: country, sourceCurrencyCode, sourceAmount: amount, destinationCurrencyCode,
          paymentMethodType, serviceProviders: [serviceProvider], walletAddress, clientIpAddress: principal.clientIp });
        return Response.json({ quotes: [{ countryCode: country, sourceCurrencyCode, sourceAmount: amount, destinationCurrencyCode,
          paymentMethodType, serviceProvider, walletAddress, totalFee: 0, destinationAmount: 10, transactionType: 'CRYPTO_PURCHASE' }] });
      }
      expect(target.pathname).toBe('/crypto/session/widget');
      expect(body).toEqual({ sessionType: 'BUY', externalSessionId: currentRequestId, externalCustomerId: customerReference,
        sessionData: { serviceProvider, walletAddress, countryCode: country, sourceCurrencyCode, sourceAmount: amount.toFixed(sourceCurrencyCode === 'VND' ? 0 : 2),
          destinationCurrencyCode, paymentMethodType, clientIpAddress: principal.clientIp,
          redirectUrl: query.get('redirectUrl'), lockFields: locked } });
      return Response.json({ id: 'session-a', customerId: 'customer-a', externalSessionId: currentRequestId, externalCustomerId: customerReference,
        serviceProvider, serviceProviderWidgetUrl: 'https://onramp.money/main/buy/?' + query, widgetUrl: 'https://meldcrypto.com/?token=synthetic' });
    }) as typeof fetch;

    const options = await readAppMeldOptions(country, sourceCurrencyCode, { environment, fetchImpl });
    expect(options.routes.find(route => route.serviceProvider === serviceProvider)).toMatchObject({
      destinationCurrencyCode, paymentMethods: [{ method: paymentMethodType, currencyCode: sourceCurrencyCode, minimumAmount, maximumAmount }] });
    const input = { requestId, walletAddress, country, sourceCurrencyCode, amount, paymentMethodType, serviceProvider, destinationCurrencyCode };
    expect(await createAppMeldFunding(database, input, { ...principal, fetchImpl }))
      .toMatchObject({ checkoutUrl: 'https://meldcrypto.com/?token=synthetic', destination: { address: walletAddress, asset: 'USDT', chainId: 137 } });
    expect([calls, writes]).toEqual([4, 2]);

    query.set('paymentMethod', paymentMethod === '1' ? '2' : '1');
    currentRequestId = 'ec812dc5-6485-4cb9-b8ef-7e1ff54cb039';
    query.set('redirectUrl', APP_MELD_ORIGIN + '/dashboard/wallet-personal?walletCheckoutReference=' + currentRequestId);
    writes = 0;
    await expect(createAppMeldFunding(database, { ...input, requestId: currentRequestId }, { ...principal, fetchImpl })).rejects.toThrow('wallet_funding_provider_unavailable');
    expect([calls, writes]).toEqual([7, 2]);
  });
}

test('invalid added countries and fractional VND never reach the database or MELD', async () => {
  const never = () => { throw Error('unexpected live call'); };
  const database = { execute: never } as Pick<IdentityDatabase, 'execute'>;
  const fetchImpl = never as unknown as typeof fetch;
  const input = { requestId, walletAddress, country: 'VN', sourceCurrencyCode: 'VND', amount: 500_000.01, paymentMethodType: 'VIETQR' };
  await expect(createAppMeldFunding(database, input, { ...principal, fetchImpl })).rejects.toThrow('wallet_funding_amount_unavailable');
  await expect(createAppMeldFunding(database, { ...input, country: 'CR' }, { ...principal, fetchImpl }))
    .rejects.toThrow('wallet_funding_method_unavailable');
});
