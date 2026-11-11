import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { companyPaymentAtomic, companyPaymentNetwork, COMPANY_PAYMENT_RECIPIENT } from './personal-company-rpc';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const subject = z.string().min(1).max(255);
export const COMPANY_CLIENT_EVENTS = ['wallet_prompt_opened', 'wallet_rejected', 'wallet_failed', 'broadcast_uncertain',
  'broadcast_observed', 'recovery_detected', 'registration_failed', 'verification_requested', 'verification_failed'] as const;
export const COMPANY_EVENT_CODES = ['user_rejected', 'wallet_changed', 'network_changed', 'rpc_unavailable',
  'registration_unavailable', 'verification_unavailable', 'recovery_unavailable', 'unknown'] as const;
const canonicalEvents = ['prepared', 'submitted', 'confirmed', 'failed', 'abandoned', 'snapshot'] as const;
const hashEvents = new Set(['broadcast_observed', 'recovery_detected', 'registration_failed', 'verification_requested', 'verification_failed']);

/** Browser statements are diagnostic evidence, never canonical payment transitions. */
export const companyPaymentEventInput = z.object({ eventId: uuid, paymentId: uuid, attemptId: uuid.optional(),
  event: z.enum(COMPANY_CLIENT_EVENTS), transactionHash: hash.optional(), code: z.enum(COMPANY_EVENT_CODES).optional(),
}).strict().superRefine((value, context) => {
  if ((value.transactionHash !== undefined && !hashEvents.has(value.event))
    || (value.event === 'broadcast_observed' && value.transactionHash === undefined)) {
    context.addIssue({ code: 'custom', message: 'invalid_event_evidence' });
  }
});
export const companyPaymentActivityInput = z.object({ paymentId: uuid.optional(), cursor: uuid.optional(),
  limit: z.number().int().min(1).max(50).default(20) }).strict();

const row = z.object({ event_id: uuid, payment_id: uuid, attempt_id: uuid.nullable(),
  source: z.enum(['canonical', 'client_reported']), event: z.enum([...canonicalEvents, ...COMPANY_CLIENT_EVENTS]),
  canonical_status: z.enum(['prepared', 'submitted', 'confirmed', 'failed']).nullable(),
  chain_id: z.union([z.literal(1), z.literal(137)]), token_address: address, wallet_address: address,
  recipient_address: z.literal(COMPANY_PAYMENT_RECIPIENT), amount_atomic: z.string().refine(companyPaymentAtomic),
  transaction_hash: hash.nullable(), code: z.enum(COMPANY_EVENT_CODES).nullable(), created_at: z.coerce.date() });
type EventRow = z.infer<typeof row>;
type Database = Pick<IdentityDatabase, 'execute'>;
type Options = { signal?: AbortSignal };
function active(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); }
function eventRow(value: unknown): EventRow {
  const parsed = row.safeParse(value);
  if (!parsed.success) throw new Error('company_payment_unavailable');
  const result = parsed.data;
  if (!companyPaymentNetwork(result.chain_id, result.token_address) || result.wallet_address === COMPANY_PAYMENT_RECIPIENT
    || (result.source === 'canonical' && (!(canonicalEvents as readonly string[]).includes(result.event) || result.attempt_id !== null || result.code !== null
      || result.canonical_status === null || (result.event !== 'snapshot' && result.canonical_status !== (result.event === 'abandoned' ? 'prepared' : result.event))
      || (result.canonical_status === 'prepared' ? result.transaction_hash !== null : result.transaction_hash === null)))
    || (result.source === 'client_reported' && (!(COMPANY_CLIENT_EVENTS as readonly string[]).includes(result.event)
      || result.canonical_status !== null || (result.transaction_hash !== null && !hashEvents.has(result.event)) || (result.event === 'broadcast_observed' && result.transaction_hash === null)))) {
    throw new Error('company_payment_unavailable');
  }
  return result;
}
function view(value: EventRow) {
  return { eventId: value.event_id, paymentId: value.payment_id, attemptId: value.attempt_id, source: value.source,
    event: value.event, canonicalStatus: value.canonical_status, chainId: value.chain_id, tokenAddress: value.token_address, tokenDecimals: 6 as const, walletAddress: value.wallet_address,
    recipientAddress: value.recipient_address, amountAtomic: value.amount_atomic, transactionHash: value.transaction_hash,
    code: value.code, recordedAt: value.created_at.toISOString() };
}

/** The SQL capability verifies owner and rate limit atomically; it cannot mutate a receipt. */
export async function recordPersonalCompanyPaymentEvent(database: Database, userId: string, raw: unknown, { signal }: Options = {}) {
  const owner = subject.parse(userId), input = companyPaymentEventInput.parse(raw);
  active(signal);
  const rows = await database.execute(sql`SELECT * FROM payments.record_personal_company_payment_event(
    ${owner},${input.paymentId}::uuid,${input.eventId}::uuid,${input.attemptId ?? null}::uuid,
    ${input.event},${input.transactionHash ?? null},${input.code ?? null})`);
  if (rows.length !== 1) throw new Error('company_payment_unavailable');
  const saved = eventRow(rows[0]);
  if (saved.source !== 'client_reported' || saved.event_id !== input.eventId || saved.payment_id !== input.paymentId
    || saved.attempt_id !== (input.attemptId ?? null) || saved.event !== input.event
    || saved.transaction_hash !== (input.transactionHash ?? null) || saved.code !== (input.code ?? null)) throw new Error('company_payment_unavailable');
  active(signal);
  return { walletKind: 'personal' as const, eventId: saved.event_id, paymentId: saved.payment_id, attemptId: saved.attempt_id,
    source: 'client_reported' as const, event: saved.event, recordedAt: saved.created_at.toISOString() };
}

/** Seek pagination reads only the authenticated owner's journal; cursors never select a different owner. */
export async function readPersonalCompanyPaymentActivity(database: Database, userId: string, raw: unknown, { signal }: Options = {}) {
  const owner = subject.parse(userId), input = companyPaymentActivityInput.parse(raw);
  active(signal);
  const rows = await database.execute(sql`SELECT * FROM payments.read_personal_company_payment_activity(
    ${owner},${input.paymentId ?? null}::uuid,${input.cursor ?? null}::uuid,${input.limit + 1})`);
  if (rows.length > input.limit + 1) throw new Error('company_payment_unavailable');
  const records = rows.map(eventRow);
  if (new Set(records.map(value => value.event_id)).size !== records.length
    || (input.paymentId && records.some(value => value.payment_id !== input.paymentId))) throw new Error('company_payment_unavailable');
  active(signal);
  const hasMore = records.length > input.limit, events = records.slice(0, input.limit).map(view);
  return { walletKind: 'personal' as const, ...(input.paymentId ? { paymentId: input.paymentId } : {}), events,
    nextCursor: hasMore ? events.at(-1)!.eventId : null };
}
