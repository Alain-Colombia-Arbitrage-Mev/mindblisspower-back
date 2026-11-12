import type { BetterAuthOptions } from 'better-auth';
import type { AuthHandler } from './atomic-password-reset';

export type AtomicEmailVerificationState = {
  proofAccepted: boolean;
  subject?: string;
  email?: string;
  sessionToken?: string;
};
export type EmailVerificationTransaction = (
  state: AtomicEmailVerificationState,
  work: (handler: AuthHandler) => Promise<Response>,
) => Promise<Response>;

const verificationPath = '/api/auth/email-otp/verify-email';
const unavailable = () => Response.json({ code: 'EMAIL_VERIFICATION_UNAVAILABLE', message: 'Email verification is temporarily unavailable' },
  { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
class RollbackEmailVerification extends Error {}

/** Native calls beforeEmailVerification only AFTER consuming valid email OTP
 * proof. Keep all existing cleanup and identity hooks, and distinguish a spent
 * wrong attempt from a failure after correct proof. The new session must belong
 * to that exact proof owner; an old request cookie is never authority here. */
export function atomicEmailVerificationOptions(options: BetterAuthOptions, state: AtomicEmailVerificationState): BetterAuthOptions {
  if (options.emailVerification?.autoSignInAfterVerification !== true || options.secondaryStorage
    || options.verification?.storeInDatabase !== true || options.session?.cookieCache?.enabled === true) {
    throw new Error('Atomic email verification requires database-only proof and sessions');
  }
  const beforeVerification = options.emailVerification.beforeEmailVerification;
  const sessionHooks = options.databaseHooks?.session?.create;
  return { ...options, emailVerification: { ...options.emailVerification,
    beforeEmailVerification: async (user, request) => {
      if (typeof user.id !== 'string' || !user.id || user.id.length > 255 || typeof user.email !== 'string'
        || !user.email.trim() || user.email.length > 254) throw new RollbackEmailVerification();
      state.proofAccepted = true;
      state.subject = user.id;
      state.email = user.email.trim().toLowerCase();
      await beforeVerification?.(user, request);
    },
  }, databaseHooks: { ...options.databaseHooks, session: { ...options.databaseHooks?.session, create: { ...sessionHooks,
    after: async (session, context) => {
      await sessionHooks?.after?.(session, context);
      if (!state.proofAccepted || session.userId !== state.subject || typeof session.token !== 'string'
        || !session.token || session.token.length > 8192) throw new RollbackEmailVerification();
      state.sessionToken = session.token;
    },
  } } } };
}

/** Build a fresh native instance INSIDE the caller's bounded writer transaction.
 * Its adapter AND identity callbacks must use that same connection. Returning
 * cookies before COMMIT or using the shared handler would break this contract.
 *
 * A known rollback preserves valid proof. A connection loss during COMMIT can
 * be ambiguous; never claim verification, automatically replay, restore an OTP,
 * or send another email from this handler. */
export function atomicEmailVerificationHandler(fallback: AuthHandler, transaction: EmailVerificationTransaction): AuthHandler {
  return async request => {
    if (request.method !== 'POST' || new URL(request.url).pathname !== verificationPath) return fallback(request);
    if (request.signal.aborted) return unavailable();
    const state: AtomicEmailVerificationState = { proofAccepted: false };
    try {
      return await transaction(state, async handler => {
        const response = await handler(request);
        // Native wrong/expired codes and its rate limiter must keep their
        // accounting. Only errors before valid proof may commit a 4xx.
        if (response.status >= 400 && response.status < 500 && !state.proofAccepted) return response;
        if (response.status !== 200 || !state.proofAccepted || !state.sessionToken
          || !response.headers.has('set-cookie') || response.headers.has('set-auth-jwt')
          || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new RollbackEmailVerification();
        const data: unknown = await response.clone().json().catch(() => null);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RollbackEmailVerification();
        const result = data as { status?: unknown; token?: unknown; user?: { id?: unknown; email?: unknown; emailVerified?: unknown } };
        if (result.status !== true || result.token !== state.sessionToken || !result.user
          || result.user.id !== state.subject || result.user.emailVerified !== true
          || typeof result.user.email !== 'string' || result.user.email.trim().toLowerCase() !== state.email) throw new RollbackEmailVerification();
        // A known client timeout must not consume correct proof just before we
        // ask PostgreSQL to commit. An abort DURING COMMIT can still be ambiguous.
        if (request.signal.aborted) throw new RollbackEmailVerification();
        return response;
      });
    } catch {
      // Includes a rejected COMMIT and ambiguous connection loss. No native
      // cookie/token, OTP, email address or internal exception can escape.
      return unavailable();
    }
  };
}
