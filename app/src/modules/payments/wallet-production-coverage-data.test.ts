import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import snapshot from './wallet-production-coverage-data.json';
import { coverageCountries, resolveProductionCoverage } from './wallet-production-coverage';

test('shipped production compatibility catalogue contains only scoped quote-verified precision-safe routes', () => {
  const account = 'synthetic-catalogue-check', key = 'synthetic-catalogue-credential';
  const environment = { MELD_PRODUCTION_ACCOUNT_ID: account, MELD_PRODUCTION_API_KEYS: key,
    MELD_PRODUCTION_CATALOGUE_ATTESTATION: createHash('sha256').update([snapshot.scope, account, key].join('\n')).digest('hex') };
  const coverage = resolveProductionCoverage(environment, snapshot);
  expect(coverage.rows.length).toBeGreaterThan(0);
  expect(coverageCountries(coverage).has('CR')).toBe(false);
  expect(coverage.rows.every(row => row.evidence === 'quote_verified')).toBe(true);
  expect(JSON.stringify(snapshot)).not.toMatch(/walletAddress|customerId|apiKey|attestation|accountId|checkoutUrl/);
});
