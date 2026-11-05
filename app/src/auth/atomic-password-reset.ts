import type { BetterAuthOptions } from 'better-auth';

export type AuthHandler = (request: Request) => Promise<Response>;
export type AtomicPasswordResetState = { credentialChanged: boolean };
export type PasswordResetTransaction = (
  state: AtomicPasswordResetState,
  work: (handler: AuthHandler) => Promise<Response>,
) => Promise<Response>;

// Only the published OTP reset is enrolled. Other endpoints must retain their
// existing connection/hook lifecycle, especially identity provisioning.
const resetPath = '/api/auth/email-otp/reset-password';
const unavailable = () => Response.json({ code: 'PASSWORD_RESET_UNAVAILABLE', message: 'Password recovery is temporarily unavailable' },
  { status: 500, headers: { 'Cache-Control': 'private, no-store' } });
class RollbackPasswordReset extends Error {}

/** The installed native handler calls this hook immediately after saving its
 * hash. A later client-looking error must not commit a partially changed user.
 * Preserve any existing hook; neither it nor the native handler owns COMMIT. */
export function atomicPasswordResetOptions(options: BetterAuthOptions, state: AtomicPasswordResetState): BetterAuthOptions {
  const existing = options.emailAndPassword;
  if (!existing?.enabled || existing.revokeSessionsOnPasswordReset !== true || options.secondaryStorage
    || options.session?.cookieCache?.enabled === true) throw new Error('Atomic password reset requires database-only sessions and revocation');
  const previous = existing.onPasswordReset;
  return { ...options, emailAndPassword: { ...existing,
    onPasswordReset: async (...args) => {
      state.credentialChanged = true;
      await previous?.(...args);
    },
  } };
}

/** The transaction callback must build a NEW native auth instance whose adapter
 * is bound to its PostgreSQL transaction. Wrapping the original auth.handler in
 * Better Auth's adapter context is insufficient: that handler replaces it.
 * Success is returned only after the outer transaction has actually committed.
 */
export function atomicPasswordResetHandler(fallback: AuthHandler, transaction: PasswordResetTransaction): AuthHandler {
  return async request => {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== resetPath) return fallback(request);
    const state: AtomicPasswordResetState = { credentialChanged: false };
    try {
      return await transaction(state, async handler => {
        const response = await handler(request);
        // Invalid/expired OTP attempts must remain spent, not be rolled back by
        // treating every 4xx as a database failure. No credential may have been
        // touched before this exception to rollback is allowed.
        if (response.status >= 400 && response.status < 500 && !state.credentialChanged) return response;
        if (response.status !== 200 || !state.credentialChanged || response.headers.has('set-cookie')
          || response.headers.has('set-auth-jwt')) throw new RollbackPasswordReset();
        const result: unknown = await response.clone().json().catch(() => null);
        if (!result || typeof result !== 'object' || Array.isArray(result)
          || Object.keys(result).length !== 1 || !Object.hasOwn(result, 'success')
          || (result as { success?: unknown }).success !== true) throw new RollbackPasswordReset();
        return response;
      });
    } catch {
      // Native 5xx responses are converted to a thrown rollback above. Failed
      // COMMIT, connection loss, hooks and unknown exceptions share one safe
      // failure, without logging SQL, password, OTP, headers or user data.
      return unavailable();
    }
  };
}
