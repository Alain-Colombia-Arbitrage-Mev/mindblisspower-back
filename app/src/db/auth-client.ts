import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as auth from './schema/auth';
import * as mlm from './schema/mlm';
import * as identity from './schema/identity';
import { authDatabaseConfig } from './auth-config';

const config = authDatabaseConfig(process.env);
// Bun container: one bounded auth writer pool per process, separate from the
// business reader. postgres opens sockets lazily; importing never migrates SQL.
// Database grants, not the schema mirror, enforce which tables this role writes.
const client = postgres(config.url, config.options);
export const authDb = drizzle(client, { schema: { ...auth, ...mlm, ...identity } });
