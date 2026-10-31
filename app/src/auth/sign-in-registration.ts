import type { GenericEndpointContext } from '@better-auth/core';
import { APIError } from 'better-auth/api';
import { z } from 'zod';
import { limitRecipient } from './phone-otp';

const loginEmail = z.string().max(320).pipe(z.email());

/** The login flow may identify absence, never expose an account or create one. */
export async function requireRegisteredEmailForSignIn(secret: string, ctx: GenericEndpointContext, method: 'otp' | 'password' = 'otp') {
  const parsed = loginEmail.safeParse(ctx.body?.email);
  // Preserve native validation failures, not an account-existence response,
  // for malformed input. The endpoint still rejects invalid email/password.
  if (!parsed.success) return;
  let existing;
  const email = parsed.data.toLowerCase();
  try { existing = await ctx.context.internalAdapter.findUserByEmail(email); }
  catch { throw new APIError('SERVICE_UNAVAILABLE', {
    code: 'AUTH_ACCESS_LOOKUP_UNAVAILABLE', message: 'Authentication temporarily unavailable',
  }); }
  if (existing) return;
  // The native IP limiter already ran. This persistent probe budget limits the
  // explicit absence response without reserving a real-message cooldown: the
  // redirected visitor can immediately submit the opt-in registration form.
  await limitRecipient(secret, `registration-required:${method === 'password' ? 'password:' : ''}${email}`, ctx, 300_000);
  throw new APIError('BAD_REQUEST', { code: 'REGISTRATION_REQUIRED', message: 'Registration required' });
}
