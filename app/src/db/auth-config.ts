import { databaseOptions } from './config';

type Environment = Record<string, string | undefined>;

function databaseUrl(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} not set`);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${name} is invalid`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`${name} must use PostgreSQL`);
  if (!url.hostname || !url.username || url.pathname.length < 2 || url.hash) throw new Error(`${name} is invalid`);
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    // postgres.js merges URL parameters into the PostgreSQL startup packet.
    // A query-string user/database could otherwise override the checked DSN,
    // and duplicate sslmode values have first-vs-last parser ambiguity.
    if (seen.has(key) || ['user', 'username', 'password', 'pass', 'host', 'hostname', 'port', 'database', 'dbname', 'db', 'path', 'options', 'ssl', 'debug'].includes(key)) {
      throw new Error(`${name} contains ambiguous connection parameters`);
    }
    seen.add(key);
  }
  try {
    // Parse failures must never include a DSN, password, or username in logs.
    return { url, user: decodeURIComponent(url.username), database: decodeURIComponent(url.pathname.slice(1)) };
  } catch { throw new Error(`${name} is invalid`); }
}

/**
 * Auth owns its small writer pool; DATABASE_URL remains the business reader.
 * Production OTP/JWT activation may not silently reuse that reader credential.
 * Legacy (all features off) and non-production keep a compatible local fallback.
 * Distinct credentials are a configuration check, NOT proof of database grants:
 * the operator must separately verify the auth role has no financial privileges.
 */
export function authDatabaseConfig(env: Environment, readCertificate?: (file: string) => string) {
  const main = databaseUrl(env.DATABASE_URL, 'DATABASE_URL');
  const enabled = ['BETTER_AUTH_EMAIL_OTP_ENABLED', 'BETTER_AUTH_PHONE_OTP_ENABLED', 'BETTER_AUTH_JWT_ENABLED']
    .some(flag => env[flag] === 'true');
  const explicit = Boolean(env.AUTH_DATABASE_URL?.trim());
  if (env.NODE_ENV === 'production' && enabled && !explicit) throw new Error('AUTH_DATABASE_URL required for production authentication');
  const value = explicit ? env.AUTH_DATABASE_URL! : env.DATABASE_URL!;
  const auth = databaseUrl(value, explicit ? 'AUTH_DATABASE_URL' : 'DATABASE_URL');
  const hostname = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, '');
  const sameHost = hostname(main.url) === hostname(auth.url) && (main.url.port || '5432') === (auth.url.port || '5432');
  if (!sameHost || main.database !== auth.database) throw new Error('AUTH_DATABASE_URL must target the same database and host as DATABASE_URL');
  if (explicit && hostname(main.url).endsWith('.psdb.cloud')) {
    // PlanetScale routes branches by the username suffix, not only by host/DB.
    const branch = (user: string) => user.includes('.') ? user.slice(user.lastIndexOf('.') + 1) : '';
    if (!branch(main.user) || branch(main.user) !== branch(auth.user)) throw new Error('AUTH_DATABASE_URL must target the same PlanetScale branch');
  }
  if (explicit && main.user === auth.user) throw new Error('AUTH_DATABASE_URL must use a separate authentication role');
  if (explicit && ['postgres', 'pscale_superuser', 'app_admin'].includes(auth.user.split('.')[0]!)) {
    throw new Error('AUTH_DATABASE_URL must not use a database administrator role');
  }
  const max = env.AUTH_DATABASE_POOL_MAX === undefined ? 4 : Number(env.AUTH_DATABASE_POOL_MAX);
  if (!Number.isSafeInteger(max) || max < 1 || max > 10) throw new Error('AUTH_DATABASE_POOL_MAX must be an integer from 1 to 10');
  if (env.NODE_ENV === 'production' && enabled && auth.url.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('Production AUTH_DATABASE_URL requires sslmode=verify-full');
  }
  // The CA may only be inherited after exact host/port/database validation above.
  // databaseOptions rejects conflicting CA sources and never weakens TLS checks.
  const options = databaseOptions({ ...env, DATABASE_URL: value, DATABASE_POOL_MAX: String(max) }, readCertificate);
  return { url: value, options };
}
