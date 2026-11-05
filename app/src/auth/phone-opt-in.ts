import { randomInt, randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import type { GenericEndpointContext } from '@better-auth/core';
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { z } from 'zod';
import { validPhone, type AuthDelivery } from './delivery';
import { consumePhoneOTP, limitRecipient, otpHash } from './phone-otp';

export const SMS_CONSENT_VERSION = 'sms-auth-v1';
const unavailable = () => new APIError('SERVICE_UNAVAILABLE', {
  code: 'SMS_OPT_IN_UNAVAILABLE', message: 'SMS verification temporarily unavailable' });
const invalid = () => new APIError('BAD_REQUEST', { message: 'Invalid verification' });
type Consent = { id: string; userId: string; phoneNumber: string; consentVersion: string;
  consentedAt: Date; verifiedAt: Date | null; revokedAt: Date | null; challengeId: string | null };
const identifier = (secret: string, userId: string, phone: string, generation: string) =>
  `sms-opt-in:${otpHash(secret, 'sms-owner', `${userId}\0${phone}\0${generation}`)}`;

async function verifiedSession(ctx: GenericEndpointContext) {
  ctx.setHeader('cache-control', 'no-store');
  if (ctx.request?.method === 'POST') {
    const origin = ctx.request.headers.get('origin');
    if (!origin || !ctx.context.isTrustedOrigin(origin, { allowRelativePaths: false })) {
      throw new APIError('FORBIDDEN', { message: 'Trusted origin required' });
    }
  }
  const current = await getSessionFromCtx(ctx);
  if (!current) throw new APIError('UNAUTHORIZED', { message: 'Session required' });
  if (current.user.emailVerified !== true) throw new APIError('FORBIDDEN', { message: 'Verified email required' });
  return current;
}

/** Phone possession and SMS permission are separate from email login and MLM identity. */
export function smsOptInPlugin(secret: string, delivery: AuthDelivery, options: { enabled: boolean; schemaReady: boolean }): BetterAuthPlugin {
  const enabled = options.enabled && options.schemaReady;
  async function read(ctx: GenericEndpointContext, userId: string) {
    try { return await ctx.context.adapter.findOne<Consent>({ model: 'smsOptIn', where: [{ field: 'userId', value: userId }] }); }
    catch { throw unavailable(); }
  }
  return {
    id: 'sms-opt-in',
    // A separate model is intentional. Adding columns to auth.user would make
    // Drizzle's SELECT * break existing email login before migration rollout.
    schema: { user: { fields: {
      phoneNumber: { type: 'string', required: false, unique: true, input: false },
      phoneNumberVerified: { type: 'boolean', required: false, input: false },
    } }, smsOptIn: { modelName: 'smsOptIn', fields: {
      userId: { type: 'string', required: true, unique: true, references: { model: 'user', field: 'id', onDelete: 'cascade' }, input: false },
      phoneNumber: { type: 'string', required: true, input: false },
      consentVersion: { type: 'string', required: true, input: false },
      consentedAt: { type: 'date', required: true, input: false },
      verifiedAt: { type: 'date', required: false, input: false },
      revokedAt: { type: 'date', required: false, input: false },
      challengeId: { type: 'string', required: false, input: false },
      createdAt: { type: 'date', required: true, input: false },
      updatedAt: { type: 'date', required: true, input: false },
    } } },
    rateLimit: [{ pathMatcher: path => path.startsWith('/phone-number/'), window: 60, max: 15 }],
    endpoints: {
      smsOptInStatus: createAuthEndpoint('/phone-number/opt-in', { method: 'GET', requireHeaders: true }, async ctx => {
        const current = await verifiedSession(ctx);
        // No consent-table query at all before the additive schema is ready.
        if (!options.schemaReady) return ctx.json({ available: false, consentVersion: SMS_CONSENT_VERSION,
          optedIn: false, phoneNumber: null, phoneNumberVerified: false });
        const consent = await read(ctx, current.user.id);
        const user = current.user as typeof current.user & { phoneNumber?: string; phoneNumberVerified?: boolean };
        const proved = user.phoneNumberVerified === true && validPhone(user.phoneNumber || '');
        return ctx.json({ available: enabled, consentVersion: SMS_CONSENT_VERSION,
          optedIn: Boolean(proved && consent?.verifiedAt && !consent.revokedAt
            && consent.consentVersion === SMS_CONSENT_VERSION && consent.phoneNumber === user.phoneNumber),
          phoneNumber: proved ? user.phoneNumber! : null, phoneNumberVerified: proved });
      }),
      sendPhoneNumberOTP: createAuthEndpoint('/phone-number/send-otp', { method: 'POST', requireHeaders: true,
        body: z.object({ phoneNumber: z.string().refine(validPhone), consent: z.literal(true),
          consentVersion: z.literal(SMS_CONSENT_VERSION) }).strict() }, async ctx => {
        const current = await verifiedSession(ctx);
        if (!enabled) throw new APIError('NOT_FOUND', { message: 'SMS verification is not enabled' });
        const phone = ctx.body.phoneNumber;
        // Global recipient and account budgets persist across processes. A
        // user cannot bypass the account budget by changing destination.
        await limitRecipient(secret, phone, ctx, 60_000);
        await limitRecipient(secret, `sms-user:${current.user.id}`, ctx, 60_000);
        const existing = await read(ctx, current.user.id);
        const owner = await ctx.context.adapter.findOne<{ id: string }>({ model: 'user', where: [{ field: 'phoneNumber', value: phone }] });
        if (owner && owner.id !== current.user.id) throw invalid();
        const generation = randomUUID();
        const challengeIdentifier = identifier(secret, current.user.id, phone, generation);
        const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
        const now = new Date();
        let challenge: { id: string } | null = null;
        try {
          const data = { userId: current.user.id, phoneNumber: phone, consentVersion: SMS_CONSENT_VERSION,
            consentedAt: now, verifiedAt: null, revokedAt: null, challengeId: generation, updatedAt: now };
          if (existing) {
            const saved = await ctx.context.adapter.update({ model: 'smsOptIn', where: [{ field: 'id', value: existing.id }], update: data });
            if (!saved) throw unavailable();
          }
          else await ctx.context.adapter.create({ model: 'smsOptIn', data: { ...data, createdAt: now } });
          if (existing?.challengeId) await ctx.context.adapter.deleteMany({ model: 'verification', where: [{ field: 'identifier',
            value: identifier(secret, current.user.id, existing.phoneNumber, existing.challengeId) }] });
          challenge = await ctx.context.adapter.create({ model: 'verification', data: { identifier: challengeIdentifier,
            value: `h1_${otpHash(secret, `phone:${challengeIdentifier}`, code)}:0`, expiresAt: new Date(now.getTime() + 300_000), createdAt: now, updatedAt: now } });
          await delivery.phone(phone, code);
        } catch {
          // A failed/unknown delivery never becomes opt-in. Do not retry an
          // external send or erase a later generation from another request.
          if (challenge) await ctx.context.adapter.deleteMany({ model: 'verification', where: [{ field: 'id', value: challenge.id }] }).catch(() => {});
          await ctx.context.adapter.incrementOne({ model: 'smsOptIn', where: [{ field: 'userId', value: current.user.id },
            { field: 'challengeId', value: generation }], increment: {}, set: { challengeId: null, revokedAt: new Date(), updatedAt: new Date() } }).catch(() => {});
          throw unavailable();
        }
        return ctx.json({ ok: true, resendAfter: 60 });
      }),
      verifyPhoneNumber: createAuthEndpoint('/phone-number/verify', { method: 'POST', requireHeaders: true,
        body: z.object({ phoneNumber: z.string().refine(validPhone), code: z.string().regex(/^\d{6}$/),
          updatePhoneNumber: z.literal(true), disableSession: z.literal(true) }).strict() }, async ctx => {
        const current = await verifiedSession(ctx);
        if (!enabled) throw new APIError('NOT_FOUND', { message: 'SMS verification is not enabled' });
        const consent = await read(ctx, current.user.id);
        if (!consent || consent.revokedAt || !consent.challengeId || consent.phoneNumber !== ctx.body.phoneNumber
          || consent.consentVersion !== SMS_CONSENT_VERSION || consent.verifiedAt) throw invalid();
        const owner = await ctx.context.adapter.findOne<{ id: string }>({ model: 'user', where: [{ field: 'phoneNumber', value: ctx.body.phoneNumber }] });
        if (owner && owner.id !== current.user.id) throw invalid();
        const challengeIdentifier = identifier(secret, current.user.id, ctx.body.phoneNumber, consent.challengeId);
        if (!await consumePhoneOTP(secret, challengeIdentifier, ctx.body.code, ctx, true)) throw invalid();
        try {
          const user = await ctx.context.internalAdapter.updateUser(current.user.id, {
            phoneNumber: ctx.body.phoneNumber, phoneNumberVerified: true });
          if (!user) throw invalid();
          // Revocation/new consent changes this generation. A verification in
          // flight must never silently re-enable a revoked subscription.
          const confirmed = await ctx.context.adapter.incrementOne({ model: 'smsOptIn', where: [{ field: 'id', value: consent.id },
            { field: 'challengeId', value: consent.challengeId }, { field: 'revokedAt', value: null }], increment: {},
          set: { verifiedAt: new Date(), challengeId: null, updatedAt: new Date() } });
          if (!confirmed) throw invalid();
        } catch (error) { if (error instanceof APIError) throw error; throw unavailable(); }
        // No createSession, cookie, JWT, email verification or identity claim.
        return ctx.json({ ok: true, phoneNumberVerified: true, optedIn: true });
      }),
      revokeSmsConsent: createAuthEndpoint('/phone-number/revoke-consent', { method: 'POST', requireHeaders: true,
        body: z.object({}).strict() }, async ctx => {
        const current = await verifiedSession(ctx);
        if (!options.schemaReady) throw unavailable();
        const consent = await read(ctx, current.user.id);
        try {
          if (consent) {
            const revoked = await ctx.context.adapter.update({ model: 'smsOptIn', where: [{ field: 'id', value: consent.id }],
              update: { revokedAt: new Date(), verifiedAt: null, challengeId: null, updatedAt: new Date() } });
            if (!revoked) throw unavailable();
            if (consent.challengeId) await ctx.context.adapter.deleteMany({ model: 'verification', where: [{ field: 'identifier',
              value: identifier(secret, current.user.id, consent.phoneNumber, consent.challengeId) }] });
          }
        } catch { throw unavailable(); }
        return ctx.json({ ok: true, optedIn: false });
      }),
    },
  };
}
