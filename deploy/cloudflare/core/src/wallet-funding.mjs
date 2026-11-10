export const WALLET_FUNDING_PREFIX = '/api/member/wallet-funding';
export const WALLET_FUNDING_MAX_BODY = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORIGINS = new Set(['https://app.mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev']);

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
    const country = url.searchParams.get('country');
    const provider = url.searchParams.get('serviceProvider');
    return env.MELD_ADMIN_SANDBOX_ENABLED === 'true' && url.pathname === `${WALLET_FUNDING_PREFIX}/administrative/options`
      && /^[A-Z]{2}$/.test(country || '') && ['TRANSAK', 'BANXA'].includes(provider)
      && url.search === `?country=${country}&serviceProvider=${provider}`;
  }
  const personal = url.pathname === `${WALLET_FUNDING_PREFIX}/personal/intent`;
  const administrative = url.pathname === `${WALLET_FUNDING_PREFIX}/administrative/session`;
  if (request.method !== 'POST' || (!personal && !administrative) || url.search
    || request.headers.has('content-encoding') || !ORIGINS.has(request.headers.get('origin'))
    || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')
    || !body?.length || body.length > WALLET_FUNDING_MAX_BODY) return false;
  if (administrative && env.MELD_ADMIN_SANDBOX_ENABLED !== 'true') return false;
  try {
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const allowed = ['requestId', 'walletAddress', 'country', 'amount', ...(administrative ? ['serviceProvider', 'paymentMethodType'] : [])];
    if (Object.keys(input).some(key => !allowed.includes(key)) || !UUID.test(input.requestId || '')
      || !/^0x[a-f0-9]{40}$/i.test(input.walletAddress || '') || !/^[A-Z]{2}$/.test(input.country || '')
      || typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 50 || input.amount > 25000
      || Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 0.000001) return false;
    return !administrative || (['TRANSAK', 'BANXA'].includes(input.serviceProvider)
      && (input.paymentMethodType === undefined || /^[A-Z0-9_]{2,40}$/.test(input.paymentMethodType)));
  } catch { return false; }
}
