import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import snapshot from './wallet-production-coverage-data.json';
import { coverageAsset, coverageCountries, coverageCurrencies, coverageMethodsByProvider, resolveProductionCoverage } from './wallet-production-coverage';

test('shipped production compatibility catalogue contains only scoped quote-verified precision-safe routes', () => {
  const account = 'synthetic-catalogue-check', key = 'synthetic-catalogue-credential';
  const environment = { MELD_PRODUCTION_ACCOUNT_ID: account, MELD_PRODUCTION_API_KEYS: key,
    MELD_PRODUCTION_CATALOGUE_ATTESTATION: createHash('sha256').update([snapshot.scope, account, key].join('\n')).digest('hex') };
  const coverage = resolveProductionCoverage(environment, snapshot);
  expect(coverage.rows.length).toBeGreaterThan(0);
  expect(coverageCountries(coverage).has('CR')).toBe(false);
  expect([...coverageCurrencies(coverage, 'MX')]).toEqual(['MXN', 'USD']);
  expect(coverageMethodsByProvider(coverage, 'MX', 'MXN')).toEqual(new Map([
    ['ONRAMPMONEY', new Set(['SPEI'])], ['MERCURYO', new Set(['CREDIT_DEBIT_CARD'])],
  ]));
  expect(coverageMethodsByProvider(coverage, 'MX', 'EUR').size).toBe(0);
  expect([...coverageCurrencies(coverage, 'BR')]).toEqual(['BRL']);
  expect(coverageAsset(coverage, 'BR', 'BRL')).toBe('USDC_ARBITRUM');
  expect(coverageMethodsByProvider(coverage, 'BR', 'BRL')).toEqual(new Map([
    ['ALCHEMYPAY', new Set(['PIX'])], ['MERCURYO', new Set(['CREDIT_DEBIT_CARD'])],
  ]));
  expect(coverageMethodsByProvider(coverage, 'BR', 'BRL', 'USDC_POLYGON').size).toBe(0);
  const usCards = ['CREDIT_DEBIT_CARD', 'APPLE_PAY', 'GOOGLE_PAY'];
  expect(coverageAsset(coverage, 'US', 'USD')).toBe('USDC_POLYGON');
  expect(coverageMethodsByProvider(coverage, 'US', 'USD')).toEqual(new Map([
    ['ONRAMPMONEY', new Set(['ACH', 'LOCAL_BANK_TRANSFER'])], ['MERCURYO', new Set(usCards)],
  ]));
  for (const asset of ['USDC_ARBITRUM', 'USDC'] as const) {
    expect(coverageMethodsByProvider(coverage, 'US', 'USD', asset)).toEqual(new Map([['MERCURYO', new Set(usCards)]]));
  }
  expect(coverage.rows.some(row => row.serviceProvider === 'RAMPNOW')).toBe(false);
  expect(coverage.rows.every(row => row.evidence === 'quote_verified')).toBe(true);
  expect(JSON.stringify(snapshot)).not.toMatch(/walletAddress|customerId|apiKey|attestation|accountId|checkoutUrl/);
});
