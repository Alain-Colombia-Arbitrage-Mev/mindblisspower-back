import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { assertProductionCoverageSelection, coverageCountries, coverageCurrencies, coverageMinorUnits,
  intersectProductionCoverage, resolveProductionCoverage, type CoverageCatalogue, type CoverageRow } from './wallet-production-coverage';

const now = Date.parse('2026-11-19T20:00:00Z'), verifiedAt = '2026-11-19T17:00:00.000Z';
const environment = { MELD_PRODUCTION_API_KEYS: 'synthetic-key', MELD_PRODUCTION_ACCOUNT_ID: 'synthetic-account',
  MELD_PRODUCTION_CATALOGUE_ATTESTATION: createHash('sha256').update('wallet-prod-20261119-v1\nsynthetic-account\nsynthetic-key').digest('hex') };
const row: CoverageRow = { country: 'MX', sourceCurrencyCode: 'MXN', serviceProvider: 'ONRAMPMONEY', paymentMethodType: 'SPEI',
  minorUnits: 2, minimumAmount: 200, maximumAmount: 500000, verifiedAmount: 200, verifiedAt, evidence: 'quote_verified' };
function raw(rows: CoverageRow[] = [{ ...row }]): CoverageCatalogue { return { schemaVersion: 1, scope: 'wallet-prod-20261119-v1',
  environment: 'production', asset: 'USDT_POLYGON', chainId: 137, verifiedAt, rows }; }
const resolve = (value: unknown = raw()) => resolveProductionCoverage(environment, value, { now });
const selection = { country: 'MX', sourceCurrencyCode: 'MXN', paymentMethodType: 'SPEI', amount: 200 };
function live(provider = 'ONRAMPMONEY', minimum = 200, maximum = 500000, method = 'SPEI', fiat = 'MXN') {
  return { serviceProvider: provider, paymentMethods: [{ method, currencyCode: fiat, minimumAmount: minimum, maximumAmount: maximum }] };
}

