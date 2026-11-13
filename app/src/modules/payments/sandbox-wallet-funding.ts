import { isIP } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { readSandboxWallet, sandboxWalletConfiguration, type SandboxWalletDatabase, type SandboxWalletEnvironment,
  type SandboxWalletPrincipal } from '../identity/sandbox-wallet';
import { createAdministrativePreflightGate, readAdministrativeSandboxOptions, sandboxProviderWidgetUrl } from './wallet-funding';
import { sandboxMeldJson, sandboxOperation, sandboxOperationScope } from './meld-sandbox-http';
import { sandboxContextInput, sandboxProofConfirmation, validateSandboxTransaction, type SandboxConfirmation } from './meld-sandbox-reconciliation';

const uuid = z.string().uuid(), address = z.string().regex(/^0x[0-9a-f]{40}$/), vendorId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
  .refine(value => value !== '.' && value !== '..');
const source = z.enum(['USD', 'MXN']), method = z.enum(['CREDIT_DEBIT_CARD', 'APPLE_PAY', 'GOOGLE_PAY']);
const country = z.enum(['US', 'MX', 'CO']);
const amount = z.number().finite().min(0.01).max(10_000_000).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001);
export const sandboxWalletFundingInput = z.object({ requestId: uuid.transform(value => value.toLowerCase()), country,
  sourceCurrencyCode: source, amount, paymentMethodType: method }).strict().refine(value => value.sourceCurrencyCode === 'USD'
    ? value.amount >= 50 && value.amount <= 25000 : value.country === 'MX');
export const sandboxWalletOptionsInput = z.object({ country, sourceCurrencyCode: source }).strict()
  .refine(value => value.sourceCurrencyCode === 'USD' || value.country === 'MX');
type Dependencies = { environment?: SandboxWalletEnvironment; fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number };
const gates = new WeakMap<SandboxWalletDatabase, ReturnType<typeof createAdministrativePreflightGate>>();
function acquire(database: SandboxWalletDatabase, subject: string, requestId: string) {
  let gate = gates.get(database); if (!gate) { gate = createAdministrativePreflightGate(); gates.set(database, gate); }
  return gate(subject, requestId);
}
function one(rows: unknown[]) { if (rows.length !== 1) throw Error('sandbox_wallet_unavailable'); return rows[0]; }
const noConfirmation = (): SandboxConfirmation => ({ state: 'unconfirmed', source: 'none', testMode: true });
const destination = (value: string) => ({ address: value, asset: 'USDT' as const, network: 'polygon' as const, chainId: 137 as const });
export async function readSandboxWalletFundingOptions(raw: unknown, {
  environment = process.env, fetchImpl = fetch, signal,
}: Dependencies = {}) {
  sandboxWalletConfiguration(environment); const input = sandboxWalletOptionsInput.parse(raw);
  return readAdministrativeSandboxOptions({ ...input, serviceProvider: 'TRANSAK' }, { environment, fetchImpl, signal });
}
function sandboxFallbackUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192 || !/^https:\/\/sb\.meldcrypto\.com\/\?token=[A-Za-z0-9_.~-]{1,7000}$/.test(value)) return null;
  return value;
}
export function connectedWalletSandboxReturnUrl(reference: string) {
  return `https://wallet.mindblisspower.com/dashboard/wallet-administrative?sandboxCheckoutReference=${uuid.parse(reference).toLowerCase()}`;
}
function quote(value: unknown, input: z.infer<typeof sandboxWalletFundingInput>, walletAddress: string, account: string) {
  const parsed = z.object({ quotes: z.array(z.object({ serviceProvider: z.literal('TRANSAK'), countryCode: z.string().optional(),
    accountId: z.string().optional(), walletAddress: z.string().optional(), sourceCurrencyCode: source,
    destinationCurrencyCode: z.literal('USDT_POLYGON'), sourceAmount: z.number().finite().positive(),
    destinationAmount: z.number().finite().positive(), paymentMethodType: method,
    transactionType: z.literal('CRYPTO_PURCHASE').optional() })).length(1) }).safeParse(value);
  const item = parsed.success ? parsed.data.quotes[0] : null;
  if (!item || item.sourceCurrencyCode !== input.sourceCurrencyCode || item.sourceAmount !== input.amount
    || item.paymentMethodType !== input.paymentMethodType || (item.countryCode !== undefined && item.countryCode !== input.country)
    || (item.accountId !== undefined && item.accountId !== account)
    || (item.walletAddress !== undefined && item.walletAddress.toLowerCase() !== walletAddress)) throw Error('sandbox_wallet_provider_unavailable');
}
const attemptRow = z.object({ id: uuid, address, customer_reference: uuid, created: z.boolean(),
  status: z.enum(['initiated', 'session_created', 'unavailable']), created_at: z.coerce.date() });

