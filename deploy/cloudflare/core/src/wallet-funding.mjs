export const WALLET_FUNDING_PREFIX = '/api/member/wallet-funding';
export const WALLET_FUNDING_MAX_BODY = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERSONAL_ORIGINS = new Set(['https://mindblisspower.com', 'https://app.mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev']);
const ADMINISTRATIVE_ORIGIN = 'https://wallet.mindblisspower.com';
const PERSONAL_COUNTRIES = new Set(['US', 'MX', 'CO']);
const PROHIBITED_PERSONAL_METHODS = new Set(['PAYPAL', 'NETELLER', 'PAYSAFECARD', 'PAYSAFE_CARD', 'SKRILL', 'SKIRLL']);
// Temporary integration gate, separate from the user's permanently prohibited methods.
const UNAVAILABLE_PERSONAL_METHODS = new Set(['ASTROPAY']);

export function walletFundingNamespace(path) {
  return path === WALLET_FUNDING_PREFIX || path.startsWith(`${WALLET_FUNDING_PREFIX}/`);
}

/** A separate capability for recording requested funding, never financial settlement. */
export function walletFundingRequest(request, url, body, env, ready) {
  if (!ready || env.WALLET_FUNDING_ENABLED !== 'true' || url.protocol !== 'https:'
    || url.host !== 'auth.core.internal' || request.headers.has('x-vp-act-as')
    || !/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=[^;\s,]+(?:;|$)/.test(request.headers.get('cookie') || '')) return false;
  if (request.method === 'GET') {
    if (url.pathname === `${WALLET_FUNDING_PREFIX}/history`) return ['?walletKind=personal', '?walletKind=administrative'].includes(url.search);
    if ([`${WALLET_FUNDING_PREFIX}/personal/status`, `${WALLET_FUNDING_PREFIX}/administrative/status`].includes(url.pathname)) {
      const reference = url.searchParams.get('checkoutReference');
      return UUID.test(reference || '') && url.search === `?checkoutReference=${reference}`;
    }
    const country = url.searchParams.get('country');
    const sourceCurrencyCode = url.searchParams.get('sourceCurrencyCode');
    if (sourceCurrencyCode !== null && !/^[A-Z]{3}$/.test(sourceCurrencyCode)) return false;
    const currencyQuery = sourceCurrencyCode === null ? '' : `&sourceCurrencyCode=${sourceCurrencyCode}`;
    if (url.pathname === `${WALLET_FUNDING_PREFIX}/personal/options`) return PERSONAL_COUNTRIES.has(country)
      && (sourceCurrencyCode === null || sourceCurrencyCode === 'USD' || (country === 'MX' && sourceCurrencyCode === 'MXN'))
      && url.search === `?country=${country}${currencyQuery}`;
    const provider = url.searchParams.get('serviceProvider');
    return env.MELD_ADMIN_SANDBOX_ENABLED === 'true' && url.pathname === `${WALLET_FUNDING_PREFIX}/administrative/options`
      && /^[A-Z]{2}$/.test(country || '') && ['TRANSAK', 'BANXA'].includes(provider)
      && url.search === `?country=${country}${currencyQuery}&serviceProvider=${provider}`;
  }
  const personal = url.pathname === `${WALLET_FUNDING_PREFIX}/personal/intent`;
  const administrative = url.pathname === `${WALLET_FUNDING_PREFIX}/administrative/session`;
  if (request.method !== 'POST' || (!personal && !administrative) || url.search
    || request.headers.has('content-encoding')
    || (personal ? !PERSONAL_ORIGINS.has(request.headers.get('origin')) : request.headers.get('origin') !== ADMINISTRATIVE_ORIGIN)
    || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')
    || !body?.length || body.length > WALLET_FUNDING_MAX_BODY) return false;
  if (administrative && env.MELD_ADMIN_SANDBOX_ENABLED !== 'true') return false;
  try {
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const allowed = ['requestId', 'walletAddress', 'country', 'amount', 'sourceCurrencyCode', 'paymentMethodType', ...(administrative ? ['serviceProvider'] : [])];
    const sourceCurrencyCode = input.sourceCurrencyCode === undefined ? 'USD' : input.sourceCurrencyCode;
    const localSpei = personal && input.country === 'MX' && sourceCurrencyCode === 'MXN' && input.paymentMethodType === 'SPEI';
    if (Object.keys(input).some(key => !allowed.includes(key)) || !UUID.test(input.requestId || '')
      || !/^0x[a-f0-9]{40}$/i.test(input.walletAddress || '') || !/^[A-Z]{2}$/.test(input.country || '')
      || (personal && (!PERSONAL_COUNTRIES.has(input.country) || PROHIBITED_PERSONAL_METHODS.has(input.paymentMethodType)
        || UNAVAILABLE_PERSONAL_METHODS.has(input.paymentMethodType)))
      || typeof sourceCurrencyCode !== 'string' || !/^[A-Z]{3}$/.test(sourceCurrencyCode)
      || (sourceCurrencyCode !== 'USD' && !localSpei)
      || typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < (sourceCurrencyCode === 'USD' ? (personal ? 30 : 50) : 931)
      || input.amount > (sourceCurrencyCode === 'USD' ? (personal ? 15000 : 25000) : 1_000_000_000)
      || Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 0.000001
      || typeof input.paymentMethodType !== 'string' || !/^[A-Z0-9_]{2,40}$/.test(input.paymentMethodType)) return false;
    return !administrative || ['TRANSAK', 'BANXA'].includes(input.serviceProvider);
  } catch { return false; }
}