test('catalogue attestation binds exact production account and credential generation, without exposing either', () => {
  const catalogue = resolve(); expect(catalogue).toEqual(raw());
  expect(Object.isFrozen(catalogue)).toBe(true); expect(Object.isFrozen(catalogue.rows)).toBe(true); expect(Object.isFrozen(catalogue.rows[0])).toBe(true);
  for (const changes of [{ MELD_PRODUCTION_API_KEYS: 'rotated-key' }, { MELD_PRODUCTION_ACCOUNT_ID: 'other-account' },
    { MELD_PRODUCTION_CATALOGUE_ATTESTATION: undefined }, { MELD_PRODUCTION_CATALOGUE_ATTESTATION: '0'.repeat(64) },
    { MELD_PRODUCTION_CATALOGUE_ATTESTATION: 'not-hex' }, { MELD_PRODUCTION_API_KEYS: 'contains space' }, { MELD_PRODUCTION_ACCOUNT_ID: '../other' }]) {
    expect(() => resolveProductionCoverage({ ...environment, ...changes }, raw(), { now })).toThrow('wallet_production_unconfigured');
  }
  expect(JSON.stringify(catalogue)).not.toContain('synthetic-key'); expect(JSON.stringify(catalogue)).not.toContain('synthetic-account');
});
test('strict catalogue schema rejects unknown scope, network, environment, malformed facts and future dates', () => {
  for (const patch of [{ schemaVersion: 2 }, { scope: 'other' }, { environment: 'sandbox' }, { asset: 'USDT_ETHEREUM' }, { chainId: 1 },
    { verifiedAt: '2026-02-30T17:00:00Z' }, { verifiedAt: '2026-11-20T00:00:00Z' }, { rows: [] }, { extra: 'private-data' }]) {
    expect(() => resolve({ ...raw(), ...patch })).toThrow('unconfigured');
  }
  for (const patch of [{ country: 'mexico' }, { sourceCurrencyCode: 'MX' }, { serviceProvider: 'UNKNOWN' }, { minorUnits: 3 },
    { minimumAmount: -1 }, { maximumAmount: Infinity }, { minimumAmount: 500001 }, { verifiedAmount: 199.99 },
    { verifiedAmount: NaN }, { verifiedAt: 'invalid' }, { verifiedAt: '2026-11-20T00:00:00Z' }, { evidence: 'route_advertised' }, { walletAddress: 'private' }]) {
    expect(() => resolve(raw([{ ...row, ...patch } as CoverageRow]))).toThrow('unconfigured');
  }
});
test('catalogue remains last-known compatibility policy rather than a timed price cache', () => {
  expect(resolveProductionCoverage(environment, raw(), { now: now + 90 * 86400000 }).rows).toHaveLength(1);
  expect(() => resolveProductionCoverage(environment, raw(), { now: NaN })).toThrow('unconfigured');
});
test('duplicate tuples and inconsistent currency precision fail closed', () => {
  expect(() => resolve(raw([{ ...row }, { ...row }]))).toThrow('unconfigured');
  expect(() => resolve(raw([{ ...row }, { ...row, serviceProvider: 'TRANSAK', minorUnits: 1 }]))).toThrow('unconfigured');
});
test('forbidden providers and exact Banxa MX/MXN/SPEI quarantine always win', () => {
  for (const serviceProvider of ['MERCURYO', 'BINANCECONNECT', 'BINANCE_CONNECT', 'SWAPPED', 'BANXA']) {
    expect(() => resolve(raw([{ ...row, serviceProvider }]))).toThrow('unconfigured');
    const untrusted = raw([{ ...row, serviceProvider }]);
    expect(coverageCountries(untrusted).size).toBe(0); expect(coverageCurrencies(untrusted, 'MX').size).toBe(0);
    expect(intersectProductionCoverage([live(serviceProvider)], untrusted, 'MX', 'MXN')).toEqual([]);
    expect(() => assertProductionCoverageSelection(untrusted, selection)).toThrow('method_unavailable');
  }
  expect(resolve(raw([{ ...row, serviceProvider: 'BANXA', paymentMethodType: 'CREDIT_DEBIT_CARD' }])).rows).toHaveLength(1);
});
test('countries, currencies and precision expose only exact approved pairs without implicit USD', () => {
  const catalogue = resolve(raw([{ ...row }, { ...row, country: 'CO', sourceCurrencyCode: 'COP', paymentMethodType: 'PSE', minimumAmount: 42300,
    verifiedAmount: 42300 }, { ...row, country: 'US', sourceCurrencyCode: 'USD', maximumAmount: 25000, serviceProvider: 'TOPPER', paymentMethodType: 'CREDIT_DEBIT_CARD' }]));
  expect([...coverageCountries(catalogue)]).toEqual(['MX', 'CO', 'US']); expect([...coverageCurrencies(catalogue, 'MX')]).toEqual(['MXN']);
  expect([...coverageCurrencies(catalogue, 'CR')]).toEqual([]); expect(coverageMinorUnits(catalogue, 'MX', 'MXN')).toBe(2);
  expect(coverageMinorUnits(catalogue, 'MX', 'USD')).toBeUndefined();
});
test('intersection clips live limits inward per provider, leaves catalogue/live inputs unchanged, and excludes unknown facts', () => {
  const catalogue = resolve(raw([{ ...row, minimumAmount: 200.001, maximumAmount: 499999.999, verifiedAmount: 201 },
    { ...row, serviceProvider: 'TRANSAK', minimumAmount: 500, maximumAmount: 1000, verifiedAmount: 500 }]));
  const upstream = [live('ONRAMPMONEY', 199.999, 500001), live('TRANSAK', 600.001, 999.999), live('BANXA'), live('MERCURYO'),
    live('ONRAMPMONEY', 200, 500000, 'APPLE_PAY'), live('ONRAMPMONEY', 200, 500000, 'SPEI', 'USD')];
  const before = JSON.stringify({ catalogue, upstream });
  expect(intersectProductionCoverage(upstream, catalogue, 'MX', 'MXN')).toEqual([live('ONRAMPMONEY', 200.01, 499999.99), live('TRANSAK', 600.01, 999.99)]);
  expect(JSON.stringify({ catalogue, upstream })).toBe(before); expect(intersectProductionCoverage(upstream, catalogue, 'CO', 'MXN')).toEqual([]);
  expect(intersectProductionCoverage([live('ONRAMPMONEY', 500001)], catalogue, 'MX', 'MXN')).toEqual([]);
});
test('duplicate live intervals narrow rather than widening approved limits or filling gaps', () => {
  const catalogue = resolve(raw([{ ...row, maximumAmount: 300 }, { ...row, serviceProvider: 'TRANSAK', minimumAmount: 500, maximumAmount: 700, verifiedAmount: 500 }]));
  expect(intersectProductionCoverage([live('ONRAMPMONEY', 200, 280), live('ONRAMPMONEY', 250, 300)], catalogue, 'MX', 'MXN')).toEqual([live('ONRAMPMONEY', 250, 280)]);
  expect(intersectProductionCoverage([live('ONRAMPMONEY', 200, 220), live('ONRAMPMONEY', 250, 300)], catalogue, 'MX', 'MXN')).toEqual([]);
  expect(() => assertProductionCoverageSelection(catalogue, { ...selection, amount: 400 })).toThrow('amount_unavailable');
  expect(() => assertProductionCoverageSelection(catalogue, { ...selection, amount: 500, serviceProvider: 'ONRAMPMONEY' })).toThrow('amount_unavailable');
  expect(() => assertProductionCoverageSelection(catalogue, { ...selection, amount: 500, serviceProvider: 'TRANSAK' })).not.toThrow();
});
test('selection checks exact country, fiat, provider and method before amount', () => {
  const catalogue = resolve(); assertProductionCoverageSelection(catalogue, selection);
  for (const patch of [{ country: 'CR' }, { sourceCurrencyCode: 'USD' }, { paymentMethodType: 'GOOGLE_PAY' }, { serviceProvider: 'BANXA' }]) {
    expect(() => assertProductionCoverageSelection(catalogue, { ...selection, ...patch })).toThrow('method_unavailable');
  }
  for (const amount of [0, 199.99, 500000.01, 200.001, NaN, Infinity]) {
    expect(() => assertProductionCoverageSelection(catalogue, { ...selection, amount })).toThrow('amount_unavailable');
  }
});
test('zero- and one-decimal fiat amounts are never silently rounded', () => {
  for (const [minorUnits, minimumAmount, maximumAmount, valid, invalid] of [[0, 200.01, 300.99, 201, 201.5], [1, 200.01, 300.99, 200.1, 200.11]]) {
    const catalogue = resolve(raw([{ ...row, minorUnits: minorUnits!, minimumAmount: minimumAmount!, maximumAmount: maximumAmount!, verifiedAmount: valid! }]));
    expect(coverageMinorUnits(catalogue, 'MX', 'MXN')).toBe(minorUnits);
    expect(() => assertProductionCoverageSelection(catalogue, { ...selection, amount: valid! })).not.toThrow();
    expect(() => assertProductionCoverageSelection(catalogue, { ...selection, amount: invalid! })).toThrow('amount_unavailable');
    expect(intersectProductionCoverage([live()], catalogue, 'MX', 'MXN')).toEqual([live('ONRAMPMONEY', minorUnits === 0 ? 201 : 200.1, minorUnits === 0 ? 300 : 300.9)]);
  }
});
test('binary floating point noise cannot shrink legitimate bounds or admit meaningful fractional minor units', () => {
  const catalogue = resolve(raw([{ ...row, minimumAmount: 1.15, maximumAmount: 2.3, verifiedAmount: 1.15 }]));
  expect(intersectProductionCoverage([live('ONRAMPMONEY', 1, 3)], catalogue, 'MX', 'MXN')).toEqual([live('ONRAMPMONEY', 1.15, 2.3)]);
  for (const amount of [1.15, 2.3]) expect(() => assertProductionCoverageSelection(catalogue, { ...selection, amount })).not.toThrow();
  expect(() => assertProductionCoverageSelection(catalogue, { ...selection, amount: 1.150000001 })).toThrow('amount_unavailable');
});
test('USD global bounds remain fifty to twenty-five-thousand without FX or new historical restrictions', () => {
  const catalogue = resolve(raw([{ ...row, sourceCurrencyCode: 'USD', minimumAmount: 1, maximumAmount: 50000, verifiedAmount: 50 }]));
  expect(intersectProductionCoverage([live('ONRAMPMONEY', 1, 100000, 'SPEI', 'USD')], catalogue, 'MX', 'USD')).toEqual([live('ONRAMPMONEY', 50, 25000, 'SPEI', 'USD')]);
  for (const amount of [49.99, 25000.01]) expect(() => assertProductionCoverageSelection(catalogue, { ...selection, sourceCurrencyCode: 'USD', amount })).toThrow('amount_unavailable');
});
