import { betterAuth } from 'better-auth';
import { sql } from 'drizzle-orm';
import { authDb } from './db/auth-client';
import { db } from './db/client';
import { postgresAuthAdapter } from './auth/postgres-auth-adapter';
import { createAuthOptions } from './auth/options';
import { getAuthPersonBinding, provisionAuthPerson } from './modules/identity';
import { ensureAdministrativeWallet } from './modules/identity/administrative-wallet';
import { registrationAllowed } from './auth/registration';
import { atomicPasswordResetHandler, atomicPasswordResetOptions } from './auth/atomic-password-reset';
import { secureSessionHandler } from './auth/secure-session-handler';
import { otpTraceHandler } from './auth/otp-trace';

// Explicit feature flags and reviewed schema are required before cutover.
// Importing this composition does not migrate a DB or send an auth message.
const identity = {
    provision: userId => provisionAuthPerson(authDb, { userId }),
    binding: userId => getAuthPersonBinding(authDb, { userId }),
    administrativeWallet: userId => ensureAdministrativeWallet(authDb, { userId }),
    registrationAllowed: candidate => registrationAllowed(db, candidate),
} satisfies Parameters<typeof createAuthOptions>[2];
const native = betterAuth(createAuthOptions(process.env, postgresAuthAdapter(authDb), identity));
export const auth = { ...native,
  handler: otpTraceHandler(secureSessionHandler(atomicPasswordResetHandler(native.handler, (state, work) => authDb.transaction(async transaction => {
    await transaction.execute(sql`SET LOCAL lock_timeout='2s'`);
    await transaction.execute(sql`SET LOCAL statement_timeout='10s'`);
    await transaction.execute(sql`SET LOCAL idle_in_transaction_session_timeout='15s'`);
    const options = atomicPasswordResetOptions(createAuthOptions(process.env, postgresAuthAdapter(transaction), identity), state);
    const scoped = betterAuth(options);
    return work(scoped.handler);
  })), database => createAuthOptions(process.env, postgresAuthAdapter(database), identity), authDb), process.env),
};

export type Session = typeof auth.$Infer.Session;
