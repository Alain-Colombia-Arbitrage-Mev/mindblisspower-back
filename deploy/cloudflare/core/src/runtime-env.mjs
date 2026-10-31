const MAP = Object.freeze({
  api: {
    API_DATABASE_URL: 'DATABASE_URL', API_AUTH_DATABASE_URL: 'AUTH_DATABASE_URL',
    API_AUTH_SECRET: 'BETTER_AUTH_SECRET', API_AUTH_URL: 'BETTER_AUTH_URL',
    API_AUTH_ORIGINS: 'BETTER_AUTH_TRUSTED_ORIGINS', API_BFF_SHARED_SECRET: 'AUTH_BFF_SHARED_SECRET',
    API_ENGINE_GRPC_URL: 'VP_ENGINE_GRPC_URL',
    API_ENGINE_TLS_CA_PEM: 'VP_ENGINE_TLS_CA_PEM', API_ENGINE_TLS_CERT_PEM: 'VP_ENGINE_TLS_CERT_PEM',
    API_ENGINE_TLS_KEY_PEM: 'VP_ENGINE_TLS_KEY_PEM',
  },
  engine: {
    ENGINE_DATABASE_URL: 'DATABASE_URL', ENGINE_ROOT_AFFILIATE_ID: 'BONUS_ENGINE_COMPANY_ROOT_AFFILIATE_ID',
    ENGINE_TLS_CERT_PEM: 'GRPC_TLS_CERT_PEM', ENGINE_TLS_KEY_PEM: 'GRPC_TLS_KEY_PEM', ENGINE_TLS_CLIENT_CA_PEM: 'GRPC_TLS_CLIENT_CA_PEM',
  },
  payments: {
    PAYMENTS_DATABASE_URL: 'DATABASE_URL', PAYMENTS_SERVICE_TOKEN: 'PAYMENTS_SERVICE_TOKEN',
    CORE_SUPER_ADMIN_EMAILS: 'PAYMENTS_SUPER_ADMIN_EMAILS',
    PAYMENTS_ROOT_AFFILIATE_ID: 'PAYMENTS_COMPANY_ROOT_AFFILIATE_ID',
    AUTH_JWT_ISSUER: 'BETTER_AUTH_JWT_ISSUER', AUTH_JWT_AUDIENCE: 'BETTER_AUTH_JWT_AUDIENCE',
  },
  withdrawals: {
    WITHDRAWALS_DATABASE_URL: 'DATABASE_URL', WITHDRAWALS_SERVICE_TOKEN: 'SERVICE_TOKEN',
    CORE_SUPER_ADMIN_EMAILS: 'SUPER_ADMIN_EMAILS',
    AUTH_JWT_ISSUER: 'BETTER_AUTH_JWT_ISSUER', AUTH_JWT_AUDIENCE: 'BETTER_AUTH_JWT_AUDIENCE',
  },
});

const FIXED = Object.freeze({
  api: { NODE_ENV: 'production', PORT: '3000', API_LISTEN_HOST: '0.0.0.0', PGBOUNCER: 'false', DATABASE_POOL_MAX: '4', AUTH_DATABASE_POOL_MAX: '4', ENGINE_MTLS_REQUIRED: 'true', VP_ENGINE_TUNNEL_ENABLED: 'true', VP_ENGINE_TUNNEL_URL: 'ws://engine-grpc.core.internal/v1/engine-tunnel', VP_ENGINE_HTTP_URL: 'http://engine.core.internal' },
  engine: { HTTP_LISTEN_ADDR: '0.0.0.0:9090', GRPC_LISTEN_ADDR: '0.0.0.0:50051', DB_MAX_CONNS: '4', GRPC_TLS_REQUIRE_CLIENT_CERT: 'true', BONUS_ENGINE_BINARY_CYCLE_ENABLED: 'false', BONUS_ENGINE_SCHEDULER_ENABLED: 'false', NATS_URL: 'nats://127.0.0.1:1', GOMEMLIMIT: '384MiB' },
  payments: { SERVICE_READ_ONLY: 'true', PAYMENTS_HTTP_ADDR: '0.0.0.0:9095', PAYMENTS_DB_MAX_CONNS: '4', VP_ENGINE_URL: 'http://engine.core.internal', REDIS_ADDR: '', REQUIRE_VERIFIED_IDENTITY: 'true', PAYMENTS_CART_REMINDER_ENABLED: 'false', PAYMENTS_RECONCILE_INTERVAL_MIN: '0', PAYMENTS_SUPPORT_AI_AUTO_DRAFT: 'false', COMMS_ENABLED: 'false', AUTH_PROVIDER: 'better-auth', BETTER_AUTH_JWKS_URL: 'https://auth.core.internal/api/auth/jwks', SSL_CERT_DIR: '/etc/ssl/certs:/etc/cloudflare/certs', GOMEMLIMIT: '384MiB' },
  withdrawals: { SERVICE_READ_ONLY: 'true', WITHDRAWALS_HTTP_ADDR: '0.0.0.0:9097', WITHDRAWALS_REQUIRE_BMP: 'true', WITHDRAWALS_REQUIRE_VERIFIED_IDENTITY: 'true', AUTH_PROVIDER: 'better-auth', BETTER_AUTH_JWKS_URL: 'https://auth.core.internal/api/auth/jwks', SSL_CERT_DIR: '/etc/ssl/certs:/etc/cloudflare/certs', GOMEMLIMIT: '256MiB' },
});

