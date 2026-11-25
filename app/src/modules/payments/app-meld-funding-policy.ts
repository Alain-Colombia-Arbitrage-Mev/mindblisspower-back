import { z } from 'zod';
import walletCoverage from './app-meld-wallet-coverage.json';
import { additionalAppMeldMarkets } from './app-meld-additional-markets';
import { ARBITRUM_USDC_CHAIN_ID } from './personal-company-rpc';
import { PERSONAL_FUNDING_MAXIMUM_COP, PERSONAL_FUNDING_MAXIMUM_USD, PERSONAL_FUNDING_MINIMUM_COP,
  PERSONAL_FUNDING_MINIMUM_MXN, PERSONAL_FUNDING_MINIMUM_USD } from './reown-funding-options';

export const appMeldAsset = z.enum(['USDT_POLYGON', 'USDC_POLYGON', 'USDC_ARBITRUM', 'USDC']);
export const appMeldProvider = z.enum(['MERCURYO', 'ONRAMPMONEY', 'ALCHEMYPAY', 'BANXA', 'ONMETA', 'RAMPNOW']);
export const appMeldCountry = z.string().regex(/^[A-Z]{2}$/);
export const appMeldCurrency = z.string().regex(/^[A-Z]{3}$/);
export const appMeldMethod = z.string().regex(/^[A-Z0-9_]{2,40}$/);
export type AppMeldAsset = z.infer<typeof appMeldAsset>;
export type AppMeldProvider = z.infer<typeof appMeldProvider>;

