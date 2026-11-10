import { describe, expect, test } from 'bun:test';
import { createMeldOnrampQuote, readMeldOnrampAvailability } from './meld-onramp';

const environment = { MELD_API_SANDBOX: 'synthetic-sandbox-key' };
const request = { country: 'CO', fiat: 'USD', crypto: 'USDT_POLYGON' } as const;

function discoveryFetch(quote?: (init?: RequestInit) => Response) {
  const seen: string[] = [];
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('/supported/countries?')) {
      return Response.json({ countries: [{ countryCode: 'CO', name: 'Colombia' }] });
    }
    if (url.includes('/supported/routes/')) {
      return Response.json([
        { partner: 'BANXA', paymentMethods: [
          { paymentType: 'CARD', name: 'CREDIT_DEBIT_CARD', limits: { currencyCode: 'USD', min: 20, max: 15000 } },
          { paymentType: 'MOBILE_WALLET', name: 'APPLE_PAY', limits: { min: 20, max: 500 } },
        ] },
        { partner: 'BINANCECONNECT', paymentMethods: [
          { paymentType: 'CARD', name: 'CREDIT_DEBIT_CARD', limits: { min: 1, max: 25000 } },
        ] },
      ]);
    }
    if (url.includes('/payments/crypto/quote') && quote) return quote(init);
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe('Meld onramp preflight', () => {
  test('validates country and array routes, projects methods and hides partners', async () => {
    const { fetchImpl, seen } = discoveryFetch();
    const result = await readMeldOnrampAvailability(request, { environment, fetchImpl });
    expect(seen.some(url => url.includes('category=CRYPTO_ONRAMP') && url.includes('cryptoCurrency=USDT_POLYGON'))).toBe(true);
    expect(seen).toContain('https://api-sb.meld.io/network-partner/supported/routes/CRYPTO_ONRAMP/CO/USD/USDT_POLYGON');
    expect(result).toEqual({ available: true, country: 'CO', fiat: 'USD', crypto: 'USDT_POLYGON', asset: 'USDT',
      network: 'POLYGON', paymentMethods: [
        { code: 'CREDIT_DEBIT_CARD', type: 'CARD', minimum: 20, maximum: 15000 },
        { code: 'APPLE_PAY', type: 'MOBILE_WALLET', minimum: 20, maximum: 500 },
      ] });
    expect(result).not.toHaveProperty('providers');
  });

  test('quotes only route providers, excludes Binance and ranks verified methods', async () => {
    let sent: Record<string, unknown> = {};
    const { fetchImpl } = discoveryFetch(init => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ quotes: [
        { serviceProvider: 'BANXA', paymentMethodType: 'VISA', sourceAmount: 50, destinationAmount: 47,
          totalFee: 3, transactionFee: 2, networkFee: 1, partnerFee: 0, destinationCurrencyCode: 'USDT_POLYGON',
          rampIntelligence: { rampScore: 70 } },
        { serviceProvider: 'BANXA', paymentMethodType: 'APPLE_PAY', sourceAmount: 50, destinationAmount: 48,
          totalFee: 2, transactionFee: 2, networkFee: 0, partnerFee: 0, destinationCurrencyCode: 'USDT_POLYGON',
          rampIntelligence: { rampScore: 90 } },
      ] });
    });
    const result = await createMeldOnrampQuote({ ...request, amount: 50 }, { environment, fetchImpl });
    expect(sent.serviceProviders).toEqual(['BANXA']);
    expect(sent).not.toHaveProperty('paymentMethodType');
    expect(sent.destinationCurrencyCode).toBe('USDT_POLYGON');
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.quote.serviceProvider).toBe('BANXA');
      expect(result.quote.paymentMethodType).toBe('APPLE_PAY');
      expect(result.quotes.map(item => item.paymentMethodType)).toEqual(['APPLE_PAY', 'CREDIT_DEBIT_CARD']);
    }
  });

  test('turns provider quote failures into a safe unavailable state', async () => {
    const { fetchImpl } = discoveryFetch(() => Response.json({ code: 'TRANSACTION_FAILED_GETTING_CRYPTO_QUOTE_FROM_PROVIDER' }, { status: 422 }));
    expect(await createMeldOnrampQuote({ ...request, amount: 50 }, { environment, fetchImpl }))
      .toEqual({ available: false, reason: 'no_valid_quotes' });
  });
});
