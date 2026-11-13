const ORIGIN = 'https://wallet.mindblisspower.com';
const required = ['API_DATABASE_URL', 'API_AUTH_DATABASE_URL', 'API_AUTH_SECRET', 'API_BFF_SHARED_SECRET', 'MELD_API_SANDBOX', 'MELD_ACCOUNT_ID'];

/** Deliberate allowlist: production merchants, relayers, email delivery and
 * engine secrets never enter the isolated wallet process. */
export function walletSandboxEnvironment(env) {
  if (required.some(name => typeof env[name] !== 'string' || !env[name].trim() || /[\r\n]/.test(env[name]))) throw Error('wallet_sandbox_configuration');
  for (const name of ['API_DATABASE_URL', 'API_AUTH_DATABASE_URL']) {
    let url; try { url = new URL(env[name]); } catch { throw Error('wallet_sandbox_configuration'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password
      || url.pathname.length < 2 || url.hash || url.searchParams.get('sslmode') !== 'verify-full'
      || ['postgres', 'app_admin', 'pscale_superuser'].includes(decodeURIComponent(url.username).split('.')[0])) throw Error('wallet_sandbox_configuration');
    const seen = new Set();
    for (const [key] of url.searchParams) {
      if (seen.has(key) || !['sslmode', 'sslrootcert', 'application_name'].includes(key)) throw Error('wallet_sandbox_configuration');
      seen.add(key);
    }
  }
  const reader = new URL(env.API_DATABASE_URL), writer = new URL(env.API_AUTH_DATABASE_URL);
  if (reader.hostname !== writer.hostname || (reader.port || '5432') !== (writer.port || '5432')
    || reader.pathname !== writer.pathname || reader.username === writer.username) throw Error('wallet_sandbox_configuration');
  if (env.API_AUTH_SECRET.length < 32 || env.API_BFF_SHARED_SECRET.length < 32) throw Error('wallet_sandbox_configuration');
  return {
    NODE_ENV: 'production', PORT: '3000', API_LISTEN_HOST: '0.0.0.0', ENV: 'sandbox', PGBOUNCER: 'false',
    DATABASE_POOL_MAX: '2', AUTH_DATABASE_POOL_MAX: '2', AWS_EC2_METADATA_DISABLED: 'true',
    DATABASE_URL: env.API_DATABASE_URL, AUTH_DATABASE_URL: env.API_AUTH_DATABASE_URL,
    BETTER_AUTH_SECRET: env.API_AUTH_SECRET, AUTH_BFF_SHARED_SECRET: env.API_BFF_SHARED_SECRET,
    BETTER_AUTH_URL: ORIGIN, BETTER_AUTH_TRUSTED_ORIGINS: ORIGIN,
    WALLET_SANDBOX_REOWN_ENABLED: 'true', WALLET_FUNDING_ENABLED: 'true', MELD_ADMIN_SANDBOX_ENABLED: 'true',
    MELD_API_SANDBOX: env.MELD_API_SANDBOX, MELD_ACCOUNT_ID: env.MELD_ACCOUNT_ID,
    PERSONAL_COMPANY_PAYMENTS_ENABLED: 'false', PERSONAL_POLYGON_RELAY_ENABLED: 'false',
    PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED: 'false', ADMINISTRATIVE_WALLET_BROADCAST_ENABLED: 'false',
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'false', BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'false',
    NOWPAYMENTS_MEMBERSHIPS_ENABLED: 'false', NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED: 'false',
    MELD_CHECKOUT_ENABLED: 'false', MELD_WEBHOOK_ENABLED: 'false',
  };
}

const actions = new Map([
  ['/capabilities', 'GET'], ['/status', 'GET'], ['/challenge', 'POST'], ['/verify', 'POST'],
  ['/funding/options', 'GET'], ['/funding/session', 'POST'], ['/funding/status', 'GET'], ['/funding/history', 'GET'],
]);
export function walletSandboxRequestAllowed(request) {
  const url = new URL(request.url);
  if (url.origin !== 'https://wallet.core.internal' || url.hash || url.username || url.password
    || request.headers.get('origin') !== ORIGIN || request.headers.has('x-vp-act-as')
    || !url.pathname.startsWith('/api/member/sandbox-wallet/')) return false;
  const encoded = request.headers.get('x-mindbliss-sandbox-subject') || '';
  let subject; try { subject = decodeURIComponent(encoded); } catch { return false; }
  // eslint-disable-next-line no-control-regex
  if (!encoded || encoded.length > 1536 || subject.length > 255 || /[\u0000-\u0020\u007f]/.test(subject) || encodeURIComponent(subject) !== encoded) return false;
  const action = url.pathname.slice('/api/member/sandbox-wallet'.length);
  if (actions.get(action) !== request.method) return false;
  if (action === '/funding/options') return url.searchParams.size === 2 && url.searchParams.getAll('country').length === 1
    && ['US', 'MX', 'CO'].includes(url.searchParams.get('country')) && url.searchParams.getAll('sourceCurrencyCode').length === 1
    && (url.searchParams.get('sourceCurrencyCode') === 'USD' || (url.searchParams.get('country') === 'MX' && url.searchParams.get('sourceCurrencyCode') === 'MXN'));
  if (action === '/funding/status') return url.searchParams.size === 1 && url.searchParams.getAll('checkoutReference').length === 1
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.searchParams.get('checkoutReference') || '');
  return !url.search;
}
