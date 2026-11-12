import { betterAuth } from 'better-auth';
import { sql } from 'drizzle-orm';
import { authDb } from './db/auth-client';
import { db } from './db/client';
import { postgresAuthAdapter } from './auth/postgres-auth-adapter';
import { createAuthOptions } from './auth/options';
import { getAuthPersonBinding, provisionAuthPerson, type IdentityDatabase } from './modules/identity';
import { ensureAdministrativeWallet } from './modules/identity/administrative-wallet';
import { registrationAllowed } from './auth/registration';
import { atomicPasswordResetHandler, atomicPasswordResetOptions } from './auth/atomic-password-reset';
import { secureSessionHandler } from './auth/secure-session-handler';
import { otpTraceHandler } from './auth/otp-trace';
import { atomicEmailVerificationHandler, atomicEmailVerificationOptions } from './auth/atomic-email-verification';

// Explicit feature flags and reviewed schema are required before cutover.
// Importing this composition does not migrate a DB or send an auth message.
function identityFor(database: IdentityDatabase, isolateAdministrativeWallet = false) {
  return {
    provision: userId => provisionAuthPerson(database, { userId }),
    binding: userId => getAuthPersonBinding(database, { userId }),
    // A caught SQL error still aborts its PostgreSQL transaction. Isolate this
    // optional allocation in a same-connection savepoint during email proof.
    administrativeWallet: userId => isolateAdministrativeWallet
      ? database.transaction(transaction => ensureAdministrativeWallet(transaction, { userId }))
      : ensureAdministrativeWallet(database, { userId }),
    registrationAllowed: candidate => registrationAllowed(db, candidate),
  } satisfies Parameters<typeof createAuthOptions>[2];
}
const identity = identityFor(authDb);
const native = betterAuth(createAuthOptions(process.env, postgresAuthAdapter(authDb), identity));
export const auth = { ...native,
  handler: otpTraceHandler(secureSessionHandler(atomicEmailVerificationHandler(atomicPasswordResetHandler(native.handler, (state, work) => authDb.transaction(async transaction => {
    await transaction.execute(sql`SET LOCAL lock_timeout='2s'`);
    await transaction.execute(sql`SET LOCAL statement_timeout='10s'`);
    await transaction.execute(sql`SET LOCAL idle_in_transaction_session_timeout='15s'`);
    const options = atomicPasswordResetOptions(createAuthOptions(process.env, postgresAuthAdapter(transaction), identity), state);
    const scoped = betterAuth(options);
    return work(scoped.handler);
  })), (state, work) => authDb.transaction(async transaction => {
    await transaction.execute(sql`SET LOCAL lock_timeout='2s'`);
    await transaction.execute(sql`SET LOCAL statement_timeout='10s'`);
    await transaction.execute(sql`SET LOCAL idle_in_transaction_session_timeout='15s'`);
    const options = atomicEmailVerificationOptions(createAuthOptions(process.env, postgresAuthAdapter(transaction), identityFor(transaction, true)), state);
    return work(betterAuth(options).handler);
  })), database => createAuthOptions(process.env, postgresAuthAdapter(database), identity), authDb), process.env),
};

export type Session = typeof auth.$Infer.Session;
