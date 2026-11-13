// Synthetic, non-network fixtures shared only by the sandbox security tests.
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { SandboxDatabase } from './meld-sandbox-reconciliation';
export const sandboxId = '6d492c47-80be-4e14-bc5f-54afaa56fc23';
export const sandboxCustomer = 'aa0ecbcc-54d8-4a6e-a0ac-4a662ac8ed44';
export const sandboxAddress = `0x${'2'.repeat(40)}`;
export const sandboxNow = Date.parse('2026-11-12T20:00:00.000Z');
export const sandboxEnvironment = { MELD_ADMIN_SANDBOX_ENABLED: 'true', MELD_API_SANDBOX: 'synthetic-sandbox-key',
  MELD_ACCOUNT_ID: 'sandbox-account', MELD_WEBHOOK_PROFILE_ID: 'sandbox-profile', MELD_WEBHOOK_ENABLED: 'true',
  MELD_WEBHOOK_PUBLIC_URL: 'https://wallet.mindblisspower.com/api/webhooks/meld', MELD_WEBHOOK_SIGNING_KEY: 'synthetic-signing-key-not-real-123456789' };
export const sandboxContext = { id: sandboxId, subject: 'synthetic-owner', wallet_address: sandboxAddress,
  country_code: 'MX', requested_amount: 650, source_currency: 'MXN', service_provider: 'BANXA',
  payment_method: 'CREDIT_DEBIT_CARD', provider_session_id: 'sandbox-session', customer_reference: sandboxCustomer,
  proof: null, checked_at: null };
export const sandboxTransaction = { id: 'sandbox-transaction', accountId: 'sandbox-account', sessionId: 'sandbox-session',
  externalSessionId: sandboxId, externalCustomerId: sandboxCustomer, serviceProvider: 'BANXA', transactionType: 'CRYPTO_PURCHASE',
  countryCode: 'MX', sourceCurrencyCode: 'MXN', sourceAmount: 650, destinationCurrencyCode: 'USDT_POLYGON',
  destinationAmount: 31.123456, paymentMethodType: 'CREDIT_DEBIT_CARD', status: 'SETTLED', updatedAt: new Date(sandboxNow).toISOString(),
  cryptoDetails: { destinationWalletAddress: sandboxAddress, chainId: '137' }, customer: { email: 'private@example.invalid' },
  serviceProviderDetails: { privateToken: 'do-not-persist' } };
export function sandboxDatabase({ context = sandboxContext as unknown, cached = [] as unknown[], failProof = false } = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  let receipt = false;
  const database = { execute: async (query: SQL) => {
    const value = new PgDialect().sqlToQuery(query); queries.push(value);
    if (value.sql.includes('record_meld_sandbox_proof')) { if (failProof) throw Error('db fixture unavailable'); return [{ proof: JSON.parse(String(value.params[2])) }]; }
    if (value.sql.includes('record_meld_sandbox_webhook_receipt')) { const inserted = !receipt; receipt = true; return [{ inserted }]; }
    if (value.sql.includes('read_meld_sandbox_confirmations')) return cached;
    if (value.sql.includes('read_meld_sandbox_')) return context ? [context] : [];
    throw Error('unexpected fixture query');
  } } as unknown as SandboxDatabase;
  return { database, queries };
}
