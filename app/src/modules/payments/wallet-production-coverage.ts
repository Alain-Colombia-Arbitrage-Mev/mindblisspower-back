import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const scope = 'wallet-prod-20261119-v1';
// Only connected providers with a compatible hosted checkout may create new attempts.
// RampNow quotes and Yellow Card headless discovery do not establish those guarantees.
export const productionCheckoutProviders = new Set(['ALCHEMYPAY', 'BANXA', 'ONMETA', 'ONRAMPMONEY']);
const token = z.string().regex(/^[A-Z0-9_]{2,64}$/);
const instant = z.string().max(40).datetime({ offset: true });
const positive = z.number().finite().positive().max(1_000_000_000);
export const productionAsset = z.enum(['USDT_POLYGON', 'USDC_POLYGON', 'USDC_ARBITRUM']);
export type ProductionAsset = z.infer<typeof productionAsset>;
export const productionAssetDetails = {
  USDT_POLYGON: { asset: 'USDT', network: 'polygon', chainId: 137 },
  USDC_POLYGON: { asset: 'USDC', network: 'polygon', chainId: 137 },
  USDC_ARBITRUM: { asset: 'USDC', network: 'arbitrum', chainId: 42161 },
} as const;
const rowSchema = z.object({ country: z.string().regex(/^[A-Z]{2}$/), sourceCurrencyCode: z.string().regex(/^[A-Z]{3}$/),
  serviceProvider: token, paymentMethodType: token, minorUnits: z.number().int().min(0).max(2),
  minimumAmount: z.number().finite().nonnegative().max(1_000_000_000), maximumAmount: positive,
  verifiedAmount: positive, verifiedAt: instant, evidence: z.literal('quote_verified'),
  destinationCurrencyCode: productionAsset.optional() }).strict();
const catalogueSchema = z.object({ schemaVersion: z.literal(1), scope: z.literal(scope), environment: z.literal('production'),
  asset: z.literal('USDT_POLYGON'), chainId: z.literal(137), verifiedAt: instant, rows: z.array(rowSchema).min(1).max(10_000) }).strict();

export type CoverageRow = z.infer<typeof rowSchema>;
export type Row = CoverageRow;
export type CoverageCatalogue = z.infer<typeof catalogueSchema>;
type CoverageEnvironment = { MELD_PRODUCTION_API_KEYS?: string; MELD_PRODUCTION_ACCOUNT_ID?: string;
  MELD_PRODUCTION_CATALOGUE_ATTESTATION?: string };
type Selection = { country: string; sourceCurrencyCode: string; amount: number; paymentMethodType: string; serviceProvider?: string };
type Route = { serviceProvider: string; paymentMethods: { method: string; currencyCode: string; minimumAmount: number; maximumAmount: number }[] };
export const productionAssetAllowed = (asset: ProductionAsset, country: string, fiat: string, serviceProvider: string, method: string) =>
  asset === 'USDT_POLYGON' || (asset === 'USDC_ARBITRUM' && country === 'MX' && fiat === 'EUR'
    && serviceProvider === 'ALCHEMYPAY' && method === 'CREDIT_DEBIT_CARD')
  || (asset === 'USDC_POLYGON' && serviceProvider === 'ONRAMPMONEY'
    && ((country === 'MX' && fiat === 'MXN' && method === 'SPEI')
      || (country === 'US' && fiat === 'USD' && ['ACH', 'LOCAL_BANK_TRANSFER'].includes(method))
      || (country === 'CO' && fiat === 'COP' && ['PSE', 'LOCAL_BANK_TRANSFER'].includes(method))));
const rowAsset = (row: CoverageRow) => row.destinationCurrencyCode ?? 'USDT_POLYGON';
const permitted = (row: CoverageRow) =>
  productionCheckoutProviders.has(row.serviceProvider) && (row.serviceProvider !== 'ONMETA' || row.country === 'IN')
  && productionAssetAllowed(rowAsset(row), row.country, row.sourceCurrencyCode, row.serviceProvider, row.paymentMethodType)
  && !(row.country === 'MX' && row.sourceCurrencyCode === 'MXN'
    && row.serviceProvider === 'BANXA' && row.paymentMethodType === 'SPEI');
const snapBinaryNoise = (scaled: number) => Math.abs(scaled - Math.round(scaled))
  <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2 ? Math.round(scaled) : scaled;
const precise = (value: number, minorUnits: number) => Number.isFinite(value)
  && Number.isInteger(snapBinaryNoise(value * 10 ** minorUnits));
function bounds(row: CoverageRow, minimum = row.minimumAmount, maximum = row.maximumAmount) {
  const scale = 10 ** row.minorUnits;
  // Route intervals keep their own fiat units; no exchange rate is inferred.
  return { minimum: Math.ceil(snapBinaryNoise(Math.max(minimum, row.minimumAmount, row.sourceCurrencyCode === 'USD' ? 50 : 1 / scale) * scale)) / scale,
    maximum: Math.floor(snapBinaryNoise(Math.min(maximum, row.maximumAmount, row.sourceCurrencyCode === 'USD' ? 25000 : 1_000_000_000) * scale)) / scale };
}
function selectedRows(catalogue: CoverageCatalogue, country: string, fiat: string) {
  return catalogue.rows.filter(row => row.country === country && row.sourceCurrencyCode === fiat && permitted(row));
}

/** Last-known compatibility policy, not a price cache or proof of checkout or
 * settlement. Current routes and user quotes remain authoritative. It does not
 * expire on a timer; operators review verifiedAt and explicitly replace it. */
