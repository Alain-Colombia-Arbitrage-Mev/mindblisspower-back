import { formatUnits, parseUnits } from 'ethers';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { administrativeOfframpConfiguration, administrativeOfframpHash, type OfframpDatabase, type OfframpEnvironment } from './administrative-offramp-session';
import { sandboxMeldJson, sandboxOperation, sandboxOperationScope } from './meld-sandbox-http';

const uuid = z.string().uuid(), code = z.string().regex(/^[A-Z0-9_]{2,64}$/);
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).refine(value => value !== '.' && value !== '..');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
const statuses = z.enum(['PENDING_CREATED', 'PENDING', 'PROCESSING', 'AUTHORIZED', 'ACCEPTED', 'PARTIALLY_SETTLED',
  'SETTLING', 'TWO_FA_REQUIRED', 'TWO_FA_PROVIDED', 'ERROR', 'SETTLED', 'FAILED', 'DECLINED', 'CANCELLED', 'REFUNDED', 'VOIDED', 'AUTHORIZATION_EXPIRED']);
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/).refine(value => Number(value) <= 1_000_000_000);
const proofSchema = z.object({ transactionId: id, accountId: id, sessionId: id, externalSessionId: uuid, externalCustomerId: uuid,
  serviceProvider: code, countryCode: z.enum(['US', 'MX', 'CO']), destinationCurrencyCode: z.enum(['USD', 'MXN', 'COP']),
  sourceCurrencyCode: z.literal('USDT_POLYGON'), sourceAmount: decimal, sourceWalletAddress: address, chainId: z.literal('137'),
  paymentMethodType: code, providerStatus: statuses, providerUpdatedAt: z.string().datetime({ offset: true }), destinationAmount: decimal,
  depositWalletAddress: address.optional(),
}).strict();
const rowSchema = z.object({ id: uuid, subject: z.string().min(1).max(255), account_id: id, customer_reference: uuid,
  wallet_address: address, source_amount: z.coerce.number().finite().positive().max(1_000_000_000),
  amount_atomic: z.string().regex(/^[1-9]\d{0,15}$/), country_code: z.enum(['US', 'MX', 'CO']), destination_currency: z.enum(['USD', 'MXN', 'COP']),
  service_provider: code, payment_method: code, status: z.enum(['initiated', 'session_created', 'unavailable']),
  provider_session_id: id.nullable(), quoted_destination_amount: z.coerce.number().finite().min(0).max(1_000_000_000).nullable(),
  proof: z.unknown().nullable(), created_at: z.coerce.date(),
});
type Row = z.infer<typeof rowSchema>;
function row(value: unknown) {
  const parsed = rowSchema.safeParse(value);
  if (!parsed.success) throw Error('administrative_offramp_unavailable');
  const result = parsed.data;
  if (Number(result.source_amount.toFixed(6)) !== result.source_amount
    || parseUnits(result.source_amount.toFixed(6), 6).toString() !== result.amount_atomic) throw Error('administrative_offramp_unavailable');
  return result;
}
function match(proof: z.infer<typeof proofSchema>, context: Row) {
  return proof.accountId === context.account_id && proof.externalSessionId === context.id
    && proof.externalCustomerId === context.customer_reference && proof.sessionId === context.provider_session_id
    && proof.serviceProvider === context.service_provider && proof.paymentMethodType === context.payment_method
    && proof.countryCode === context.country_code && proof.destinationCurrencyCode === context.destination_currency
    && proof.sourceWalletAddress === context.wallet_address && parseUnits(proof.sourceAmount, 6).toString() === context.amount_atomic;
}
function cached(context: Row) {
  if (context.proof === null) return null;
  const parsed = proofSchema.safeParse(context.proof);
  if (!parsed.success) throw Error('administrative_offramp_unavailable');
  const proof = parsed.data;
  if (!match(proof, context) || (proof.providerStatus === 'SETTLED' && Number(proof.destinationAmount) <= 0)
    || (proof.depositWalletAddress && (proof.depositWalletAddress === context.wallet_address || /^0x0{40}$/.test(proof.depositWalletAddress)))) throw Error('administrative_offramp_unavailable');
  return proof;
}
function snapshot(context: Row) {
  const proof = cached(context);
  const state = !proof ? 'unconfirmed' : proof.providerStatus === 'SETTLED' ? 'confirmed'
    : ['FAILED', 'DECLINED', 'CANCELLED', 'REFUNDED', 'VOIDED', 'AUTHORIZATION_EXPIRED'].includes(proof.providerStatus) ? 'failed' : 'pending';
  return { flow: 'administrative_offramp' as const, walletKind: 'administrative' as const, environment: 'sandbox' as const,
    reference: context.id, requestStatus: context.status, country: context.country_code,
    sourceAmount: formatUnits(BigInt(context.amount_atomic), 6),
    source: { address: context.wallet_address, asset: 'USDT' as const, network: 'polygon' as const, chainId: 137 as const },
    destinationCurrencyCode: context.destination_currency, serviceProvider: context.service_provider,
    paymentMethodType: context.payment_method, quotedDestinationAmount: context.quoted_destination_amount,
    createdAt: context.created_at.toISOString(),
    confirmation: { state, source: proof ? 'meld_sandbox_api' : 'none', testMode: true,
      ...(proof ? { transactionId: proof.transactionId, providerStatus: proof.providerStatus, updatedAt: proof.providerUpdatedAt,
        ...(state === 'confirmed' ? { destinationAmount: proof.destinationAmount } : {}) } : {}) },
    execution: { canBroadcast: false as const, canFund: false as const, mode: 'sandbox_no_funds' as const } };
}

