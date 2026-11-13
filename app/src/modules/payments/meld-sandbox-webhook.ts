import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { reconcileSandboxContext, sandboxContextInput, type SandboxDatabase,
  type SandboxReconciliationDependencies } from './meld-sandbox-reconciliation';
import { handleVerifiedMeldCheckoutWebhook } from './meld-sandbox-checkout-reconciliation';
import { handleVerifiedAdministrativeOfframpWebhook } from './administrative-offramp-status';

const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).refine(value => value !== '.' && value !== '..');
const eventTypes = z.enum(['WEBHOOK_TEST', 'TRANSACTION_CRYPTO_PENDING', 'TRANSACTION_CRYPTO_TRANSFERRING',
  'TRANSACTION_CRYPTO_COMPLETE', 'TRANSACTION_CRYPTO_FAILED']);
const input = z.object({ eventId: identifier, eventType: z.string().regex(/^[A-Z0-9_]{2,80}$/), timestamp: z.string().datetime({ offset: true }),
  accountId: identifier, profileId: identifier.nullable(), version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payload: z.object({ externalSessionId: identifier.optional(), externalCustomerId: identifier.optional(),
    sessionId: identifier.optional(), paymentTransactionId: identifier.optional(),
    transactionType: z.enum(['CRYPTO_PURCHASE', 'CRYPTO_SELL', 'CRYPTO_TRANSFER']).optional() }).passthrough(),
}).passthrough();

export function verifySandboxMeldWebhook(rawBody: string, headers: { signature?: string; signatureTimestamp?: string },
  environment: Record<string, string | undefined>, now = Date.now()) {
  const key = environment.MELD_WEBHOOK_SIGNING_KEY, account = environment.MELD_ACCOUNT_ID, profile = environment.MELD_WEBHOOK_PROFILE_ID;
  const url = environment.MELD_WEBHOOK_PUBLIC_URL;
  if (environment.MELD_WEBHOOK_ENABLED !== 'true' || environment.MELD_ADMIN_SANDBOX_ENABLED !== 'true'
    || !key || key.length < 24 || key.length > 512 || /[\r\n]/.test(key)
    || !identifier.safeParse(account).success || !identifier.safeParse(profile).success
    || url !== 'https://wallet.mindblisspower.com/api/webhooks/meld') throw new Error('meld_webhook_unconfigured');
  if (Buffer.byteLength(rawBody, 'utf8') > 131_072) throw new Error('invalid_meld_event');
  const signature = headers.signature || '', timestamp = headers.signatureTimestamp || '';
  if (!/^[A-Za-z0-9_-]{43}={0,1}$/.test(signature) || timestamp.length > 64
    || !Number.isFinite(now) || !Number.isFinite(Date.parse(timestamp)) || Math.abs(Date.parse(timestamp) - now) > 300_000) {
    throw new Error('invalid_meld_signature');
  }
  const bytes = Buffer.from(signature.replace(/=+$/, ''), 'base64url');
  const expected = createHmac('sha256', key).update(`${timestamp}.${url}.${rawBody}`, 'utf8').digest();
  if (bytes.length !== 32 || bytes.toString('base64url') !== signature.replace(/=+$/, '') || !timingSafeEqual(bytes, expected)) {
    throw new Error('invalid_meld_signature');
  }
  const event = input.parse(JSON.parse(rawBody));
  if (event.accountId !== account || (event.eventType === 'WEBHOOK_TEST'
    ? event.profileId !== null && event.profileId !== profile : event.profileId !== profile)) throw new Error('invalid_meld_profile');
  return { event, bodySha256: createHash('sha256').update(rawBody, 'utf8').digest('hex') };
}

export async function handleSandboxMeldWebhook(database: SandboxDatabase,
  rawBody: string, headers: { signature?: string; signatureTimestamp?: string },
  dependencies: SandboxReconciliationDependencies = {}): Promise<{ received: boolean; ignored?: boolean; duplicate?: boolean; mode: string }> {
  const { environment = process.env, now = Date.now } = dependencies;
  const { event, bodySha256 } = verifySandboxMeldWebhook(rawBody, headers, environment, now());
  if (!eventTypes.safeParse(event.eventType).success) return { received: true, ignored: true, mode: 'sandbox_only' };
  if (event.payload.transactionType === 'CRYPTO_SELL' && event.eventType !== 'WEBHOOK_TEST') {
    return handleVerifiedAdministrativeOfframpWebhook(database, event, dependencies);
  }
  let context;
  if (event.eventType !== 'WEBHOOK_TEST') {
    const p = event.payload;
    // Meld documents an early PENDING_CREATED event without its session. It is
    // not proof of a specific user's attempt and must never create one.
    if (!z.string().uuid().safeParse(p.externalSessionId).success || !z.string().uuid().safeParse(p.externalCustomerId).success
      || !p.sessionId || !p.paymentTransactionId || p.transactionType !== 'CRYPTO_PURCHASE') {
      return { received: true, ignored: true, mode: 'sandbox_only' };
    }
    const rows = await database.execute(sql`SELECT * FROM payments.read_meld_sandbox_webhook_context(
      ${p.externalSessionId}::uuid,${p.externalCustomerId}::uuid,${p.sessionId})`);
    if (!rows.length) return handleVerifiedMeldCheckoutWebhook(database, { ...event, bodySha256 }, dependencies);
    if (rows.length !== 1) throw new Error('invalid_meld_event');
    const parsed = sandboxContextInput.safeParse(rows[0]);
    if (!parsed.success) throw new Error('wallet_funding_unavailable');
    context = parsed.data;
    if (context.id !== p.externalSessionId || context.customer_reference !== p.externalCustomerId || context.provider_session_id !== p.sessionId) {
      throw new Error('invalid_meld_event');
    }
  }
  const receipts = await database.execute<{ inserted: boolean }>(sql`SELECT payments.record_meld_sandbox_webhook_receipt(
    ${event.eventId},${event.eventType},${event.timestamp}::timestamptz,${event.accountId},${event.profileId},
    ${bodySha256},${context?.id ?? null}::uuid) AS inserted`);
  if (receipts.length !== 1 || typeof receipts[0]?.inserted !== 'boolean') throw new Error('invalid_meld_event');
  if (context) {
    // Retry GET even for a duplicate receipt: a prior delivery may have been
    // captured immediately before its independent API read failed.
    await reconcileSandboxContext(database, context, dependencies, event.payload.paymentTransactionId);
  }
  return { received: true, duplicate: !receipts[0].inserted, mode: 'sandbox_only' };
}
