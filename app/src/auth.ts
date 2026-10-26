import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { authDb } from './db/auth-client';
import * as schema from './db/schema/auth';
import { createAuthOptions } from './auth/options';
import { getAuthPersonBinding, provisionAuthPerson } from './modules/identity';

// Explicit feature flags and reviewed schema are required before cutover.
// Importing this composition does not migrate a DB or send an auth message.
export const auth = betterAuth(createAuthOptions(process.env,
  drizzleAdapter(authDb, { provider: 'pg', schema, usePlural: false }), {
    provision: userId => provisionAuthPerson(authDb, { userId }),
    binding: userId => getAuthPersonBinding(authDb, { userId }),
  }));

export type Session = typeof auth.$Infer.Session;