const historicalRampNowMethods = new Set(['CREDIT_DEBIT_CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'ACH', 'LOCAL_BANK_TRANSFER']);

type HistoricalMarket = {
  country: z.infer<typeof appMeldCountry>;
  currency: z.infer<typeof appMeldCurrency>;
  asset: AppMeldAsset;
  minorUnits?: 0 | 2;
  rails: ReadonlyArray<{
    provider: AppMeldProvider;
    methods: readonly z.infer<typeof appMeldMethod>[];
    minimum: number;
    maximum: number;
  }>;
};

// Previously issued App checkout rows remain readable with their original rails and bounds.
const historicalMarkets: readonly HistoricalMarket[] = [
  { country: 'MX', currency: 'USD', asset: 'USDT_POLYGON', rails: [
    { provider: 'MERCURYO', methods: ['CREDIT_DEBIT_CARD'], minimum: PERSONAL_FUNDING_MINIMUM_USD, maximum: PERSONAL_FUNDING_MAXIMUM_USD },
  ] },
  { country: 'MX', currency: 'MXN', asset: 'USDT_POLYGON', rails: [
    { provider: 'MERCURYO', methods: ['CREDIT_DEBIT_CARD'], minimum: PERSONAL_FUNDING_MINIMUM_MXN, maximum: 312_013.70 },
    { provider: 'ONRAMPMONEY', methods: ['SPEI'], minimum: PERSONAL_FUNDING_MINIMUM_MXN, maximum: 500_000 },
  ] },
  { country: 'US', currency: 'USD', asset: 'USDC_POLYGON', rails: [
    { provider: 'ONRAMPMONEY', methods: ['ACH', 'LOCAL_BANK_TRANSFER'], minimum: 50, maximum: PERSONAL_FUNDING_MAXIMUM_USD },
  ] },
  { country: 'CO', currency: 'COP', asset: 'USDC_POLYGON', rails: [
    { provider: 'ONRAMPMONEY', methods: ['PSE', 'LOCAL_BANK_TRANSFER'], minimum: PERSONAL_FUNDING_MINIMUM_COP, maximum: PERSONAL_FUNDING_MAXIMUM_COP },
  ] },
  { country: 'BR', currency: 'BRL', asset: 'USDC_ARBITRUM', rails: [
    { provider: 'ALCHEMYPAY', methods: ['PIX'], minimum: 50, maximum: 20_000 },
    { provider: 'MERCURYO', methods: ['CREDIT_DEBIT_CARD'], minimum: 155.65, maximum: 93_387.41 },
  ] },
  ...additionalAppMeldMarkets,
];

const coverageRow = z.object({
  country: appMeldCountry, sourceCurrencyCode: appMeldCurrency, serviceProvider: appMeldProvider,
  paymentMethodType: appMeldMethod, minorUnits: z.union([z.literal(0), z.literal(2)]),
  minimumAmount: z.number().finite().nonnegative(), maximumAmount: z.number().finite().positive().max(1_000_000_000),
  destinationCurrencyCode: appMeldAsset.default('USDT_POLYGON'),
});
type CoverageRow = z.infer<typeof coverageRow>;
type Market = { minorUnits: 0 | 2; asset: AppMeldAsset; rows: readonly CoverageRow[] };

const markets = new Map<string, Market>();
const rowsByPair = new Map<string, CoverageRow[]>();
const seen = new Set<string>();
const boundsEpsilon = (value: number) => Math.abs(value - Math.round(value))
  <= Number.EPSILON * Math.max(1, Math.abs(value)) * 2 ? Math.round(value) : value;

/** The public checkout uses the same source precision and hard limits as Wallet. */
export function appMeldAmountFitsPrecision(amount: number, minorUnits: number) {
  return Number.isFinite(amount) && Number.isInteger(boundsEpsilon(amount * 10 ** minorUnits));
}
export function appMeldRouteBounds(row: CoverageRow, minimum = row.minimumAmount, maximum = row.maximumAmount) {
  const scale = 10 ** row.minorUnits;
  return {
    minimumAmount: Math.ceil(boundsEpsilon(Math.max(minimum, row.minimumAmount, row.sourceCurrencyCode === 'USD' ? 50 : 1 / scale) * scale)) / scale,
    maximumAmount: Math.floor(boundsEpsilon(Math.min(maximum, row.maximumAmount, row.sourceCurrencyCode === 'USD' ? 25_000 : 1_000_000_000) * scale)) / scale,
  };
}

for (const row of z.array(coverageRow).min(1).max(10_000).parse(walletCoverage.rows)) {
  const key = row.country + ':' + row.sourceCurrencyCode, id = [key, row.serviceProvider, row.paymentMethodType, row.destinationCurrencyCode].join(':');
  const rows = rowsByPair.get(key) ?? [];
  const range = appMeldRouteBounds(row);
  if (seen.has(id) || (rows.length && rows[0]!.minorUnits !== row.minorUnits) || range.minimumAmount > range.maximumAmount)
    throw Error('wallet_funding_unconfigured');
  seen.add(id);
  rows.push(Object.freeze(row));
  rowsByPair.set(key, rows);
}
for (const [key, rows] of rowsByPair) {
  const preferred = rows.find(row => row.destinationCurrencyCode === 'USDC_POLYGON') ?? rows[0]!;
  markets.set(key, { minorUnits: preferred.minorUnits, asset: preferred.destinationCurrencyCode, rows: Object.freeze(rows) });
}

export function appMeldMarket(country: string, currency: string) {
  return markets.get(country + ':' + currency);
}

export function appMeldRecordedRoute(country: string, currency: string, provider: string, method: string, asset: AppMeldAsset, amount: number) {
  if (provider === 'RAMPNOW' && country === 'US' && currency === 'USD') return asset !== 'USDT_POLYGON'
    && historicalRampNowMethods.has(method) && appMeldAmountFitsPrecision(amount, 2) && amount >= 50 && amount <= 10_000;
  const market = appMeldMarket(country, currency);
  if (market && appMeldAmountFitsPrecision(amount, market.minorUnits) && market.rows.some(row => {
    const range = appMeldRouteBounds(row);
    return row.serviceProvider === provider && row.paymentMethodType === method && row.destinationCurrencyCode === asset
      && amount >= range.minimumAmount && amount <= range.maximumAmount;
  })) return true;
  const historical = historicalMarkets.find(item => item.country === country && item.currency === currency);
  return historical?.asset === asset && historical.rails.some(rail => rail.provider === provider && rail.methods.includes(method)
    && amount >= rail.minimum && amount <= rail.maximum);
}

export function appMeldNetwork(asset: AppMeldAsset) {
  if (asset === 'USDC_ARBITRUM') return { network: 'arbitrum', chainId: ARBITRUM_USDC_CHAIN_ID } as const;
  if (asset === 'USDC') return { network: 'ethereum', chainId: 1 } as const;
  return { network: 'polygon', chainId: 137 } as const;
}

export function appMeldDestination(asset: AppMeldAsset, address: string) {
  return { address, asset: asset === 'USDT_POLYGON' ? 'USDT' as const : 'USDC' as const, ...appMeldNetwork(asset) };
}
