import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';

export type SandboxDatabase = Pick<IdentityDatabase, 'execute'>;
export type SandboxConfirmation = { state: 'unconfirmed' | 'pending' | 'confirmed' | 'failed';
  source: 'none' | 'meld_sandbox_api'; testMode: true; receivedAmount?: string; confirmedAt?: string;
  transactionId?: string; providerStatus?: string };
export type SandboxReconciliationDependencies = { environment?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch; signal?: AbortSignal; now?: () => number; timeoutMs?: number };
const reference = z.string().uuid();
const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).refine(value => value !== '.' && value !== '..');
const instant = z.string().datetime({ offset: true });
const statuses = z.enum(['PENDING_CREATED', 'PENDING', 'PROCESSING', 'AUTHORIZED', 'ACCEPTED', 'PARTIALLY_SETTLED',
  'SETTLING', 'TWO_FA_REQUIRED', 'TWO_FA_PROVIDED', 'ERROR', 'SETTLED', 'FAILED', 'DECLINED', 'CANCELLED', 'REFUNDED', 'VOIDED', 'AUTHORIZATION_EXPIRED']);
const proofInput = z.object({ transactionId: identifier, accountId: identifier, sessionId: identifier,
  externalSessionId: reference, externalCustomerId: reference, serviceProvider: z.enum(['TRANSAK', 'BANXA']),
  countryCode: z.string().regex(/^[A-Z]{2}$/), sourceCurrencyCode: z.enum(['USD', 'MXN']),
  paymentMethodType: z.string().regex(/^[A-Z0-9_]{2,40}$/),
  sourceAmount: z.string().regex(/^\d{1,10}\.\d{2}$/), destinationCurrencyCode: z.literal('USDT_POLYGON'),
  walletAddress: z.string().regex(/^0x[0-9a-f]{40}$/), chainId: z.literal('137'),
  providerStatus: statuses, providerUpdatedAt: instant,
  receivedAmount: z.string().regex(/^\d{1,12}(?:\.\d{1,6})?$/),
}).strict().refine(p => p.providerStatus !== 'SETTLED' || Number(p.receivedAmount) > 0);
export const sandboxContextInput = z.object({ id: reference, subject: z.string().min(1).max(255),
  wallet_address: z.string().regex(/^0x[0-9a-f]{40}$/), country_code: z.string().regex(/^[A-Z]{2}$/),
  requested_amount: z.coerce.number().finite().min(0.01).max(1_000_000_000), source_currency: z.enum(['USD', 'MXN']),
  service_provider: z.enum(['TRANSAK', 'BANXA']), payment_method: z.string().regex(/^[A-Z0-9_]{2,40}$/),
  provider_session_id: identifier.nullable(), customer_reference: reference,
  proof: z.unknown().nullable(), checked_at: z.coerce.date().nullable(),
});
export type SandboxContext = z.infer<typeof sandboxContextInput>;
const unconfirmed = (): SandboxConfirmation => ({ state: 'unconfirmed', source: 'none', testMode: true });

export function sandboxProofConfirmation(value: unknown): SandboxConfirmation {
  const parsed = proofInput.safeParse(value);
  if (!parsed.success) return unconfirmed();
  const p = parsed.data;
  const state = p.providerStatus === 'SETTLED' ? 'confirmed' :
    ['FAILED', 'DECLINED', 'CANCELLED', 'REFUNDED', 'VOIDED', 'AUTHORIZATION_EXPIRED'].includes(p.providerStatus) ? 'failed' : 'pending';
  return { state, source: 'meld_sandbox_api', testMode: true, transactionId: p.transactionId, providerStatus: p.providerStatus,
    ...(state === 'confirmed' ? { receivedAmount: p.receivedAmount, confirmedAt: p.providerUpdatedAt } : {}) };
}

function contextProof(context: SandboxContext) {
  if (context.proof === null) return null;
  const p = proofInput.safeParse(context.proof);
  if (!p.success || !matchesContext(p.data, context)) throw new Error('wallet_funding_unavailable');
  return p.data;
}
function matchesContext(p: z.infer<typeof proofInput>, c: SandboxContext) {
  return p.externalSessionId === c.id && p.externalCustomerId === c.customer_reference && p.sessionId === c.provider_session_id
    && p.serviceProvider === c.service_provider && p.countryCode === c.country_code && p.sourceCurrencyCode === c.source_currency
    && p.sourceAmount === c.requested_amount.toFixed(2) && p.walletAddress === c.wallet_address && p.paymentMethodType === c.payment_method;
}

