import { betterAuth } from 'better-auth';
import { authDb } from './db/auth-client';
import { db } from './db/client';
import { postgresAuthAdapter } from './auth/postgres-auth-adapter';
import { createAuthOptions } from './auth/options';
import { getAuthPersonBinding, provisionAuthPerson } from './modules/identity';
import { registrationAllowed } from './auth/registration';

// Explicit feature flags and reviewed schema are required before cutover.
// Importing this composition does not migrate a DB or send an auth message.
export const auth = betterAuth(createAuthOptions(process.env,
  postgresAuthAdapter(authDb), {
    provision: userId => provisionAuthPerson(authDb, { userId }),
    binding: userId => getAuthPersonBinding(authDb, { userId }),
    registrationAllowed: candidate => registrationAllowed(db, candidate),
  }));

export type Session = typeof auth.$Infer.Session;
