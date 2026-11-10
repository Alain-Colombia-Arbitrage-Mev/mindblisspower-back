import { expect, test } from 'bun:test';
import { createMeldOnrampAttempt } from './meld-onramp-attempt';

test('captures an authoritative backend quote and returns the 1% commission estimate', async () => {
  const fetchImpl = (async (input) => {
    const url = String(input);
    if (url.includes('/supported/countries?')) return Response.json({ countries: [{ countryCode: 'CO' }] });
    if (url.includes('/supported/routes/')) return Response.json([{ partner: 'BANXA', paymentMethods: [
      { paymentType: 'CARD', name: 'CREDIT_DEBIT_CARD', limits: { min: 20, max: 15000 } },
    ] }]);
    if (url.includes('/payments/crypto/quote')) return Response.json({ quotes: [{
      serviceProvider: 'BANXA', paymentMethodType: 'VISA', sourceAmount: 100, destinationAmount: 96,
      totalFee: 4, transactionFee: 3, networkFee: 1, partnerFee: 0, destinationCurrencyCode: 'USDT_POLYGON',
      rampIntelligence: { rampScore: 80 },
    }] });
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
  const database = { execute: async () => [{ id: 'd8a4c010-cc33-44da-a297-8b3c6440f491', mindbliss_fee_usd: '1.00' }] };
  const result = await createMeldOnrampAttempt(database as never, {
    walletKind: 'personal', walletAddress: `0x${'1'.repeat(40)}`, country: 'CO', fiat: 'USD', crypto: 'USDT_POLYGON',
    amount: 100, paymentMethodType: 'CREDIT_DEBIT_CARD', serviceProvider: 'BANXA',
  }, { subject: 'synthetic-user', environment: { MELD_API_SANDBOX: 'synthetic-key' }, fetchImpl });
  expect(result.checkoutReference).toBe('d8a4c010-cc33-44da-a297-8b3c6440f491');
  expect(result.quote.serviceProvider).toBe('BANXA');
  expect(result.commission).toEqual({ ratePercent: 1, estimatedUsd: 1, status: 'estimated' });
});
