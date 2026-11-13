import { NOWPAYMENTS_CALLBACK, nowpaymentsOperationalReady } from './nowpayments-operation.mjs';

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
    const suffix = user.includes('.') ? user.slice(user.indexOf('.') + 1) : '';
    return { host: url.hostname, port: url.port || '5432', database: url.pathname, user, suffix };
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
  if (service === 'payments') {
    values.STRIPE_CHECKOUT_ENABLED = String(env.STRIPE_CHECKOUT_ENABLED === 'true');
    // Capture has a separate, append-only database role. The report connection
    // remains a reader; no provider can create invoices or fulfil memberships.
    values.NOWPAYMENTS_MEMBERSHIPS_ENABLED = 'false';
    values.NOWPAYMENTS_OPERATIONAL_ENABLED = 'false';
    values.NOWPAYMENTS_ENGINE_ENABLED = 'false';
    const captureEnabled = env.NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED === 'true';
    values.NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED = String(captureEnabled);
    if (captureEnabled) {
      for (const key of ['NOWPAYMENTS_WEBHOOK_DATABASE_URL', 'NOWPAYMENTS_API_KEY', 'NOWPAYMENTS_IPN_SECRET']) {
        if (typeof env[key] !== 'string' || !env[key].trim() || env[key].length > (key.endsWith('DATABASE_URL') ? 8192 : 4096)
          || /[\r\n]/.test(env[key])) throw new Error('NOWPayments capture configuration is incomplete');
      }
      const capture = postgresTarget(env.NOWPAYMENTS_WEBHOOK_DATABASE_URL);
      if (capture.host !== target.host || capture.port !== target.port || capture.database !== target.database
        || capture.user === target.user) throw new Error('NOWPayments capture database isolation is not configured');
      Object.assign(values, { NOWPAYMENTS_WEBHOOK_DATABASE_URL: env.NOWPAYMENTS_WEBHOOK_DATABASE_URL,
        NOWPAYMENTS_API_KEY: env.NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET: env.NOWPAYMENTS_IPN_SECRET,
        NOWPAYMENTS_ENV: 'production' });
    }
    if (nowpaymentsOperationalReady(env)) {
      if (typeof env.NOWPAYMENTS_OPERATIONAL_DATABASE_URL !== 'string'
        || !env.NOWPAYMENTS_OPERATIONAL_DATABASE_URL.trim()
        || env.NOWPAYMENTS_OPERATIONAL_DATABASE_URL.length > 8192 || /[\r\n]/.test(env.NOWPAYMENTS_OPERATIONAL_DATABASE_URL)) {
        throw new Error('NOWPayments operational configuration is incomplete');
      }
      const writer = postgresTarget(env.NOWPAYMENTS_OPERATIONAL_DATABASE_URL);
      const capture = postgresTarget(env.NOWPAYMENTS_WEBHOOK_DATABASE_URL);
      if (writer.host !== target.host || writer.port !== target.port || writer.database !== target.database
        || writer.user === target.user || writer.user === capture.user
        || (target.host.endsWith('.psdb.cloud') && (!target.suffix || !capture.suffix || !writer.suffix
          || writer.suffix !== target.suffix || writer.suffix !== capture.suffix))) {
        throw new Error('NOWPayments operational database isolation is not configured');
      }
      Object.assign(values, { NOWPAYMENTS_MEMBERSHIPS_ENABLED: 'true', NOWPAYMENTS_OPERATIONAL_ENABLED: 'true', NOWPAYMENTS_ENGINE_ENABLED: 'true',
        NOWPAYMENTS_OPERATIONAL_DATABASE_URL: env.NOWPAYMENTS_OPERATIONAL_DATABASE_URL,
        NOWPAYMENTS_IPN_URL: NOWPAYMENTS_CALLBACK });
    }
  }
  if (service === 'api') {
    values.MEMBER_PROFILE_ENABLED = String(env.MEMBER_PROFILE_ENABLED === 'true');
    values.ADMINISTRATIVE_WALLET_SIGNING_ENABLED = String(env.ADMINISTRATIVE_WALLET_SIGNING_ENABLED === 'true');
    values.ADMINISTRATIVE_WALLET_BROADCAST_ENABLED = 'false';
    values.ADMINISTRATIVE_MELD_OFFRAMP_ENABLED = String(env.ADMINISTRATIVE_MELD_OFFRAMP_ENABLED === 'true');
    values.PERSONAL_COMPANY_PAYMENTS_ENABLED = String(env.PERSONAL_COMPANY_PAYMENTS_ENABLED === 'true');
    const polygonRelayEnabled = env.PERSONAL_POLYGON_RELAY_ENABLED === 'true';
    values.PERSONAL_POLYGON_RELAY_ENABLED = String(polygonRelayEnabled);
    values.PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED = String(polygonRelayEnabled && env.PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED === 'true');
    if (env.PERSONAL_COMPANY_PAYMENTS_ENABLED === 'true' || polygonRelayEnabled) {
      if (typeof env.API_REOWN_PROJECT_ID !== 'string' || !/^[a-f0-9]{32}$/i.test(env.API_REOWN_PROJECT_ID)) {
        throw new Error('Personal company payment RPC configuration is incomplete');
      }
      // Reown project IDs are public; only the API gets the fixed-chain RPC.
      values.REOWN_PROJECT_ID = env.API_REOWN_PROJECT_ID;
    }
    if (polygonRelayEnabled) {
      const sponsor = env.API_PIMLICO_API_KEY, owner = env.API_POLYGON_RELAYER_PRIVATE_KEY, encryption = env.API_POLYGON_RELAY_ENCRYPTION_KEY;
      if (typeof sponsor !== 'string' || sponsor.length < 16 || sponsor.length > 512 || !/^[\x21-\x7e]+$/.test(sponsor)
        || typeof owner !== 'string' || !/^0x[0-9a-f]{64}$/i.test(owner) || BigInt(owner) === 0n
        || BigInt(owner) >= 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
        || typeof encryption !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encryption) || btoa(atob(encryption)) !== encryption) {
        throw new Error('Polygon relay configuration is incomplete');
      }
      Object.assign(values, { PIMLICO_API_KEY: sponsor, POLYGON_RELAYER_PRIVATE_KEY: owner, POLYGON_RELAY_ENCRYPTION_KEY: encryption });
      const keyId = env.POLYGON_RELAY_ENCRYPTION_KEY_ID ?? 'v1';
      const maximum = env.PERSONAL_POLYGON_RELAY_MAX_FEE_WEI ?? '1000000000000000000';
      const perOwner = env.PERSONAL_POLYGON_RELAY_OWNER_DAILY_BUDGET_WEI ?? '2000000000000000000';
      const global = env.PERSONAL_POLYGON_RELAY_DAILY_BUDGET_WEI ?? '10000000000000000000';
      if (typeof keyId !== 'string' || !/^[a-z0-9_-]{1,16}$/.test(keyId)
        || ![maximum, perOwner, global].every(value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value))
        || BigInt(maximum) > 10n ** 18n || BigInt(perOwner) < BigInt(maximum) || BigInt(perOwner) > 2n * 10n ** 18n
        || BigInt(global) < BigInt(perOwner) || BigInt(global) > 10n ** 19n) throw new Error('Polygon relay budget configuration is invalid');
      Object.assign(values, { POLYGON_RELAY_ENCRYPTION_KEY_ID: keyId, PERSONAL_POLYGON_RELAY_MAX_FEE_WEI: maximum,
        PERSONAL_POLYGON_RELAY_OWNER_DAILY_BUDGET_WEI: perOwner, PERSONAL_POLYGON_RELAY_DAILY_BUDGET_WEI: global });
    }
    // Branch portals share the auth service, not browser cookies or JWT issuers.
    // Append explicit deployed origins without replacing the existing secret.
    if (env.API_AUTH_ADDITIONAL_ORIGINS !== undefined) {
      const additional = env.API_AUTH_ADDITIONAL_ORIGINS;
      const allowed = new Set(['https://mindblisspower.com', 'https://admin.mindblisspower.com', 'https://app.mindblisspower.com', 'https://wallet.mindblisspower.com',
        'https://mindbliss-portal-rewon.devfidubit.workers.dev']);
      if (typeof additional !== 'string' || !additional || additional.length > 512
        || additional.split(',').some(origin => !allowed.has(origin))) throw new Error('Invalid additional authentication origins');
      values.BETTER_AUTH_TRUSTED_ORIGINS = [...new Set([...values.BETTER_AUTH_TRUSTED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean), ...additional.split(',')])].join(',');
    }
    values.AUTH_OBSERVABILITY_ENABLED = String(env.CORE_OBSERVABILITY_ENABLED === 'true');
    values.AUTH_OTP_TRACE_ENABLED = String(env.CORE_AUTH_TRACE_ENABLED === 'true');
    // The live portal must never fall back to the Meld sandbox. Forward one
    // explicitly selected credential to the API container, and nothing else.
    const meldSource = env.CORE_ENV === 'production' ? 'MELD_API_KEY' : 'MELD_API_SANDBOX';
    const meldCredential = env[meldSource];
    if (meldCredential !== undefined) {
      if (typeof meldCredential !== 'string' || !meldCredential || meldCredential.length > 2048
        || /\s/.test(meldCredential)) throw new Error('Meld onramp configuration is invalid');
      values[meldSource] = meldCredential;
    }
    values.MELD_ADMIN_SANDBOX_ENABLED = String(env.MELD_ADMIN_SANDBOX_ENABLED === 'true');
    values.MELD_CHECKOUT_ENABLED = String(env.MELD_CHECKOUT_ENABLED === 'true');
    if (env.MELD_ADMIN_SANDBOX_ENABLED === 'true') {
      const sandboxKey = env.MELD_API_SANDBOX;
      if (typeof sandboxKey !== 'string' || !sandboxKey || sandboxKey.length > 2048 || /\s/.test(sandboxKey)) {
        throw new Error('Meld sandbox configuration is invalid');
      }
      // This credential is consumed only by the separate sandbox session API.
      // The production commission writer still requires the live credential.
      values.MELD_API_SANDBOX = sandboxKey;
      // Manual sandbox status reads are independent of incoming webhook enablement.
      if (env.MELD_ACCOUNT_ID !== undefined) {
        if (typeof env.MELD_ACCOUNT_ID !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(env.MELD_ACCOUNT_ID)) {
          throw new Error('Meld sandbox account configuration is invalid');
        }
        values.MELD_ACCOUNT_ID = env.MELD_ACCOUNT_ID;
      }
    }
    if (env.MELD_CHECKOUT_ENABLED === 'true') {
      const publicKey = env.MELD_WIDGET_PUBLIC_KEY;
      if (env.MELD_ADMIN_SANDBOX_ENABLED !== 'true' || typeof publicKey !== 'string' || !publicKey || publicKey.length > 2048
        || !/^[\x21-\x7e]+$/.test(publicKey) || publicKey === env.MELD_API_SANDBOX
        || typeof env.MELD_ACCOUNT_ID !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(env.MELD_ACCOUNT_ID)
        || ['.', '..'].includes(env.MELD_ACCOUNT_ID)) throw new Error('Meld Checkout configuration is incomplete');
      values.MELD_WIDGET_PUBLIC_KEY = publicKey;
    }
    if (env.MELD_WEBHOOK_ENABLED === 'true') {
      for (const key of ['MELD_WEBHOOK_SIGNING_KEY', 'MELD_ACCOUNT_ID', 'MELD_WEBHOOK_PROFILE_ID']) {
        if (typeof env[key] !== 'string' || !env[key].trim() || env[key].length > 512 || /[\r\n]/.test(env[key])) {
          throw new Error('Meld webhook configuration is incomplete');
        }
      }
      Object.assign(values, { MELD_WEBHOOK_ENABLED: 'true', MELD_WEBHOOK_SIGNING_KEY: env.MELD_WEBHOOK_SIGNING_KEY, MELD_ACCOUNT_ID: env.MELD_ACCOUNT_ID,
        MELD_WEBHOOK_PROFILE_ID: env.MELD_WEBHOOK_PROFILE_ID,
        MELD_WEBHOOK_PUBLIC_URL: 'https://wallet.mindblisspower.com/api/webhooks/meld' });
    }
    // The SDK injects this ephemeral interception CA; Bun keeps its public CA
    // roots and adds this one for the fixed private HTTPS observation hostname.
    if (env.CORE_OBSERVABILITY_ENABLED === 'true' || env.CORE_AUTH_TRACE_ENABLED === 'true' || env.CORE_HTTP_EGRESS_STRICT_ENABLED === 'true') values.NODE_EXTRA_CA_CERTS = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
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
      const provider = env.AUTH_EMAIL_PROVIDER === undefined ? 'cloudflare' : env.AUTH_EMAIL_PROVIDER;
      if (!['cloudflare', 'resend'].includes(provider)) throw new Error('Invalid email provider configuration');
      const providerKeys = provider === 'resend' ? ['RESEND_API_KEY'] : ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN'];
      for (const key of [...providerKeys, 'AUTH_EMAIL_FROM', 'AUTH_JWT_ISSUER', 'AUTH_JWT_AUDIENCE']) {
        if (typeof env[key] !== 'string' || !env[key].trim() || env[key].length > 4096 || /[\r\n]/.test(env[key])) {
          throw new Error('Email authentication secrets are incomplete');
        }
      }
      if (providerKeys.some(key => /\s/.test(env[key]))) throw new Error('Email authentication secrets are incomplete');
      // Read and forward only the selected sender's credentials, never the
      // inactive provider's key. Sending is not retried through a fallback.
      for (const key of providerKeys) values[key] = env[key];
      Object.assign(values, { AUTH_EMAIL_PROVIDER: provider,
        AUTH_EMAIL_FROM: env.AUTH_EMAIL_FROM, BETTER_AUTH_JWT_ISSUER: env.AUTH_JWT_ISSUER, BETTER_AUTH_JWT_AUDIENCE: env.AUTH_JWT_AUDIENCE });
    }
  }
  return values;
}
