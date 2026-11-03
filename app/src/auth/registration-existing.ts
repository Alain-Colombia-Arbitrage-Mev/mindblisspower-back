import type { GenericEndpointContext } from '@better-auth/core';
import { APIError } from 'better-auth/api';
import { limitRecipient } from './phone-otp';

/** Called only after the normal registration/blacklist policy accepts input. */
export async function requireNewEmailForRegistration(secret: string, email: string, ctx: GenericEndpointContext) {
  let existing;
  try { existing = await ctx.context.internalAdapter.findUserByEmail(email.trim().toLowerCase()); }
  catch { throw new APIError('SERVICE_UNAVAILABLE', {
    code: 'AUTH_ACCESS_LOOKUP_UNAVAILABLE', message: 'Authentication temporarily unavailable',
  }); }
  if (!existing) return;
  // This explicit existence response uses its own persistent probe budget.
  // It must not reserve a real-message cooldown: the owner can immediately
  // request their native login OTP. No password/verification/role is exposed.
  await limitRecipient(secret, `registration-existing:${email.trim().toLowerCase()}`, ctx, 300_000);
  throw new APIError('CONFLICT', { code: 'USER_ALREADY_EXISTS', message: 'Account already exists. Sign in to continue.' });
}
