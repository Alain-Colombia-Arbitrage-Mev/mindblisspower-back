import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as auth from './schema/auth';
import * as mlm from './schema/mlm';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL not set');

// One pool per process. Use PgBouncer in production for connection multiplexing.
// `prepare: false` is required when going through PgBouncer in transaction mode.
const client = postgres(url, {
  max: 10,
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  prepare: process.env.PGBOUNCER === 'true' ? false : undefined,
});

export const db = drizzle(client, { schema: { ...auth, ...mlm } });
export type DB = typeof db;
