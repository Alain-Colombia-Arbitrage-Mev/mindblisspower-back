import { z } from 'zod';
import { PERSONAL_FUNDING_MAXIMUM_COP, PERSONAL_FUNDING_MAXIMUM_USD, PERSONAL_FUNDING_MINIMUM_COP,
  PERSONAL_FUNDING_MINIMUM_MXN, PERSONAL_FUNDING_MINIMUM_USD } from './reown-funding-options';

export const appMeldAsset = z.enum(['USDT_POLYGON', 'USDC_POLYGON']);
export const appMeldProvider = z.enum(['MERCURYO', 'ONRAMPMONEY', 'RAMPNOW']);
export const appMeldCountry = z.enum(['MX', 'US', 'CO']);
export const appMeldCurrency = z.enum(['USD', 'MXN', 'COP']);
export const appMeldMethod = z.enum(['CREDIT_DEBIT_CARD', 'SPEI', 'APPLE_PAY', 'GOOGLE_PAY', 'ACH', 'LOCAL_BANK_TRANSFER', 'PSE']);
export type AppMeldAsset = z.infer<typeof appMeldAsset>;
export type AppMeldProvider = z.infer<typeof appMeldProvider>;

export const rampNowPaymentModes = {
  CREDIT_DEBIT_CARD: 'card', APPLE_PAY: 'apple_pay', GOOGLE_PAY: 'google_pay', ACH: 'ach', LOCAL_BANK_TRANSFER: 'wire',
} as const;

type Market = {
  country: z.infer<typeof appMeldCountry>;
  currency: z.infer<typeof appMeldCurrency>;
  asset: AppMeldAsset;
  rails: ReadonlyArray<{
    provider: AppMeldProvider;
    methods: readonly z.infer<typeof appMeldMethod>[];
    minimum: number;
    maximum: number;
  }>;
};

// Matches the production Wallet checkout routes that deliver on Polygon.
// Keep the hard limits in sync with the App journal migration.
const markets: readonly Market[] = [
  { country: 'MX', currency: 'USD', asset: 'USDT_POLYGON', rails: [
    { provider: 'MERCURYO', methods: ['CREDIT_DEBIT_CARD'], minimum: PERSONAL_FUNDING_MINIMUM_USD, maximum: PERSONAL_FUNDING_MAXIMUM_USD },
  ] },
  { country: 'MX', currency: 'MXN', asset: 'USDT_POLYGON', rails: [
    { provider: 'MERCURYO', methods: ['CREDIT_DEBIT_CARD'], minimum: PERSONAL_FUNDING_MINIMUM_MXN, maximum: 312_013.70 },
    { provider: 'ONRAMPMONEY', methods: ['SPEI'], minimum: PERSONAL_FUNDING_MINIMUM_MXN, maximum: 500_000 },
  ] },
  { country: 'US', currency: 'USD', asset: 'USDC_POLYGON', rails: [
    { provider: 'RAMPNOW', methods: ['CREDIT_DEBIT_CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'ACH', 'LOCAL_BANK_TRANSFER'], minimum: 50, maximum: 10_000 },
    { provider: 'ONRAMPMONEY', methods: ['ACH', 'LOCAL_BANK_TRANSFER'], minimum: 50, maximum: PERSONAL_FUNDING_MAXIMUM_USD },
  ] },
  { country: 'CO', currency: 'COP', asset: 'USDC_POLYGON', rails: [
    { provider: 'ONRAMPMONEY', methods: ['PSE', 'LOCAL_BANK_TRANSFER'], minimum: PERSONAL_FUNDING_MINIMUM_COP, maximum: PERSONAL_FUNDING_MAXIMUM_COP },
  ] },
];

export function appMeldMarket(country: string, currency: string) {
  return markets.find(market => market.country === country && market.currency === currency);
}

export function appMeldDestination(asset: AppMeldAsset, address: string) {
  return { address, asset: asset === 'USDC_POLYGON' ? 'USDC' as const : 'USDT' as const, network: 'polygon' as const, chainId: 137 as const };
}