// Read-only provider calls have an independent budget; no timer or effect invokes them.
const gates = new WeakMap<SandboxDatabase, Map<string, { until: number; active: boolean; count: number; reset: number }>>();
function acquire(database: SandboxDatabase, context: SandboxContext, now: number) {
  let entries = gates.get(database); if (!entries) { entries = new Map(); gates.set(database, entries); }
  for (const [key, value] of entries) if (!value.active && value.reset <= now) entries.delete(key);
  let entry = entries.get(context.subject);
  if (entry?.active || (entry && (entry.until > now || entry.count >= 30))) throw new Error('wallet_funding_rate_limited');
  if (!entry) {
    if (entries.size >= 10_000) throw new Error('wallet_funding_rate_limited');
    entry = { until: 0, active: false, count: 0, reset: now + 10 * 60_000 }; entries.set(context.subject, entry);
  }
  entry.active = true; entry.count++; entry.until = now + 5000;
  return () => { entry.active = false; };
}

async function boundedJson(response: Response, signal: AbortSignal) {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 131_072)) { void response.body?.cancel(); throw new Error('wallet_funding_provider_unavailable'); }
  if (!response.body) throw new Error('wallet_funding_provider_unavailable');
  const reader = response.body.getReader(); let size = 0; const parts: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error('wallet_funding_provider_unavailable');
      const next = await reader.read(); if (signal.aborted) throw new Error('wallet_funding_provider_unavailable');
      if (next.done) break; size += next.value.byteLength;
      if (size > 131_072) { cancel(); throw new Error('wallet_funding_provider_unavailable'); } parts.push(next.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
async function requestJson(path: string, key: string, fetchImpl: typeof fetch, signal: AbortSignal) {
  if (signal.aborted) throw new Error('wallet_funding_provider_unavailable');
  const response = await new Promise<Response>((resolve, reject) => {
    const abort = () => reject(new Error('wallet_funding_provider_unavailable'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => fetchImpl(`https://api-sb.meld.io${path}`, { method: 'GET', redirect: 'error', signal,
      headers: { Authorization: `BASIC ${key}`, Accept: 'application/json', 'Meld-Version': '2026-02-03' } }))
      .then(value => { if (signal.aborted) void value.body?.cancel(); resolve(value); }, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
  if (!response.ok) { void response.body?.cancel(); throw new Error('wallet_funding_provider_unavailable'); }
  return boundedJson(response, signal);
}

/** Reject every mismatch before recording a test result. Never derive identity from provider customer data. */
export function validateSandboxTransaction(data: unknown, context: SandboxContext, accountId: string, transactionId: string) {
  const tx = z.object({ transaction: z.object({ id: identifier, accountId: identifier, sessionId: identifier,
    externalSessionId: reference, externalCustomerId: reference, serviceProvider: z.enum(['TRANSAK', 'BANXA']),
    transactionType: z.literal('CRYPTO_PURCHASE'), countryCode: z.string(), sourceCurrencyCode: z.string(), paymentMethodType: z.string(),
    sourceAmount: z.number().finite().positive().max(1_000_000_000), destinationCurrencyCode: z.literal('USDT_POLYGON'),
    destinationAmount: z.number().finite().nonnegative().max(1_000_000_000), status: statuses, updatedAt: instant,
    cryptoDetails: z.object({ destinationWalletAddress: z.string().regex(/^0x[0-9a-f]{40}$/i), chainId: z.union([z.literal('137'), z.literal(137)]) }),
  }) }).parse(data).transaction;
  if (tx.id !== transactionId || tx.accountId !== accountId || Math.abs(tx.destinationAmount * 1e6 - Math.round(tx.destinationAmount * 1e6)) > 0.00001
    || (tx.status === 'SETTLED' && tx.destinationAmount <= 0)) throw new Error('wallet_funding_provider_unavailable');
  const p = proofInput.parse({ transactionId: tx.id, accountId: tx.accountId, sessionId: tx.sessionId,
    externalSessionId: tx.externalSessionId, externalCustomerId: tx.externalCustomerId, serviceProvider: tx.serviceProvider,
    countryCode: tx.countryCode, sourceCurrencyCode: tx.sourceCurrencyCode, sourceAmount: tx.sourceAmount.toFixed(2),
    paymentMethodType: tx.paymentMethodType,
    destinationCurrencyCode: tx.destinationCurrencyCode, walletAddress: tx.cryptoDetails.destinationWalletAddress.toLowerCase(), chainId: '137',
    providerStatus: tx.status, providerUpdatedAt: tx.updatedAt, receivedAmount: tx.destinationAmount.toFixed(6).replace(/\.?0+$/, '') || '0' });
  if (Math.abs(tx.sourceAmount * 100 - Math.round(tx.sourceAmount * 100)) > 0.000001 || !matchesContext(p, context)) {
    throw new Error('wallet_funding_provider_unavailable');
  }
  return p;
}

export async function reconcileSandboxContext(database: SandboxDatabase, context: SandboxContext,
  dependencies: SandboxReconciliationDependencies = {}, webhookTransactionId?: string): Promise<SandboxConfirmation> {
  const { environment = process.env, fetchImpl = fetch, signal, now = Date.now, timeoutMs = 8000 } = dependencies;
  const previous = contextProof(context);
  const key = environment.MELD_API_SANDBOX, accountId = environment.MELD_ACCOUNT_ID;
  if (environment.MELD_ADMIN_SANDBOX_ENABLED !== 'true' || !key || key.length > 2048 || /\s/.test(key)
    || !identifier.safeParse(accountId).success || !context.provider_session_id) return previous ? sandboxProofConfirmation(previous) : unconfirmed();
  if (previous && previous.accountId !== accountId) throw new Error('wallet_funding_provider_unavailable');
  const instantNow = now(); if (!Number.isFinite(instantNow)) throw new Error('wallet_funding_provider_unavailable');
  const release = acquire(database, context, instantNow);
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.min(Math.max(timeoutMs, 1), 15_000));
  try {
    let transactionId = webhookTransactionId || previous?.transactionId;
    if (transactionId && !identifier.safeParse(transactionId).success) throw new Error('wallet_funding_provider_unavailable');
    if (!transactionId) {
      const query = new URLSearchParams({ externalSessionIds: context.id, sessionIds: context.provider_session_id,
        externalCustomerIds: context.customer_reference, serviceProviders: context.service_provider, types: 'CRYPTO_PURCHASE', limit: '2' });
      const result = z.object({ transactions: z.array(z.object({ id: identifier })).max(1) }).parse(
        await requestJson(`/payments/transactions?${query}`, key, fetchImpl, controller.signal));
      if (!result.transactions.length) return previous ? sandboxProofConfirmation(previous) : unconfirmed();
      transactionId = result.transactions[0]!.id;
    }
    const proof = validateSandboxTransaction(await requestJson(`/payments/transactions/${encodeURIComponent(transactionId)}`,
      key, fetchImpl, controller.signal), context, accountId!, transactionId);
    if (previous && previous.transactionId !== proof.transactionId) throw new Error('wallet_funding_provider_unavailable');
    const serialized = JSON.stringify(proof), hash = createHash('sha256').update(serialized).digest('hex');
    const rows = await database.execute<{ proof: unknown }>(sql`SELECT payments.record_meld_sandbox_proof(
      ${context.subject},${context.id}::uuid,${serialized}::jsonb,${hash}) AS proof`);
    const saved = proofInput.parse(rows[0]?.proof);
    if (!matchesContext(saved, context) || saved.accountId !== accountId || saved.transactionId !== proof.transactionId) throw new Error('wallet_funding_unavailable');
    return sandboxProofConfirmation(saved);
  } catch { throw new Error('wallet_funding_provider_unavailable'); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); release(); }
}

export async function reconcileAdministrativeSandboxFunding(database: SandboxDatabase,
  input: { subject: string; checkoutReference: string }, dependencies: SandboxReconciliationDependencies = {}) {
  const subject = z.string().min(1).max(255).parse(input.subject), checkoutReference = reference.parse(input.checkoutReference).toLowerCase();
  const rows = await database.execute(sql`SELECT * FROM payments.read_meld_sandbox_reconciliation_context(${subject},${checkoutReference}::uuid)`);
  if (!rows.length) throw new Error('wallet_funding_not_found');
  if (rows.length !== 1) throw new Error('wallet_funding_unavailable');
  const parsed = sandboxContextInput.safeParse(rows[0]);
  if (!parsed.success) throw new Error('wallet_funding_unavailable');
  const context = parsed.data;
  if (context.id !== checkoutReference || context.subject !== subject) throw new Error('wallet_funding_forbidden');
  return reconcileSandboxContext(database, context, dependencies);
}

/** One owner-scoped cached read for history, without any provider requests. */
export async function readAdministrativeSandboxConfirmations(database: SandboxDatabase,
  input: { subject: string; checkoutReferences: string[] }) {
  const subject = z.string().min(1).max(255).parse(input.subject);
  const ids = z.array(reference).max(50).parse(input.checkoutReferences).map(id => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new Error('wallet_funding_invalid_reference');
  const result = new Map<string, SandboxConfirmation>(); if (!ids.length) return result;
  const rows = await database.execute<{ id: string; proof: unknown }>(sql`SELECT * FROM payments.read_meld_sandbox_confirmations(
    ${subject},${sql.param(ids)}::uuid[])`);
  if (rows.length > ids.length) throw new Error('wallet_funding_unavailable');
  for (const row of rows) {
    const parsed = proofInput.safeParse(row.proof);
    if (!parsed.success) throw new Error('wallet_funding_unavailable');
    const p = parsed.data;
    if (!ids.includes(row.id) || result.has(row.id) || p.externalSessionId !== row.id) throw new Error('wallet_funding_unavailable');
    result.set(row.id, sandboxProofConfirmation(p));
  }
  return result;
}