export function resolveProductionCoverage(environment: CoverageEnvironment, rawCatalogue: unknown,
  { now = Date.now() }: { now?: number } = {}): CoverageCatalogue {
  const key = environment.MELD_PRODUCTION_API_KEYS, account = environment.MELD_PRODUCTION_ACCOUNT_ID;
  const attestation = environment.MELD_PRODUCTION_CATALOGUE_ATTESTATION;
  if (!key || !/^[\x21-\x7e]{1,2048}$/.test(key) || !account || !/^[A-Za-z0-9_-]{1,128}$/.test(account)
    || !attestation || !/^[a-f0-9]{64}$/.test(attestation) || !Number.isFinite(now)) throw Error('wallet_production_unconfigured');
  const expected = createHash('sha256').update(`${scope}\n${account}\n${key}`).digest();
  if (!timingSafeEqual(Buffer.from(attestation, 'hex'), expected)) throw Error('wallet_production_unconfigured');
  const parsed = catalogueSchema.safeParse(rawCatalogue);
  if (!parsed.success || Date.parse(parsed.data.verifiedAt) > now) throw Error('wallet_production_unconfigured');
  const seen = new Set<string>(), precision = new Map<string, number>(), assets = new Map<string, ProductionAsset>();
  for (const row of parsed.data.rows) {
    const id = [row.country, row.sourceCurrencyCode, row.serviceProvider, row.paymentMethodType].join('|');
    const pair = `${row.country}|${row.sourceCurrencyCode}`, units = precision.get(pair), range = bounds(row);
    if (!permitted(row) || seen.has(id) || (units !== undefined && units !== row.minorUnits)
      || (assets.has(pair) && assets.get(pair) !== rowAsset(row))
      || Date.parse(row.verifiedAt) > now || range.minimum > range.maximum
      || !precise(row.verifiedAmount, row.minorUnits) || row.verifiedAmount < range.minimum || row.verifiedAmount > range.maximum)
      throw Error('wallet_production_unconfigured');
    seen.add(id); precision.set(pair, row.minorUnits); assets.set(pair, rowAsset(row));
    Object.freeze(row);
  }
  Object.freeze(parsed.data.rows);
  return Object.freeze(parsed.data);
}
export function coverageCountries(catalogue: CoverageCatalogue): Set<string> {
  return new Set(catalogue.rows.filter(permitted).map(row => row.country));
}
export function coverageCurrencies(catalogue: CoverageCatalogue, country: string): Set<string> {
  return new Set(catalogue.rows.filter(row => row.country === country && permitted(row)).map(row => row.sourceCurrencyCode));
}
export function coverageMethodsByProvider(catalogue: CoverageCatalogue, country: string, fiat: string) {
  const providers = new Map<string, Set<string>>();
  for (const row of selectedRows(catalogue, country, fiat)) {
    const methods = providers.get(row.serviceProvider) ?? new Set<string>();
    methods.add(row.paymentMethodType);
    providers.set(row.serviceProvider, methods);
  }
  return providers;
}
export function coverageMinorUnits(catalogue: CoverageCatalogue, country: string, fiat: string): number | undefined {
  return selectedRows(catalogue, country, fiat)[0]?.minorUnits;
}
export function coverageAsset(catalogue: CoverageCatalogue, country: string, fiat: string): ProductionAsset {
  const row = selectedRows(catalogue, country, fiat)[0];
  return row ? rowAsset(row) : catalogue.asset;
}

/** Intersect each exact provider/method separately, never fill gaps or widen an
 * approved range when upstream starts advertising more generous limits. */
export function intersectProductionCoverage(liveRoutes: Route[], catalogue: CoverageCatalogue, country: string, fiat: string): Route[] {
  const approved = selectedRows(catalogue, country, fiat), results = new Map<string, Route>();
  for (const live of liveRoutes) for (const method of live.paymentMethods) {
    const row = approved.find(item => item.serviceProvider === live.serviceProvider && item.paymentMethodType === method.method);
    if (!row || method.currencyCode !== fiat || !Number.isFinite(method.minimumAmount) || method.minimumAmount < 0
      || !Number.isFinite(method.maximumAmount) || method.maximumAmount <= 0 || method.maximumAmount > 1_000_000_000
      || method.minimumAmount > method.maximumAmount) continue;
    const range = bounds(row, method.minimumAmount, method.maximumAmount);
    if (range.minimum > range.maximum) continue;
    let result = results.get(live.serviceProvider);
    if (!result) { result = { serviceProvider: live.serviceProvider, paymentMethods: [] }; results.set(live.serviceProvider, result); }
    // Duplicate live bounds are narrowed, never combined into a wider interval.
    const prior = result.paymentMethods.find(item => item.method === method.method);
    if (prior) { prior.minimumAmount = Math.max(prior.minimumAmount, range.minimum); prior.maximumAmount = Math.min(prior.maximumAmount, range.maximum); }
    else result.paymentMethods.push({ method: method.method, currencyCode: fiat, minimumAmount: range.minimum, maximumAmount: range.maximum });
  }
  return [...results.values()].map(route => ({ ...route, paymentMethods: route.paymentMethods.filter(item => item.minimumAmount <= item.maximumAmount) }))
    .filter(route => route.paymentMethods.length);
}
export function assertProductionCoverageSelection(catalogue: CoverageCatalogue, input: Selection): void {
  const matching = selectedRows(catalogue, input.country, input.sourceCurrencyCode).filter(row => row.paymentMethodType === input.paymentMethodType
    && (input.serviceProvider === undefined || row.serviceProvider === input.serviceProvider));
  if (!matching.length) throw Error('wallet_production_method_unavailable');
  if (!matching.some(row => { const range = bounds(row); return precise(input.amount, row.minorUnits)
    && input.amount >= range.minimum && input.amount <= range.maximum; })) throw Error('wallet_production_amount_unavailable');
}
