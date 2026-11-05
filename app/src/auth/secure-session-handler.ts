import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { verifyPassword } from 'better-auth/crypto';
import type { DBAdapter } from '@better-auth/core/db/adapter';
import { and, eq, sql } from 'drizzle-orm';
import { account } from '../db/schema/auth';
import { postgresAuthAdapter, type AuthAdapterDatabase } from './postgres-auth-adapter';
import type { AuthHandler } from './atomic-password-reset';

type SessionDatabase = AuthAdapterDatabase & {
  transaction<T>(work: (transaction: AuthAdapterDatabase) => Promise<T>): Promise<T>;
};
type OptionsFactory = (database: AuthAdapterDatabase) => BetterAuthOptions;

/** Only password login needs this request-local verified-credential snapshot.
 * Hooks (especially identity provisioning) run BEFORE the short transaction.
 * Never hold a writer connection while a hook asks the same bounded pool for
 * another connection. OTP, signup and recovery keep their original lifecycle.
 */
export function secureSessionHandler(fallback: AuthHandler, createOptions: OptionsFactory, database: SessionDatabase): AuthHandler {
  return async request => {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/auth/sign-in/email') return fallback(request);
    try {
      const options = createOptions(database);
      if (!options.emailAndPassword?.enabled || options.secondaryStorage || options.session?.cookieCache?.enabled) {
        throw new Error('Guarded password login requires database-only sessions');
      }
      const factory = options.database;
      if (typeof factory !== 'function') throw new Error('Guarded password login requires an adapter factory');
      let verifiedHash: string | null = null;
      const verify = options.emailAndPassword.password?.verify || verifyPassword;
      options.emailAndPassword = { ...options.emailAndPassword, password: { ...options.emailAndPassword.password,
        verify: async input => {
          const valid = await verify(input);
          verifiedHash = valid ? input.hash : null;
          return valid;
        },
      } };
      options.database = (configuration: Parameters<ReturnType<typeof postgresAuthAdapter>>[0]) => {
        const base = factory(configuration);
        const wrapped: DBAdapter = { ...base,
          create: async input => {
            if (input.model !== 'session') return base.create(input);
            const hash = verifiedHash;
            const userId = (input.data as { userId?: unknown }).userId;
            if (!hash || typeof userId !== 'string' || !userId) throw new APIError('UNAUTHORIZED', { message: 'Invalid email or password' });
            return database.transaction(async transaction => {
              await transaction.execute(sql`SET LOCAL lock_timeout='2s'`);
              await transaction.execute(sql`SET LOCAL statement_timeout='10s'`);
              await transaction.execute(sql`SET LOCAL idle_in_transaction_session_timeout='15s'`);
              // FOR SHARE conflicts with password UPDATE, unlike KEY SHARE.
              // PostgreSQL rechecks the predicate after waiting on a reset.
              // If insertion wins, reset's subsequent DELETE sees this session;
              // if reset wins, its new hash cannot authorize this old login.
              const current = await transaction.select({ id: account.id }).from(account).where(and(
                eq(account.userId, userId), eq(account.providerId, 'credential'), eq(account.password, hash),
              )).limit(1).for('share');
              if (!current.length) throw new APIError('UNAUTHORIZED', { message: 'Invalid email or password' });
              return postgresAuthAdapter(transaction)(configuration).create(input);
            });
          },
          transaction: async callback => callback(wrapped),
        };
        return wrapped;
      };
      // The native handler installs its own adapter context. A fresh instance
      // is required: an outer context around the shared handler is insufficient.
      return await betterAuth(options).handler(request);
    } catch {
      return Response.json({ code: 'AUTH_SESSION_UNAVAILABLE', message: 'Authentication temporarily unavailable' },
        { status: 500, headers: { 'Cache-Control': 'private, no-store' } });
    }
  };
}