/** The deposit address is not the customer's source wallet. No deposit send is exposed in sandbox. */
export function administrativeOfframpProof(value: unknown, context: Row, expectedTransaction: string) {
  const result = z.object({ transaction: z.object({ id, accountId: id, sessionId: id, externalSessionId: uuid, externalCustomerId: uuid,
    transactionType: z.literal('CRYPTO_SELL'), serviceProvider: code, countryCode: z.enum(['US', 'MX', 'CO']),
    sourceCurrencyCode: z.literal('USDT_POLYGON'), destinationCurrencyCode: z.enum(['USD', 'MXN', 'COP']),
    sourceAmount: z.number().finite().positive().max(1_000_000_000), destinationAmount: z.number().finite().min(0).max(1_000_000_000),
    paymentMethodType: code, status: z.preprocess(value => value === 'PENDING CREATED' ? 'PENDING_CREATED' : value, statuses), updatedAt: z.string().datetime({ offset: true }),
    cryptoDetails: z.object({ sourceWalletAddress: address.nullish(), sessionWalletAddress: address.nullish(), destinationWalletAddress: address.nullish(),
      chainId: z.union([z.literal('137'), z.literal(137)]) }) }) }).safeParse(value);
  if (!result.success) throw Error('administrative_offramp_unavailable');
  const parsed = result.data.transaction;
  if (parsed.id !== expectedTransaction || Number(parsed.sourceAmount.toFixed(6)) !== parsed.sourceAmount
    || Number(parsed.destinationAmount.toFixed(6)) !== parsed.destinationAmount) throw Error('administrative_offramp_unavailable');
  const origin = parsed.cryptoDetails.sourceWalletAddress ?? parsed.cryptoDetails.sessionWalletAddress;
  if (!origin || (parsed.cryptoDetails.sourceWalletAddress && parsed.cryptoDetails.sessionWalletAddress
    && parsed.cryptoDetails.sourceWalletAddress !== parsed.cryptoDetails.sessionWalletAddress)) throw Error('administrative_offramp_unavailable');
  const proof = proofSchema.parse({ transactionId: parsed.id, accountId: parsed.accountId, sessionId: parsed.sessionId,
    externalSessionId: parsed.externalSessionId, externalCustomerId: parsed.externalCustomerId, serviceProvider: parsed.serviceProvider,
    countryCode: parsed.countryCode, destinationCurrencyCode: parsed.destinationCurrencyCode, sourceCurrencyCode: parsed.sourceCurrencyCode,
    sourceAmount: parsed.sourceAmount.toFixed(6), destinationAmount: parsed.destinationAmount.toFixed(6), sourceWalletAddress: origin,
    chainId: '137', paymentMethodType: parsed.paymentMethodType, providerStatus: parsed.status, providerUpdatedAt: parsed.updatedAt,
    ...(parsed.cryptoDetails.destinationWalletAddress ? { depositWalletAddress: parsed.cryptoDetails.destinationWalletAddress } : {}) });
  if (!match(proof, context) || (proof.providerStatus === 'SETTLED' && parsed.destinationAmount <= 0)
    || (proof.depositWalletAddress && (proof.depositWalletAddress === context.wallet_address || /^0x0{40}$/.test(proof.depositWalletAddress)))
    || (context.proof !== null && (cached(context)?.transactionId !== parsed.id
      || (cached(context)?.depositWalletAddress && cached(context)?.depositWalletAddress !== proof.depositWalletAddress)))) throw Error('administrative_offramp_unavailable');
  return proof;
}

