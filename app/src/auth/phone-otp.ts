import { createHmac, timingSafeEqual } from 'node:crypto';
import type { GenericEndpointContext } from '@better-auth/core';
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
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

export async function consumePhoneOTP(secret: string, phone: string, code: string, ctx?: GenericEndpointContext) {
  if (!ctx || !validPhone(phone)) return false;
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

/** Replace the installed plugin's verifier/cleanup, not its schema or sender. */
export function securePhoneVerifyEndpoint(secret: string) {
  return createAuthEndpoint('/phone-number/verify', { method: 'POST', body: z.object({
    phoneNumber: z.string().refine(validPhone), code: z.string(),
    disableSession: z.boolean().optional(), updatePhoneNumber: z.boolean().optional(),
  }) }, async ctx => {
    const { phoneNumber: phone, code, disableSession, updatePhoneNumber } = ctx.body;
    const current = updatePhoneNumber ? await getSessionFromCtx(ctx) : null;
    if (updatePhoneNumber && !current) throw new APIError('UNAUTHORIZED', { message: 'Session required' });
    const owner = await ctx.context.adapter.findOne<{ id: string; emailVerified: boolean }>({ model: 'user', where: [{ field: 'phoneNumber', value: phone }] });
    if (updatePhoneNumber && owner && owner.id !== current!.user.id) throw new APIError('BAD_REQUEST', { message: 'Invalid verification' });
    const userId = updatePhoneNumber ? current!.user.id : owner?.id;
    if (!userId) throw new APIError('BAD_REQUEST', { message: 'Invalid verification' });
    if (!disableSession && !(updatePhoneNumber ? current!.user.emailVerified : owner!.emailVerified)) throw new APIError('FORBIDDEN', { message: 'Verify email before signing in' });
    if (!await consumePhoneOTP(secret, phone, code, ctx)) throw new APIError('BAD_REQUEST', { message: 'Invalid verification' });
    const user = await ctx.context.internalAdapter.updateUser(userId, { phoneNumber: phone, phoneNumberVerified: true });
    if (!user) throw new APIError('BAD_REQUEST', { message: 'Invalid verification' });
    const session = !disableSession ? current?.session || await ctx.context.internalAdapter.createSession(user.id) : null;
    if (!disableSession && !session) throw new APIError('FORBIDDEN', { message: 'Session unavailable' });
    if (session) await setSessionCookie(ctx, { session, user });
    return ctx.json({ status: true, token: session?.token || null, user: { id: user.id, email: user.email,
      emailVerified: user.emailVerified, name: user.name, phoneNumber: phone, phoneNumberVerified: true } });
  });
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