/** One explicit BUY preparation, never a transfer, balance credit or commission. */
export async function createSandboxWalletFundingSession(database: SandboxWalletDatabase, raw: unknown,
  { subject, nativeSessionId, clientIp, environment = process.env, fetchImpl = fetch, signal, timeoutMs }:
    SandboxWalletPrincipal & Dependencies & { clientIp: string }) {
  const config = sandboxWalletConfiguration(environment), input = sandboxWalletFundingInput.parse(raw);
  if (!isIP(clientIp)) throw Error('sandbox_wallet_unconfigured');
  const release = acquire(database, subject, input.requestId), scope = sandboxOperationScope(signal, timeoutMs);
  try {
    const binding = await readSandboxWallet(database, { subject, nativeSessionId }, { environment, signal: scope.signal });
    if (!binding.verified || !binding.address) throw Error('sandbox_wallet_verification_required');
    const walletAddress = binding.address;
    const options = await readSandboxWalletFundingOptions({ country: input.country, sourceCurrencyCode: input.sourceCurrencyCode },
      { environment, fetchImpl, signal: scope.signal });
    const rail = options.routes.find(route => route.serviceProvider === 'TRANSAK')?.paymentMethods.find(item => item.method === input.paymentMethodType);
    if (!rail) throw Error('wallet_funding_method_unavailable');
    if (input.amount < rail.minimumAmount || input.amount > rail.maximumAmount) throw Error('wallet_funding_amount_unavailable');
    const result = await sandboxMeldJson('/payments/crypto/quote?includeSwap=false', { key: config.key, fetchImpl, signal: scope.signal,
      body: { countryCode: input.country, sourceCurrencyCode: input.sourceCurrencyCode, destinationCurrencyCode: 'USDT_POLYGON',
        sourceAmount: input.amount, paymentMethodType: input.paymentMethodType, serviceProviders: ['TRANSAK'], walletAddress } });
    if (!result.ok) throw Error('sandbox_wallet_provider_unavailable');
    quote(result.data, input, walletAddress, config.account);
    const parsedRow = attemptRow.safeParse(one(await sandboxOperation(() => database.execute(sql`SELECT * FROM payments.create_connected_wallet_sandbox_attempt(
      ${subject},${nativeSessionId},${input.requestId}::uuid,${input.country},${input.amount},${input.sourceCurrencyCode},${input.paymentMethodType},${config.account})`), scope.signal)));
    if (!parsedRow.success) throw Error('sandbox_wallet_unavailable'); const row = parsedRow.data;
    if (row.id !== input.requestId || row.address !== walletAddress) throw Error('sandbox_wallet_unavailable');
    if (!row.created || row.status !== 'initiated') throw Error('sandbox_wallet_request_already_used');
    const finish = async (status: 'session_created' | 'unavailable', providerSession: string | null, providerCustomer: string | null) => {
      const saved = await sandboxOperation(() => database.execute(sql`SELECT payments.finish_connected_wallet_sandbox_attempt(
        ${subject},${nativeSessionId},${row.id}::uuid,${status},${providerSession},${providerCustomer}) AS finished`), scope.signal);
      if (saved.length !== 1 || (saved[0] as { finished?: unknown }).finished !== true) throw Error('sandbox_wallet_unavailable');
    };
    let finishing = false;
    try {
      const response = await sandboxMeldJson('/crypto/session/widget', { key: config.key, fetchImpl, signal: scope.signal,
        body: { sessionType: 'BUY', externalCustomerId: row.customer_reference, externalSessionId: row.id,
          sessionData: { serviceProvider: 'TRANSAK', countryCode: input.country, sourceCurrencyCode: input.sourceCurrencyCode,
            sourceAmount: input.amount.toFixed(2), destinationCurrencyCode: 'USDT_POLYGON', walletAddress,
            paymentMethodType: input.paymentMethodType, clientIpAddress: clientIp, redirectUrl: connectedWalletSandboxReturnUrl(row.id),
            lockFields: ['walletAddress', 'destinationCurrencyCode', 'sourceCurrencyCode', 'sourceAmount', 'paymentMethodType'] } } });
      if (!response.ok) throw Error('sandbox_wallet_provider_unavailable');
      const providerSession = z.object({ id: vendorId, customerId: vendorId, externalSessionId: uuid,
        externalCustomerId: uuid, serviceProvider: z.literal('TRANSAK').optional(), serviceProviderWidgetUrl: z.string().max(8192).nullish(),
        widgetUrl: z.string().max(8192).nullish() }).safeParse(response.data);
      if (!providerSession.success || providerSession.data.externalSessionId !== row.id
        || providerSession.data.externalCustomerId !== row.customer_reference) throw Error('sandbox_wallet_provider_unavailable');
      const session = providerSession.data;
      const checkoutUrl = sandboxProviderWidgetUrl(session.serviceProviderWidgetUrl, 'TRANSAK') ?? sandboxFallbackUrl(session.widgetUrl);
      if (!checkoutUrl) throw Error('sandbox_wallet_provider_unavailable');
      finishing = true; await finish('session_created', session.id, session.customerId);
      return { checkoutReference: row.id, walletKind: 'administrative' as const, environment: 'sandbox' as const, provider: 'meld' as const,
        serviceProvider: 'TRANSAK' as const, status: 'session_created' as const, requestedAmount: input.amount,
        sourceCurrencyCode: input.sourceCurrencyCode, destinationCurrencyCode: 'USDT_POLYGON' as const, destination: destination(walletAddress),
        paymentMethodType: input.paymentMethodType, checkoutUrl, createdAt: row.created_at.toISOString() };
    } catch (error) { if (!finishing && !scope.signal.aborted) await finish('unavailable', null, null); throw error; }
  } finally { release(); scope.close(); }
}
const historyRow = z.object({ id: uuid, subject: z.string().min(1).max(255), address, country_code: country,
  source_currency: source, requested_amount: z.coerce.number().finite().positive().max(10_000_000),
  service_provider: z.literal('TRANSAK'), payment_method: method,
  status: z.enum(['initiated', 'session_created', 'unavailable']), created_at: z.coerce.date(),
  customer_reference: uuid, account_id: vendorId, provider_session_id: vendorId.nullable(), provider_customer_id: vendorId.nullable(),
  proof: z.unknown().nullable(), checked_at: z.coerce.date().nullable() });
