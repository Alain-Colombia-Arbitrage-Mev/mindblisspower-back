import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';

export const MELD_WEBHOOK_PATH = '/api/webhooks/meld';
export const MELD_WEBHOOK_MAX_BYTES = 128 * 1024;
export const MELD_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

const eventTypes = z.enum([
  'TRANSACTION_CRYPTO_PENDING',
  'TRANSACTION_CRYPTO_TRANSFERRING',
  'TRANSACTION_CRYPTO_COMPLETE',
  'TRANSACTION_CRYPTO_FAILED',
]);
const optionalIdentifier = z.string().min(1).max(128).optional();
const eventInput = z.object({
  eventType: eventTypes,
  eventId: z.string().min(1).max(128),
  timestamp: z.string().min(1).max(64),
  accountId: z.string().min(1).max(128),
  profileId: z.string().min(1).max(128),
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payload: z.object({
    requestId: optionalIdentifier,
    externalCustomerId: optionalIdentifier,
    externalSessionId: optionalIdentifier,
    paymentTransactionId: optionalIdentifier,
    paymentTransactionStatus: z.string().min(1).max(64).optional(),
    transactionType: z.enum(['CRYPTO_PURCHASE', 'CRYPTO_SELL', 'CRYPTO_TRANSFER']).optional(),
  }).passthrough(),
}).passthrough();

export type MeldWebhookEvent = z.infer<typeof eventInput>;

function configuredUrl(value: string | undefined) {
  if (!value) throw new Error('meld_webhook_unconfigured');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
    || url.pathname !== MELD_WEBHOOK_PATH || url.href !== `${url.origin}${MELD_WEBHOOK_PATH}`) {
    throw new Error('meld_webhook_unconfigured');
  }
  return url.href;
}

function signatureBytes(value: string | undefined) {
  if (!value || value.length > 128 || !/^[A-Za-z0-9_-]{43}={0,1}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value.replace(/=+$/, ''), 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value.replace(/=+$/, '') ? decoded : null;
  } catch { return null; }
}

export function verifyMeldWebhook(input: {
  rawBody: string;
  signature?: string;
  signatureTimestamp?: string;
  secret?: string;
  publicUrl?: string;
  accountId?: string;
  profileId?: string;
  now?: number;
}) {
  const secret = input.secret || '';
  if (secret.length < 24 || secret.length > 512 || /[\r\n]/.test(secret)) throw new Error('meld_webhook_unconfigured');
  const timestamp = input.signatureTimestamp || '';
  const timestampMs = Date.parse(timestamp);
  const now = input.now ?? Date.now();
  if (!timestamp || timestamp.length > 64 || !Number.isFinite(timestampMs)
    || !Number.isFinite(now) || Math.abs(now - timestampMs) > MELD_WEBHOOK_TOLERANCE_MS) {
    throw new Error('invalid_meld_signature');
  }
  const supplied = signatureBytes(input.signature);
  if (!supplied) throw new Error('invalid_meld_signature');
  const url = configuredUrl(input.publicUrl);
  const expected = createHmac('sha256', secret).update(`${timestamp}.${url}.${input.rawBody}`, 'utf8').digest();
  if (!timingSafeEqual(expected, supplied)) throw new Error('invalid_meld_signature');
  const event = eventInput.parse(JSON.parse(input.rawBody));
  if (input.accountId && event.accountId !== input.accountId) throw new Error('invalid_meld_account');
  if (input.profileId && event.profileId !== input.profileId) throw new Error('invalid_meld_profile');
  const eventTimestamp = new Date(event.timestamp);
  if (!Number.isFinite(eventTimestamp.getTime())) throw new Error('invalid_meld_event');
  return { event, eventTimestamp, bodySha256: createHash('sha256').update(input.rawBody, 'utf8').digest('hex') };
}

export async function captureMeldWebhookEvent(database: Pick<IdentityDatabase, 'execute'>, input: {
  event: MeldWebhookEvent;
  eventTimestamp: Date;
  bodySha256: string;
  rawBody: string;
}) {
  const externalCustomerId = z.string().uuid().safeParse(input.event.payload.externalCustomerId);
  const externalSessionId = z.string().uuid().safeParse(input.event.payload.externalSessionId);
  const rows = await database.execute<{ inserted: boolean }>(sql`
    SELECT payments.capture_meld_webhook_event(
      ${input.event.eventId},${input.event.eventType},${input.eventTimestamp},${input.event.accountId},${input.event.profileId},
      ${input.event.version}::date,${externalCustomerId.success ? externalCustomerId.data : null}::uuid,
      ${externalSessionId.success ? externalSessionId.data : null}::uuid,
      ${input.event.payload.paymentTransactionId ?? null},${input.event.payload.paymentTransactionStatus ?? null},
      ${input.event.payload.transactionType ?? null},${input.bodySha256},${input.rawBody}::jsonb
    ) AS inserted`);
  return { inserted: rows[0]?.inserted === true };
}
