import { readFileSync } from 'node:fs';

export function databaseOptions(
  env: Record<string, string | undefined>,
  readCertificate: (file: string) => string = file => readFileSync(file, 'utf8'),
) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  let url: URL;
  try { url = new URL(env.DATABASE_URL); }
  catch { throw new Error('DATABASE_URL is invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
  const max = env.DATABASE_POOL_MAX === undefined ? 10 : Number(env.DATABASE_POOL_MAX);
  if (!Number.isSafeInteger(max) || max < 1 || max > 50) throw new Error('DATABASE_POOL_MAX must be an integer from 1 to 50');
  if ((env.DATABASE_CA_FILE || env.DATABASE_CA_PEM) && url.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('Database CA requires sslmode=verify-full');
  }
  if (env.DATABASE_CA_FILE && env.DATABASE_CA_PEM) throw new Error('Choose a file or inline database CA, not both');
  return {
    max,
    connect_timeout: 10,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    prepare: env.PGBOUNCER === 'true' ? false : undefined,
    ...(env.DATABASE_CA_FILE || env.DATABASE_CA_PEM ? {
      ssl: { ca: env.DATABASE_CA_PEM ?? readCertificate(env.DATABASE_CA_FILE!), rejectUnauthorized: true },
    } : {}),
  };
}
