import { createHash } from 'node:crypto';

// Synthetic test policy only. Never imported by the production server.
export const syntheticCoverage = {
  schemaVersion: 1, scope: 'wallet-prod-20261119-v1', environment: 'production', asset: 'USDT_POLYGON', chainId: 137,
  verifiedAt: '2026-01-01T00:00:00.000Z',
  rows: [
    ['MX', 'MXN', 'BANXA', 'CREDIT_DEBIT_CARD', 2],
    ['MX', 'MXN', 'ONRAMPMONEY', 'CREDIT_DEBIT_CARD', 2],
    ['MX', 'MXN', 'ONRAMPMONEY', 'SPEI', 2],
    ['CO', 'COP', 'ONRAMPMONEY', 'PSE', 2],
    ['ES', 'EUR', 'BANXA', 'SEPA', 2],
    ['JP', 'JPY', 'BANXA', 'LOCAL_BANK_TRANSFER', 0],
  ].map(([country, sourceCurrencyCode, serviceProvider, paymentMethodType, minorUnits]) => ({
    country, sourceCurrencyCode, serviceProvider, paymentMethodType, minorUnits,
    minimumAmount: minorUnits === 0 ? 1 : 0.01, maximumAmount: 1_000_000_000, verifiedAmount: 2000,
    verifiedAt: '2026-01-01T00:00:00.000Z', evidence: 'quote_verified',
  })),
};
export function coverageTestEnvironment(environment: Record<string, string | undefined>, catalogue: unknown = syntheticCoverage) {
  const scope = (catalogue as { scope: string }).scope;
  return { ...environment, MELD_PRODUCTION_CATALOGUE_ATTESTATION: createHash('sha256')
    .update([scope, environment.MELD_PRODUCTION_ACCOUNT_ID, environment.MELD_PRODUCTION_API_KEYS].join('\n')).digest('hex') };
}
