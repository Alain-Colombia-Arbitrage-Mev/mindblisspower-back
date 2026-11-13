import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireMeldCheckoutConfiguration } from './meld-sandbox-checkout';
import { sandboxProofConfirmation, validateSandboxTransaction, type SandboxDatabase,
  type SandboxReconciliationDependencies } from './meld-sandbox-reconciliation';

const uuid = z.string().uuid();
const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).refine(v => v !== '.' && v !== '..');
const provider = z.enum(['BANXA', 'TRANSAK']);
const contextInput = z.object({ id: uuid, subject: z.string().min(1).max(255), account_id: identifier, customer_reference: uuid,
  wallet_address: z.string().regex(/^0x[0-9a-f]{40}$/), country_code: z.enum(['US', 'MX', 'CO']),
  requested_amount: z.coerce.number().finite().min(1).max(10_000_000), source_currency: z.enum(['USD', 'MXN']),
  status: z.enum(['initiated', 'minted', 'unavailable']), created_at: z.coerce.date(), provider_session_id: identifier.nullable(),
  transaction_id: identifier.nullable(), proof: z.unknown().nullable(), checked_at: z.coerce.date().nullable(),
});
export type MeldCheckoutContext = z.infer<typeof contextInput>;
function context(value: unknown) {
  const parsed = contextInput.safeParse(value);
  if (!parsed.success) throw new Error('wallet_funding_unavailable');
  const r = parsed.data;
  if ((r.source_currency === 'USD' ? r.requested_amount < 50 || r.requested_amount > 25_000 : r.country_code !== 'MX')
    || Math.abs(r.requested_amount * 100 - Math.round(r.requested_amount * 100)) > 0.000001) throw new Error('wallet_funding_unavailable');
  return r;
}
const empty = () => ({ state: 'unconfirmed' as const, source: 'none' as const, testMode: true as const });
function independentProof(value: unknown, row: MeldCheckoutContext, expectedId: string, expectedSession?: string) {
  const candidate = z.object({ transaction: z.object({ sessionId: identifier, serviceProvider: provider,
    paymentMethodType: z.string().regex(/^[A-Z0-9_]{2,40}$/) }) }).parse(value).transaction;
  if ((row.provider_session_id && candidate.sessionId !== row.provider_session_id)
    || (expectedSession && candidate.sessionId !== expectedSession) || (row.transaction_id && row.transaction_id !== expectedId)) {
    throw new Error('wallet_funding_provider_unavailable');
  }
  // These three initially unknown fields come only from the independent GET.
  // Every pre-existing owner, account, address, amount and external reference
  // remains fixed by our intent. SQL pins the first proven session atomically.
  return validateSandboxTransaction(value, { ...row, service_provider: candidate.serviceProvider,
    payment_method: candidate.paymentMethodType, provider_session_id: candidate.sessionId }, row.account_id, expectedId);
}
function cachedProof(row: MeldCheckoutContext) {
  try {
  if (row.proof === null) {
    if (row.provider_session_id !== null || row.transaction_id !== null) throw new Error('wallet_funding_unavailable');
    return null;
  }
  const p = z.object({ transactionId: identifier, accountId: identifier, sessionId: identifier, externalSessionId: uuid,
    externalCustomerId: uuid, serviceProvider: provider, paymentMethodType: z.string(), countryCode: z.string(),
    sourceCurrencyCode: z.string(), sourceAmount: z.string().regex(/^\d{1,10}\.\d{2}$/), destinationCurrencyCode: z.string(),
    walletAddress: z.string(), chainId: z.string(), providerStatus: z.string(), providerUpdatedAt: z.string(),
    receivedAmount: z.string().regex(/^\d{1,12}(?:\.\d{1,6})?$/) }).strict().parse(row.proof);
  if (row.transaction_id !== p.transactionId || row.provider_session_id !== p.sessionId) throw new Error('wallet_funding_unavailable');
  return independentProof({ transaction: { id: p.transactionId, accountId: p.accountId, sessionId: p.sessionId,
    externalSessionId: p.externalSessionId, externalCustomerId: p.externalCustomerId, serviceProvider: p.serviceProvider,
    transactionType: 'CRYPTO_PURCHASE', countryCode: p.countryCode, sourceCurrencyCode: p.sourceCurrencyCode,
    sourceAmount: Number(p.sourceAmount), destinationCurrencyCode: p.destinationCurrencyCode,
    destinationAmount: Number(p.receivedAmount), paymentMethodType: p.paymentMethodType, status: p.providerStatus,
    updatedAt: p.providerUpdatedAt, cryptoDetails: { destinationWalletAddress: p.walletAddress, chainId: p.chainId } } }, row, p.transactionId);
  } catch { throw new Error('wallet_funding_unavailable'); }
}
function confirmation(row: MeldCheckoutContext) {
  const proof = cachedProof(row);
  return proof ? { ...sandboxProofConfirmation(proof), serviceProvider: proof.serviceProvider, paymentMethodType: proof.paymentMethodType } : empty();
}
function snapshot(row: MeldCheckoutContext) {
  return { checkoutReference: row.id, walletKind: 'administrative' as const, environment: 'sandbox' as const, provider: 'meld' as const,
    checkoutType: 'meld_checkout' as const, requestStatus: row.status, requestedAmount: row.requested_amount,
    sourceCurrencyCode: row.source_currency, country: row.country_code, createdAt: row.created_at.toISOString(),
    destination: { address: row.wallet_address, asset: 'USDT' as const, network: 'polygon' as const, chainId: 137 as const },
    confirmation: confirmation(row) };
}
const gates = new WeakMap<SandboxDatabase, Map<string, { active: boolean; count: number; until: number; reset: number }>>();
function acquire(db: SandboxDatabase, owner: string, now: number) {
  let entries = gates.get(db); if (!entries) { entries = new Map(); gates.set(db, entries); }
  for (const [key, value] of entries) if (!value.active && value.reset <= now) entries.delete(key);
  let entry = entries.get(owner);
  if (!Number.isFinite(now) || entry?.active || (entry && (entry.until > now || entry.count >= 30))) throw new Error('wallet_funding_rate_limited');
  if (!entry) { if (entries.size >= 10_000) throw new Error('wallet_funding_rate_limited');
    entry = { active: false, count: 0, until: 0, reset: now + 600_000 }; entries.set(owner, entry); }
  entry.active = true; entry.count++; entry.until = now + 5000; return () => { entry.active = false; };
}
function bounded<T>(operation: () => Promise<T>, signal: AbortSignal, late?: (value: T) => void) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(new Error('wallet_funding_provider_unavailable')); };
    if (signal.aborted) { abort(); return; } signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw new Error('wallet_funding_provider_unavailable'); return operation(); })
      .then(value => { if (settled) { late?.(value); return; } settled = true; signal.removeEventListener('abort', abort); resolve(value); },
        error => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function jsonGet(path: string, key: string, fetchImpl: typeof fetch, signal: AbortSignal) {
  const response = await bounded(() => fetchImpl(`https://api-sb.meld.io${path}`, { method: 'GET', redirect: 'error', signal,
    headers: { Authorization: `BASIC ${key}`, Accept: 'application/json', 'Meld-Version': '2026-02-03' } }), signal,
    value => { try { void value.body?.cancel().catch(() => {}); } catch { /* late/locked stream */ } });
  const length = response.headers.get('content-length');
  if (!response.ok || (length && (!/^\d+$/.test(length) || Number(length) > 131_072)) || !response.body) {
    void response.body?.cancel(); throw new Error('wallet_funding_provider_unavailable');
  }
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  try { for (;;) {
    if (signal.aborted) throw new Error('wallet_funding_provider_unavailable');
    const next = await bounded(() => reader.read(), signal); if (signal.aborted) throw new Error('wallet_funding_provider_unavailable');
    if (next.done) break; bytes += next.value.byteLength; if (bytes > 131_072) throw new Error('wallet_funding_provider_unavailable'); parts.push(next.value);
  } return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) as unknown;
  } finally { signal.removeEventListener('abort', cancel); cancel(); try { reader.releaseLock(); } catch { /* Faulty/late reader; deadline already won. */ } }
}
export async function reconcileMeldCheckoutContext(db: SandboxDatabase, row: MeldCheckoutContext,
  dependencies: SandboxReconciliationDependencies = {}, event?: { transactionId: string; sessionId: string }) {
  const { environment = process.env, fetchImpl = fetch, now = Date.now, signal, timeoutMs = 8000 } = dependencies;
  requireMeldCheckoutConfiguration(environment);
  if (environment.MELD_ACCOUNT_ID !== row.account_id) throw new Error('wallet_funding_unconfigured');
  cachedProof(row); // Corrupt or foreign cached evidence must never trigger discovery.
  if (row.status !== 'minted') return snapshot(row);
  if (event && (!identifier.safeParse(event.transactionId).success || !identifier.safeParse(event.sessionId).success
    || (row.transaction_id && event.transactionId !== row.transaction_id) || (row.provider_session_id && event.sessionId !== row.provider_session_id))) {
    throw new Error('wallet_funding_provider_unavailable');
  }
  const release = acquire(db, row.subject, now()), controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.min(Math.max(timeoutMs, 1), 15_000));
  try {
    let id = event?.transactionId || row.transaction_id;
    if (!id) {
      const query = new URLSearchParams({ externalSessionIds: row.id, externalCustomerIds: row.customer_reference,
        serviceProviders: 'BANXA,TRANSAK', types: 'CRYPTO_PURCHASE', limit: '2' });
      const list = z.object({ transactions: z.array(z.object({ id: identifier })).max(1),
        remaining: z.number().int().min(0).max(0).optional(), totalCount: z.number().int().min(0).max(1).optional() }).parse(
        await jsonGet(`/payments/transactions?${query}`, environment.MELD_API_SANDBOX!, fetchImpl, controller.signal));
      if (!list.transactions.length) return snapshot(row); id = list.transactions[0]!.id;
    }
    const proof = independentProof(await jsonGet(`/payments/transactions/${encodeURIComponent(id)}`, environment.MELD_API_SANDBOX!, fetchImpl, controller.signal), row, id, event?.sessionId);
    const serialized = JSON.stringify(proof), hash = createHash('sha256').update(serialized).digest('hex');
    const rows = await db.execute<{ proof: unknown }>(sql`SELECT payments.record_meld_checkout_proof(${row.subject},${row.id}::uuid,${serialized}::jsonb,${hash}) AS proof`);
    if (rows.length !== 1) throw new Error('wallet_funding_unavailable');
    const next = context({ ...row, proof: rows[0]!.proof, transaction_id: id, provider_session_id: proof.sessionId });
    return snapshot(next);
  } catch { throw new Error('wallet_funding_provider_unavailable'); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); release(); }
}
export async function readMeldCheckoutStatus(db: SandboxDatabase, input: { subject: string; checkoutReference: string },
  dependencies: SandboxReconciliationDependencies = {}) {
  requireMeldCheckoutConfiguration(dependencies.environment ?? process.env);
  const owner = z.string().min(1).max(255).parse(input.subject), ref = uuid.parse(input.checkoutReference).toLowerCase();
  const rows = await db.execute(sql`SELECT * FROM payments.read_meld_checkout_context(${owner},${ref}::uuid)`);
  if (!rows.length) throw new Error('wallet_funding_not_found'); if (rows.length !== 1) throw new Error('wallet_funding_unavailable');
  const row = context(rows[0]); if (row.subject !== owner || row.id !== ref) throw new Error('wallet_funding_forbidden');
  return reconcileMeldCheckoutContext(db, row, dependencies);
}
export async function readMeldCheckoutHistory(db: SandboxDatabase, subject: string,
  dependencies: Pick<SandboxReconciliationDependencies, 'environment'> = {}) {
  requireMeldCheckoutConfiguration(dependencies.environment ?? process.env);
  const owner = z.string().min(1).max(255).parse(subject);
  const rows = await db.execute(sql`SELECT * FROM payments.read_meld_checkout_history(${owner})`);
  if (rows.length > 20) throw new Error('wallet_funding_unavailable');
  const records = rows.map(value => { const row = context(value); if (row.subject !== owner) throw new Error('wallet_funding_forbidden'); return snapshot(row); });
  if (new Set(records.map(r => r.checkoutReference)).size !== records.length) throw new Error('wallet_funding_unavailable');
  return { walletKind: 'administrative' as const, environment: 'sandbox' as const, provider: 'meld' as const,
    checkoutType: 'meld_checkout' as const, settlement: 'unconfirmed' as const, records };
}
/** Called only after the shared ingress has authenticated the exact raw webhook. */
export async function handleVerifiedMeldCheckoutWebhook(db: SandboxDatabase, input: {
  eventId: string; eventType: string; timestamp: string; accountId: string; profileId: string | null; bodySha256: string;
  payload: { externalSessionId?: string; externalCustomerId?: string; sessionId?: string; paymentTransactionId?: string; transactionType?: string };
}, dependencies: SandboxReconciliationDependencies = {}) {
  const env = dependencies.environment ?? process.env;
  try { requireMeldCheckoutConfiguration(env); } catch { return { received: true, ignored: true, mode: 'sandbox_only' }; }
  const p = input.payload;
  if (input.accountId !== env.MELD_ACCOUNT_ID || input.profileId !== env.MELD_WEBHOOK_PROFILE_ID
    || !uuid.safeParse(p.externalSessionId).success || !uuid.safeParse(p.externalCustomerId).success
    || !identifier.safeParse(p.sessionId).success || !identifier.safeParse(p.paymentTransactionId).success || p.transactionType !== 'CRYPTO_PURCHASE') {
    return { received: true, ignored: true, mode: 'sandbox_only' };
  }
  const rows = await db.execute(sql`SELECT * FROM payments.read_meld_checkout_webhook_context(${p.externalSessionId}::uuid,${p.externalCustomerId}::uuid)`);
  if (!rows.length) return { received: true, ignored: true, mode: 'sandbox_only' };
  if (rows.length !== 1) throw new Error('wallet_funding_unavailable');
  const row = context(rows[0]);
  if (row.id !== p.externalSessionId || row.customer_reference !== p.externalCustomerId || row.account_id !== input.accountId
    || (row.provider_session_id && row.provider_session_id !== p.sessionId) || (row.transaction_id && row.transaction_id !== p.paymentTransactionId)) {
    throw new Error('wallet_funding_provider_unavailable');
  }
  const result = await db.execute<{ inserted: boolean }>(sql`SELECT payments.record_meld_checkout_webhook_receipt(${input.eventId},${input.eventType},
    ${input.timestamp}::timestamptz,${input.accountId},${input.profileId},${input.bodySha256},${row.id}::uuid) AS inserted`);
  if (result.length !== 1 || typeof result[0]?.inserted !== 'boolean') throw new Error('wallet_funding_unavailable');
  await reconcileMeldCheckoutContext(db, row, dependencies, { transactionId: p.paymentTransactionId!, sessionId: p.sessionId! });
  return { received: true, duplicate: !result[0].inserted, mode: 'sandbox_only' };
}