function readRow(raw: unknown, subject: string) {
  const parsed = historyRow.safeParse(raw); if (!parsed.success) throw Error('sandbox_wallet_unavailable'); const value = parsed.data;
  if (value.subject !== subject || !sandboxWalletFundingInput.safeParse({ requestId: value.id, country: value.country_code,
    sourceCurrencyCode: value.source_currency, amount: value.requested_amount, paymentMethodType: value.payment_method }).success) throw Error('sandbox_wallet_unavailable');
  return value;
}
function cachedConfirmation(row: z.infer<typeof historyRow>) {
  if (row.proof === null) return noConfirmation();
  const proof = row.proof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw Error('sandbox_wallet_unavailable');
  const p = proof as Record<string, unknown>, confirmation = sandboxProofConfirmation(proof);
  if (confirmation.source !== 'meld_sandbox_api' || p.accountId !== row.account_id || p.sessionId !== row.provider_session_id
    || p.externalSessionId !== row.id || p.externalCustomerId !== row.customer_reference || p.serviceProvider !== 'TRANSAK'
    || p.countryCode !== row.country_code || p.sourceCurrencyCode !== row.source_currency || p.sourceAmount !== row.requested_amount.toFixed(2)
    || p.paymentMethodType !== row.payment_method || p.destinationCurrencyCode !== 'USDT_POLYGON' || p.walletAddress !== row.address || p.chainId !== '137') throw Error('sandbox_wallet_unavailable');
  return confirmation;
}
const reconciliationGates = new WeakMap<SandboxWalletDatabase, ReturnType<typeof createAdministrativePreflightGate>>();
async function reconcile(database: SandboxWalletDatabase, row: z.infer<typeof historyRow>, dependencies: Dependencies, signal: AbortSignal) {
  const environment = dependencies.environment || process.env, config = sandboxWalletConfiguration(environment), fetchImpl = dependencies.fetchImpl || fetch;
  const previous = cachedConfirmation(row);
  if (row.account_id !== config.account) throw Error('sandbox_wallet_provider_unavailable');
  if (!row.provider_session_id || !row.provider_customer_id) return previous;
  let gate = reconciliationGates.get(database); if (!gate) { gate = createAdministrativePreflightGate(); reconciliationGates.set(database, gate); }
  const release = gate(row.subject, randomUUID());
  try {
    let transactionId = previous.transactionId;
    if (!transactionId) {
      const query = new URLSearchParams({ externalSessionIds: row.id, sessionIds: row.provider_session_id,
        externalCustomerIds: row.customer_reference, serviceProviders: 'TRANSAK', types: 'CRYPTO_PURCHASE', limit: '2' });
      const result = await sandboxMeldJson(`/payments/transactions?${query}`, { key: config.key, fetchImpl, signal });
      const search = z.object({ transactions: z.array(z.object({ id: vendorId })).max(1) }).safeParse(result.data);
      if (!result.ok || !search.success) throw Error('sandbox_wallet_provider_unavailable');
      if (!search.data.transactions.length) return previous;
      transactionId = search.data.transactions[0]!.id;
    }
    const result = await sandboxMeldJson(`/payments/transactions/${encodeURIComponent(vendorId.parse(transactionId))}`, { key: config.key, fetchImpl, signal });
    const tx = z.object({ transaction: z.object({ customerId: vendorId }) }).safeParse(result.data);
    if (!result.ok || !tx.success || tx.data.transaction.customerId !== row.provider_customer_id) throw Error('sandbox_wallet_provider_unavailable');
    const context = sandboxContextInput.parse({ ...row, wallet_address: row.address });
    const data = result.data as { transaction: Record<string, unknown> };
    const transaction = data.transaction.status === 'PENDING CREATED' ? { ...data.transaction, status: 'PENDING_CREATED' } : data.transaction;
    const proof = validateSandboxTransaction({ transaction }, context, config.account, transactionId);
    const serialized = JSON.stringify(proof), hash = createHash('sha256').update(serialized).digest('hex');
    const saved = await sandboxOperation(() => database.execute(sql`SELECT payments.record_connected_wallet_sandbox_proof(
      ${row.subject},${row.id}::uuid,${serialized}::jsonb,${hash}) AS proof`), signal);
    const savedProof = z.object({ proof: z.unknown() }).parse(one(saved));
    const confirmation = cachedConfirmation({ ...row, proof: savedProof.proof });
    if (confirmation.transactionId !== transactionId) throw Error('sandbox_wallet_unavailable');
    return confirmation;
  } catch { throw Error('sandbox_wallet_provider_unavailable'); } finally { release(); }
}
export async function readSandboxWalletFundingStatus(database: SandboxWalletDatabase, input: SandboxWalletPrincipal & { checkoutReference: string },
  { environment = process.env, fetchImpl = fetch, signal, timeoutMs }: Dependencies = {}) {
  sandboxWalletConfiguration(environment); const reference = uuid.parse(input.checkoutReference), scope = sandboxOperationScope(signal, timeoutMs);
  try {
    const rows = await sandboxOperation(() => database.execute(sql`SELECT * FROM payments.read_connected_wallet_sandbox_attempt(
      ${input.subject},${input.nativeSessionId},${reference}::uuid)`), scope.signal);
    if (!rows.length) throw Error('sandbox_wallet_not_found');
    const row = readRow(one(rows), input.subject); if (row.id !== reference) throw Error('sandbox_wallet_unavailable');
    return { checkoutReference: row.id, walletKind: 'administrative' as const, environment: 'sandbox' as const, provider: 'meld' as const,
      serviceProvider: 'TRANSAK' as const, requestedAmount: row.requested_amount, sourceCurrencyCode: row.source_currency,
      paymentMethodType: row.payment_method, country: row.country_code, requestStatus: row.status,
      destination: destination(row.address), confirmation: await reconcile(database, row, { environment, fetchImpl }, scope.signal) };
  } finally { scope.close(); }
}
export async function readSandboxWalletFundingHistory(database: SandboxWalletDatabase, input: SandboxWalletPrincipal,
  { environment = process.env, signal, timeoutMs }: Dependencies = {}) {
  sandboxWalletConfiguration(environment); const scope = sandboxOperationScope(signal, timeoutMs);
  try {
    const rows = await sandboxOperation(() => database.execute(sql`SELECT * FROM payments.read_connected_wallet_sandbox_history(
      ${input.subject},${input.nativeSessionId})`), scope.signal);
    if (rows.length > 50) throw Error('sandbox_wallet_unavailable');
    const records = rows.map(raw => { const row = readRow(raw, input.subject); return { checkoutReference: row.id, provider: 'meld' as const,
      status: row.status, country: row.country_code, requestedAmount: row.requested_amount, sourceCurrencyCode: row.source_currency,
      destination: destination(row.address), paymentMethodType: row.payment_method, createdAt: row.created_at.toISOString(),
      ...(row.proof !== null ? { confirmation: cachedConfirmation(row) } : {}) }; });
    if (new Set(records.map(row => row.checkoutReference)).size !== records.length) throw Error('sandbox_wallet_unavailable');
    return { walletKind: 'administrative' as const, environment: 'sandbox' as const, settlement: 'unconfirmed' as const, records };
  } finally { scope.close(); }
}