const gates = new WeakMap<OfframpDatabase, Map<string, { active: boolean; until: number; reset: number; count: number }>>();
function acquire(database: OfframpDatabase, owner: string) {
  let entries = gates.get(database); if (!entries) { entries = new Map(); gates.set(database, entries); }
  const now = Date.now(); for (const [key, state] of entries) if (!state.active && state.reset <= now) entries.delete(key);
  let state = entries.get(owner);
  if (state?.active || (state && (state.until > now || state.count >= 30)) || (!state && entries.size >= 10_000)) throw Error('administrative_operation_rate_limited');
  if (!state) { state = { active: false, until: 0, reset: now + 600_000, count: 0 }; entries.set(owner, state); }
  state.active = true; state.until = now + 5000; state.count++; return () => { state.active = false; };
}
async function refresh(database: OfframpDatabase, context: Row, dependencies: {
  environment: OfframpEnvironment; fetchImpl: typeof fetch; signal?: AbortSignal;
}, requestedTransaction?: string) {
  const config = administrativeOfframpConfiguration(dependencies.environment);
  if (config.account !== context.account_id) throw Error('administrative_offramp_unconfigured');
  cached(context); if (context.status !== 'session_created' || !context.provider_session_id) return snapshot(context);
  const release = acquire(database, context.subject), scope = sandboxOperationScope(dependencies.signal, 8000);
  try {
    let transaction = requestedTransaction ?? cached(context)?.transactionId;
    if (!transaction) {
      const query = new URLSearchParams({ sessionIds: context.provider_session_id, externalSessionIds: context.id,
        externalCustomerIds: context.customer_reference, serviceProviders: context.service_provider, types: 'CRYPTO_SELL', limit: '2' });
      const response = await sandboxMeldJson(`/payments/transactions?${query}`, { key: config.key, fetchImpl: dependencies.fetchImpl, signal: scope.signal });
      if (!response.ok) throw Error('administrative_offramp_unavailable');
      const parsedList = z.object({ transactions: z.array(z.object({ id })).max(1), totalCount: z.number().int().min(0).max(1).optional(), remaining: z.literal(0).optional() }).safeParse(response.data);
      if (!parsedList.success) throw Error('administrative_offramp_unavailable');
      const list = parsedList.data;
      if (!list.transactions.length) return snapshot(context); transaction = list.transactions[0]!.id;
    }
    if (!id.safeParse(transaction).success) throw Error('administrative_offramp_unavailable');
    const response = await sandboxMeldJson(`/payments/transactions/${encodeURIComponent(transaction)}`, { key: config.key, fetchImpl: dependencies.fetchImpl, signal: scope.signal });
    if (!response.ok) throw Error('administrative_offramp_unavailable');
    const proof = administrativeOfframpProof(response.data, context, transaction), serialized = JSON.stringify(proof);
    const stored = await sandboxOperation(() => database.execute<{ proof: unknown }>(sql`SELECT payments.record_administrative_offramp_proof(
      ${context.id}::uuid,${serialized}::jsonb,${administrativeOfframpHash(serialized)}) AS proof`), scope.signal);
    if (stored.length !== 1) throw Error('administrative_offramp_unavailable');
    return snapshot(row({ ...context, proof: stored[0]!.proof }));
  } finally { scope.close(); release(); }
}

