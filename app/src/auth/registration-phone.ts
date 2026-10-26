import { randomBytes, randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import type { BetterAuthPlugin } from 'better-auth';
import type { GenericEndpointContext } from '@better-auth/core';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { z } from 'zod';
import { validPhone, type AuthDelivery } from './delivery';
import { consumePhoneOTP, limitRecipient, otpHash, recipientBudgetKey } from './phone-otp';

export const REGISTRATION_PHONE_CONSENT_VERSION = 'registration-phone-v1';
const email = z.string().trim().toLowerCase().max(320).pipe(z.email());
const phoneNumber = z.string().refine(validPhone);
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const registrationDetails = z.object({ purpose: z.literal('registration'), email, phoneNumber,
  consentVersion: z.literal(REGISTRATION_PHONE_CONSENT_VERSION) }).strict();
type Verification = { id: string; identifier: string; value: string; expiresAt: Date };
const unavailable = () => new APIError('SERVICE_UNAVAILABLE', { code: 'REGISTRATION_PHONE_UNAVAILABLE',
  message: 'Registration phone verification temporarily unavailable' });
const invalid = () => new APIError('BAD_REQUEST', { code: 'REGISTRATION_PHONE_INVALID', message: 'Invalid registration verification' });
const required = () => new APIError('FORBIDDEN', { code: 'REGISTRATION_PHONE_REQUIRED', message: 'Registration phone verification required' });
const challengeIdentifier = (secret: string, address: string, phone: string, flow: string) =>
  `registration-phone:${otpHash(secret, 'registration-phone-owner', `${address}\0${phone}\0${flow}`)}`;
const proofIdentifier = (secret: string, proof: string) => `registration-proof:${otpHash(secret, 'registration-proof', proof)}`;

/** Persistent bounded counters, separate from the per-destination send cooldown. */
async function budget(secret: string, ctx: GenericEndpointContext, scope: string, max: number, duration: number, extendWindow = false) {
  const key = recipientBudgetKey(secret, `registration:${scope}`);
  const adapter = ctx.context.adapter;
  const now = Date.now();
  const current = await adapter.findOne<{ lastRequest: number; count: number }>({ model: 'rateLimit', where: [{ field: 'key', value: key }] });
  if (!current) {
    try { await adapter.create({ model: 'rateLimit', data: { key, count: 1, lastRequest: now + duration } }); return; }
    catch { throw new APIError('TOO_MANY_REQUESTS', { message: 'Please wait before trying again' }); }
  }
  const changed = current.lastRequest <= now
    ? await adapter.incrementOne({ model: 'rateLimit', where: [{ field: 'key', value: key }, { field: 'lastRequest', operator: 'lte', value: now }],
      increment: {}, set: { count: 1, lastRequest: now + duration } })
    : await adapter.incrementOne({ model: 'rateLimit', where: [{ field: 'key', value: key },
      { field: 'lastRequest', value: current.lastRequest }, { field: 'count', operator: 'lt', value: max }], increment: { count: 1 },
      ...(extendWindow ? { set: { lastRequest: now + duration } } : {}) });
  if (!changed) throw new APIError('TOO_MANY_REQUESTS', { message: 'Please wait before trying again' });
}

function requestContext(ctx: GenericEndpointContext) {
  ctx.setHeader('cache-control', 'no-store');
  const origin = ctx.request?.headers.get('origin');
  if (!origin || !ctx.context.isTrustedOrigin(origin, { allowRelativePaths: false })) {
    throw new APIError('FORBIDDEN', { message: 'Trusted origin required' });
  }
  // The existing authProxyContext verifies this IP, request body and COMPLETE
  // cookie header with the BFF HMAC. Never accept browser-selected proxy IPs.
  const ip = ctx.request?.headers.get('x-vp-auth-client-ip') || '';
  if (!isIP(ip)) throw unavailable();
  return ip;
}

/** SMS proves registration phone possession only; it never creates a session. */
export function registrationPhonePlugin(secret: string, delivery: AuthDelivery, options: { enabled: boolean; configured: boolean }): BetterAuthPlugin {
  const ensureAvailable = () => {
    if (!options.enabled) throw new APIError('NOT_FOUND', { message: 'Not found' });
    if (!options.configured) throw unavailable();
  };
  return { id: 'registration-phone',
    rateLimit: [{ pathMatcher: path => path.startsWith('/registration/phone/'), window: 60, max: 15 }],
    endpoints: {
      sendRegistrationPhoneOTP: createAuthEndpoint('/registration/phone/send', { method: 'POST', requireHeaders: true,
        body: z.object({ email, phoneNumber, consent: z.literal(true),
          consentVersion: z.literal(REGISTRATION_PHONE_CONSENT_VERSION) }).strict() }, async ctx => {
        ensureAvailable();
        const ip = requestContext(ctx);
        let challenge: { id: string } | null = null;
        try {
          await budget(secret, ctx, `send-ip:${ip}`, 5, 600_000);
          await limitRecipient(secret, `registration-email:${ctx.body.email}`, ctx, 60_000);
          await limitRecipient(secret, `registration-phone:${ctx.body.phoneNumber}`, ctx, 60_000);
          // Account-wide cost cap cannot be bypassed by rotating recipients or
          // IPs. The deadline extends after every admitted request, so it is
          // stricter than 100 sends in a rolling day (reset after 24h quiet).
          await budget(secret, ctx, 'send-global', 100, 86_400_000, true);
          const flowId = randomBytes(32).toString('base64url');
          const identifier = challengeIdentifier(secret, ctx.body.email, ctx.body.phoneNumber, flowId);
          const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
          const now = new Date();
          challenge = await ctx.context.adapter.create({ model: 'verification', data: { identifier,
            value: `h1_${otpHash(secret, `phone:${identifier}`, code)}:0`, expiresAt: new Date(now.getTime() + 300_000), createdAt: now, updatedAt: now } });
          if (!challenge?.id) throw unavailable();
          // Deliberately no user/MLM lookup: this endpoint is not an existence
          // oracle. Provider acceptance is never proof of phone possession.
          await delivery.phone(ctx.body.phoneNumber, code);
          return ctx.json({ ok: true, flowId, resendAfter: 60, expiresIn: 300 });
        } catch (error) {
          if (challenge) await ctx.context.adapter.deleteMany({ model: 'verification', where: [{ field: 'id', value: challenge.id }] }).catch(() => {});
          if (error instanceof APIError && error.statusCode < 500) throw error;
          throw unavailable();
        }
      }),
      verifyRegistrationPhoneOTP: createAuthEndpoint('/registration/phone/verify', { method: 'POST', requireHeaders: true,
        body: z.object({ email, phoneNumber, flowId: opaque, code: z.string().regex(/^\d{6}$/) }).strict() }, async ctx => {
        ensureAvailable();
        const ip = requestContext(ctx);
        try {
          await budget(secret, ctx, `verify-ip:${ip}`, 30, 60_000);
          await budget(secret, ctx, `verify-email:${ctx.body.email}`, 10, 60_000);
          await budget(secret, ctx, `verify-phone:${ctx.body.phoneNumber}`, 10, 60_000);
          await budget(secret, ctx, `verify-flow:${ctx.body.flowId}`, 8, 300_000);
          const identifier = challengeIdentifier(secret, ctx.body.email, ctx.body.phoneNumber, ctx.body.flowId);
          const challenge = await ctx.context.adapter.findOne<Verification>({ model: 'verification', where: [{ field: 'identifier', value: identifier }] });
          if (!challenge || challenge.expiresAt.getTime() <= Date.now()
            || !await consumePhoneOTP(secret, identifier, ctx.body.code, ctx, true)) throw invalid();
          const proof = randomBytes(32).toString('base64url');
          const now = new Date();
          await ctx.context.adapter.create({ model: 'verification', data: { identifier: proofIdentifier(secret, proof),
            value: JSON.stringify({ purpose: 'registration', email: ctx.body.email, phoneNumber: ctx.body.phoneNumber,
              consentVersion: REGISTRATION_PHONE_CONSENT_VERSION }), expiresAt: new Date(now.getTime() + 300_000), createdAt: now, updatedAt: now } });
          return ctx.json({ ok: true, verified: true, purpose: 'registration', email: ctx.body.email, phoneNumber: ctx.body.phoneNumber, proof });
        } catch (error) {
          if (error instanceof APIError && error.statusCode < 500) throw error;
          throw unavailable();
        }
      }),
    },
  };
}

/** Read-only before registration policy checks; atomic spend immediately before user INSERT. */
export async function registrationPhoneProof(secret: string, ctx: GenericEndpointContext | null | undefined,
  address: string, options: { configured: boolean; secureCookie: boolean; consume?: boolean }) {
  if (!options.configured) throw unavailable();
  if (!ctx || ctx.path !== '/sign-up/email') throw required();
  ctx.setHeader('cache-control', 'no-store');
  const expectedName = options.secureCookie ? '__Secure-vp_registration_phone' : 'vp_registration_phone';
  const cookieParts = (ctx.request?.headers.get('cookie') || '').split(';').map(item => item.trim());
  const cookies = cookieParts.filter(item => item.startsWith(`${expectedName}=`));
  if (cookies.length !== 1) throw required();
  // This second cookie is added only by the BFF to its signed upstream
  // request, never set in the browser. It binds the submitted phone as well.
  const expectedPhones = cookieParts.filter(item => item.startsWith('vp_registration_phone_expected='));
  if (expectedPhones.length !== 1) throw required();
  const expectedPhone = expectedPhones[0]!.slice('vp_registration_phone_expected='.length);
  if (!validPhone(expectedPhone)) throw invalid();
  const proof = cookies[0]!.slice(expectedName.length + 1);
  if (!opaque.safeParse(proof).success) throw invalid();
  try {
    const identifier = proofIdentifier(secret, proof);
    const record = await ctx.context.adapter.findOne<Verification>({ model: 'verification', where: [{ field: 'identifier', value: identifier }] });
    if (!record || record.expiresAt.getTime() <= Date.now()) throw invalid();
    const details = registrationDetails.safeParse(JSON.parse(record.value));
    if (!details.success || details.data.email !== address.trim().toLowerCase()
      || details.data.phoneNumber !== expectedPhone) throw invalid();
    if (options.consume && !await ctx.context.adapter.consumeOne({ model: 'verification', where: [
      { field: 'id', value: record.id }, { field: 'identifier', value: identifier }, { field: 'value', value: record.value },
      { field: 'expiresAt', operator: 'gt', value: new Date() },
    ] })) throw invalid();
    return details.data;
  } catch (error) {
    if (error instanceof APIError) throw error;
    throw unavailable();
  }
}