function postgresTarget(value) {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password
      || url.pathname.length < 2 || url.hash || url.searchParams.get('sslmode') !== 'verify-full') throw new Error();
    // Avoid query parameters overriding the validated authority or libpq options.
    const seen = new Set();
    for (const [key] of url.searchParams) {
      if (seen.has(key) || !['sslmode', 'sslrootcert', 'application_name'].includes(key)) throw new Error();
      seen.add(key);
    }
    const user = decodeURIComponent(url.username);
    if (['postgres', 'app_admin', 'pscale_superuser'].includes(user.split('.')[0])) throw new Error();
    return { host: url.hostname, port: url.port || '5432', database: url.pathname, user };
  } catch { throw new Error('Invalid service database configuration'); }
}

/** Explicit per-container secret mapping; never forwards the whole Worker env. */
export function containerEnvironment(service, env) {
  if (!Object.hasOwn(MAP, service) || !['staging', 'production'].includes(env.CORE_ENV)) throw new Error('Invalid core service configuration');
  const values = { ...FIXED[service], AWS_EC2_METADATA_DISABLED: 'true', ENV: env.CORE_ENV };
  for (const [source, target] of Object.entries(MAP[service])) {
    if (typeof env[source] !== 'string' || !env[source].trim()) throw new Error('Core service secrets are incomplete');
    values[target] = env[source];
  }
  const target = postgresTarget(values.DATABASE_URL);
  if (service === 'payments') values.STRIPE_CHECKOUT_ENABLED = String(env.STRIPE_CHECKOUT_ENABLED === 'true');
  if (service === 'api') {
    const engine = new URL(values.VP_ENGINE_GRPC_URL);
    if (engine.protocol !== 'https:' || !engine.hostname || engine.username || engine.password || engine.hash || engine.search || engine.pathname !== '/') throw new Error('Engine mTLS origin is invalid');
    const auth = postgresTarget(values.AUTH_DATABASE_URL);
    if (auth.host !== target.host || auth.port !== target.port || auth.database !== target.database || auth.user === target.user) throw new Error('Authentication database isolation is not configured');
    if (values.BETTER_AUTH_SECRET.length < 32 || values.AUTH_BFF_SHARED_SECRET.length < 32) throw new Error('Authentication secrets are incomplete');
    const emailEnabled = env.AUTH_CUTOVER_VERIFIED === 'true';
    values.BETTER_AUTH_EMAIL_OTP_ENABLED = String(emailEnabled);
    values.BETTER_AUTH_JWT_ENABLED = String(emailEnabled);
    // Email-only registration/login is a fixed deployment policy, not a feature
    // flag. Never pass SMS provider credentials, even when stale Worker secrets
    // or flags remain configured. Contact phones do not imply verification.
    values.BETTER_AUTH_PHONE_OTP_ENABLED = 'false';
    values.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY = 'false';
    values.BETTER_AUTH_REGISTRATION_SMS_REQUIRED = 'false';
    if (emailEnabled) {
      for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN', 'AUTH_EMAIL_FROM', 'AUTH_JWT_ISSUER', 'AUTH_JWT_AUDIENCE']) {
        if (typeof env[key] !== 'string' || !env[key].trim()) throw new Error('Email authentication secrets are incomplete');
      }
      Object.assign(values, { CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_EMAIL_API_TOKEN: env.CLOUDFLARE_EMAIL_API_TOKEN,
        AUTH_EMAIL_FROM: env.AUTH_EMAIL_FROM, BETTER_AUTH_JWT_ISSUER: env.AUTH_JWT_ISSUER, BETTER_AUTH_JWT_AUDIENCE: env.AUTH_JWT_AUDIENCE });
    }
  }
  return values;
}
