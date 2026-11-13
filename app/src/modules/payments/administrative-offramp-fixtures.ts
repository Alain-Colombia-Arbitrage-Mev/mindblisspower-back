import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { OfframpDatabase } from './administrative-offramp-session';
export const offId = '6d492c47-80be-4e14-bc5f-54afaa56fc23', offCustomer = 'aa0ecbcc-54d8-4a6e-a0ac-4a662ac8ed44';
export const offAddress = `0x${'2'.repeat(40)}`, offDeposit = `0x${'3'.repeat(40)}`, offNow = Date.parse('2026-11-13T04:00:00.000Z');
export const offEnvironment = { ADMINISTRATIVE_MELD_OFFRAMP_ENABLED: 'true', ADMINISTRATIVE_WALLET_SIGNING_ENABLED: 'true', MELD_ADMIN_SANDBOX_ENABLED: 'true',
  MELD_API_SANDBOX: 'synthetic-sandbox-key', MELD_ACCOUNT_ID: 'synthetic-account', MELD_WEBHOOK_ENABLED: 'true', MELD_WEBHOOK_PROFILE_ID: 'synthetic-profile',
  MELD_WEBHOOK_PUBLIC_URL: 'https://wallet.mindblisspower.com/api/webhooks/meld', MELD_WEBHOOK_SIGNING_KEY: 'synthetic-signing-key-not-real-12345678' };
export const offInput = { requestId: offId, country: 'US' as const, destinationCurrencyCode: 'USD' as const, amount: '100', serviceProvider: 'TRANSAK', paymentMethodType: 'PAYOUT_TO_CARD' };
export const offContext = { id: offId, subject: 'synthetic-owner', account_id: 'synthetic-account', customer_reference: offCustomer, wallet_address: offAddress,
  source_amount: 100, amount_atomic: '100000000', country_code: 'US' as const, destination_currency: 'USD' as const, service_provider: 'TRANSAK', payment_method: 'PAYOUT_TO_CARD',
  status: 'session_created' as const, provider_session_id: 'synthetic-session', quoted_destination_amount: 95.01, proof: null as unknown, created_at: new Date(offNow) };
export const offTransaction = { id: 'synthetic-transaction', accountId: 'synthetic-account', sessionId: 'synthetic-session', externalSessionId: offId, externalCustomerId: offCustomer,
  transactionType: 'CRYPTO_SELL', serviceProvider: 'TRANSAK', countryCode: 'US', sourceCurrencyCode: 'USDT_POLYGON', destinationCurrencyCode: 'USD',
  sourceAmount: 100, destinationAmount: 95.01, paymentMethodType: 'PAYOUT_TO_CARD', status: 'SETTLED', updatedAt: new Date(offNow).toISOString(),
  cryptoDetails: { sourceWalletAddress: offAddress, sessionWalletAddress: offAddress, destinationWalletAddress: offDeposit, chainId: '137' },
  customer: { email: 'private@example.invalid' }, serviceProviderDetails: { token: 'private-provider-token' } };
export function offDatabase(outputs: (unknown[] | Error)[] = [[{ ...offContext, status: 'initiated', created: true }], [{ finished: true }]]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const database = { execute: async (query: SQL) => {
    const q = new PgDialect().sqlToQuery(query); queries.push(q);
    if (q.sql.includes('record_administrative_offramp_proof')) return [{ proof: JSON.parse(String(q.params[1])) }];
    const next = outputs.shift(); if (next instanceof Error) throw next; if (!next) throw Error('unexpected database call'); return next;
  } } as unknown as OfframpDatabase;
  return { database, queries };
}
export function offRoutes(currency = 'USD', limitsCurrency = currency, minimum = 10, maximum = 25000) {
  return [{ partner: 'TRANSAK', source: 'USDT_POLYGON', destination: currency, checkoutSupported: true,
    paymentMethods: [{ name: 'PAYOUT_TO_CARD', checkoutSupported: true, limits: { currencyCode: limitsCurrency, min: minimum, max: maximum } }] }];
}
export function offQuote(change = {}) { return { quotes: [{ serviceProvider: 'TRANSAK', sourceCurrencyCode: 'USDT_POLYGON', destinationCurrencyCode: 'USD',
  sourceAmount: 100, destinationAmount: 95.01, paymentMethodType: 'PAYOUT_TO_CARD', countryCode: 'US', ...change }] }; }