export async function readAdministrativeOfframpStatus(database: OfframpDatabase, input: { subject: string; nativeSessionId: string; reference: string }, {
  environment = process.env, fetchImpl = fetch, signal,
}: { environment?: OfframpEnvironment; fetchImpl?: typeof fetch; signal?: AbortSignal } = {}) {
  administrativeOfframpConfiguration(environment);
  const reference = uuid.parse(input.reference).toLowerCase(), scope = sandboxOperationScope(signal);
  try {
    const rows = await sandboxOperation(() => database.execute(sql`SELECT * FROM payments.read_administrative_offramp_intent(
      ${input.subject},${input.nativeSessionId},${reference}::uuid)`), scope.signal);
    if (!rows.length) throw Error('administrative_operation_not_found');
    if (rows.length !== 1) throw Error('administrative_offramp_unavailable');
    const context = row(rows[0]); if (context.id !== reference || context.subject !== input.subject) throw Error('administrative_operation_forbidden');
    return await refresh(database, context, { environment, fetchImpl, signal: scope.signal });
  } finally { scope.close(); }
}
export async function readAdministrativeOfframpHistory(database: OfframpDatabase, subject: string, nativeSessionId: string, environment: OfframpEnvironment = process.env, signal?: AbortSignal) {
  administrativeOfframpConfiguration(environment);
  const scope = sandboxOperationScope(signal);
  try {
  const rows = await sandboxOperation(() => database.execute(sql`SELECT * FROM payments.read_administrative_offramp_history(${subject},${nativeSessionId})`), scope.signal);
  if (rows.length > 50) throw Error('administrative_offramp_unavailable');
  const records = rows.map(value => { const context = row(value); if (context.subject !== subject) throw Error('administrative_operation_forbidden'); return snapshot(context); });
  return { flow: 'administrative_offramp', walletKind: 'administrative', environment: 'sandbox', records };
  } finally { scope.close(); }
}

export async function handleVerifiedAdministrativeOfframpWebhook(database: OfframpDatabase, event: {
  accountId: string; profileId: string | null; payload: { externalSessionId?: string; externalCustomerId?: string; sessionId?: string; paymentTransactionId?: string; transactionType?: string };
}, { environment = process.env, fetchImpl = fetch, signal }: { environment?: OfframpEnvironment; fetchImpl?: typeof fetch; signal?: AbortSignal } = {}) {
  try { administrativeOfframpConfiguration(environment); } catch { return { received: true, ignored: true, mode: 'sandbox_only' }; }
  const payload = event.payload;
  if (event.accountId !== environment.MELD_ACCOUNT_ID || event.profileId !== environment.MELD_WEBHOOK_PROFILE_ID || payload.transactionType !== 'CRYPTO_SELL'
    || !uuid.safeParse(payload.externalSessionId).success || !uuid.safeParse(payload.externalCustomerId).success
    || !id.safeParse(payload.sessionId).success || !id.safeParse(payload.paymentTransactionId).success) return { received: true, ignored: true, mode: 'sandbox_only' };
  const rows = await database.execute(sql`SELECT * FROM payments.read_administrative_offramp_webhook_context(
    ${payload.externalSessionId}::uuid,${payload.externalCustomerId}::uuid,${payload.sessionId})`);
  if (!rows.length) return { received: true, ignored: true, mode: 'sandbox_only' };
  if (rows.length !== 1) throw Error('administrative_offramp_unavailable');
  const context = row(rows[0]);
  if (context.id !== payload.externalSessionId || context.customer_reference !== payload.externalCustomerId
    || context.provider_session_id !== payload.sessionId || context.account_id !== event.accountId) throw Error('administrative_offramp_unavailable');
  await refresh(database, context, { environment, fetchImpl, signal }, payload.paymentTransactionId);
  return { received: true, mode: 'sandbox_only' };
}
