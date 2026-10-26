import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GenericEndpointContext } from '@better-auth/core';
import { APIError } from 'better-auth/api';
import { validPhone } from './delivery';

export const otpHash = (secret: string, purpose: string, code: string) => createHmac('sha256', secret).update(`${purpose}\0${code}`).digest('hex');

// 1.6.22's phone plugin lacks storeOTP. Intercept storage, not delivery, so the
// plaintext is never committed even if sending fails. Preserve hashed retries.
export function securePhoneVerification(secret: string, verification: { identifier: string; value: string }) {
  if (!validPhone(verification.identifier) && !/^\+[1-9][0-9]{7,14}-request-password-reset$/.test(verification.identifier)) return verification;
  const match = /^(\d{6})(?::(\d+))?$/.exec(verification.value);
  if (!match) {
    if (/^h1_[a-f0-9]{64}:\d+$/.test(verification.value)) return verification;
    throw new APIError('BAD_REQUEST', { message: 'Invalid verification state' });
  }
  return { ...verification, value: `h1_${otpHash(secret, `phone:${verification.identifier}`, match[1]!)}:${match[2] || '0'}` };
}

export async function consumePhoneOTP(secret: string, phone: string, code: string, ctx?: GenericEndpointContext, ownerBound = false) {
  if (!ctx || !(ownerBound ? /^sms-opt-in:[a-f0-9]{64}$/.test(phone) : validPhone(phone))) return false;
  const adapter = ctx.context.adapter;
  type Challenge = { id: string; value: string; expiresAt: Date };
  let current = (await adapter.findMany<Challenge>({ model: 'verification',
    where: [{ field: 'identifier', value: phone }], sortBy: { field: 'createdAt', direction: 'desc' }, limit: 1 }))[0];
  if (!current || current.expiresAt.getTime() <= Date.now()) return false;
  const generation = /^h1_([a-f0-9]{64}):(\d+)$/.exec(current.value);
  if (!generation) return false;
  const generationId = current.id;
  const generationHash = generation[1]!;
  const actual = Buffer.from(otpHash(secret, `phone:${phone}`, code), 'hex');
  const correct = /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(generationHash, 'hex'), actual);
  // Concurrent failures must each spend an attempt, not all write :0 -> :1.
  // At most three state changes can precede lockout. Reload ONLY this row ID
  // and hash after a lost CAS: a resend's new generation must remain untouched.
  for (let retry = 0; retry < 3; retry++) {
    if (!current || current.expiresAt.getTime() <= Date.now()) return false;
    const match = /^h1_([a-f0-9]{64}):(\d+)$/.exec(current.value);
    if (!match || match[1] !== generationHash || Number(match[2]) >= 3) return false;
    const where = [{ field: 'id', value: generationId }, { field: 'value', value: current.value },
      { field: 'expiresAt', operator: 'gt' as const, value: new Date() }];
    const attempts = Number(match[2]) + 1;
    const changed = correct || attempts >= 3
      ? await adapter.consumeOne({ model: 'verification', where })
      : await adapter.incrementOne({ model: 'verification', where, increment: {}, set: { value: `h1_${generationHash}:${attempts}` } });
    if (changed) return correct;
    current = await adapter.findOne<Challenge>({ model: 'verification', where: [
      { field: 'id', value: generationId }, { field: 'identifier', value: phone },
    ] }) ?? undefined;
  }
  return false;
}

// Per-recipient send cooldown in the same persistent, unique-key rate-limit
// model. Atomic conditional increments prevent parallel replicas bypassing it.
export const recipientBudgetKey = (secret: string, recipient: string) => `auth-recipient:${otpHash(secret, 'recipient', recipient.trim().toLowerCase())}`;

export async function limitRecipient(secret: string, recipient: string, ctx: GenericEndpointContext, cooldownMs = 60_000) {
  const key = recipientBudgetKey(secret, recipient);
  const adapter = ctx.context.adapter;
  const existing = await adapter.findOne<{ lastRequest: number }>({ model: 'rateLimit', where: [{ field: 'key', value: key }] });
  const now = Date.now();
  if (!existing) {
    try { await adapter.create({ model: 'rateLimit', data: { key, count: 1, lastRequest: now + cooldownMs } }); return; }
    catch { throw new APIError('TOO_MANY_REQUESTS', { message: 'Please wait before requesting another message' }); }
  }
  const changed = await adapter.incrementOne({ model: 'rateLimit', where: [{ field: 'key', value: key },
    { field: 'lastRequest', operator: 'lte', value: now }], increment: {}, set: { count: 1, lastRequest: now + cooldownMs } });
  if (!changed) throw new APIError('TOO_MANY_REQUESTS', { message: 'Please wait before requesting another message' });
}
