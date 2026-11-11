export const COMPANY_PAYMENT_PREFIX = '/api/member/company-payments';
export const COMPANY_PAYMENT_MAX_BODY = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ORIGINS = new Set(['https://app.mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev']);
export function companyPaymentNamespace(path) { return path === COMPANY_PAYMENT_PREFIX || path.startsWith(`${COMPANY_PAYMENT_PREFIX}/`); }
/** A native personal-wallet receipt register, never an arbitrary transfer/credit API. */
export function companyPaymentRequest(request, url, body, env, ready) {
  if (!ready || env.PERSONAL_COMPANY_PAYMENTS_ENABLED !== 'true' || url.protocol !== 'https:' || url.host !== 'auth.core.internal'
    || !ORIGINS.has(request.headers.get('origin'))
    || request.headers.has('x-vp-act-as') || request.headers.has('content-encoding')
    || !/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=[^;\s,]+(?:;|$)/.test(request.headers.get('cookie') || '')
    || !/^[a-f0-9]{64}$/.test(request.headers.get('x-vp-auth-signature') || '')
    || !/^\d{10}$/.test(request.headers.get('x-vp-auth-timestamp') || '')
    || !/^[a-f0-9:.]{2,45}$/i.test(request.headers.get('x-vp-auth-client-ip') || '')) return false;
  if (request.method === 'GET') {
    if ([`${COMPANY_PAYMENT_PREFIX}/history`, `${COMPANY_PAYMENT_PREFIX}/balance`, `${COMPANY_PAYMENT_PREFIX}/balances`].includes(url.pathname)) return url.search === '';
    const paymentId = url.searchParams.get('paymentId');
    return url.pathname === `${COMPANY_PAYMENT_PREFIX}/status` && UUID.test(paymentId || '') && url.search === `?paymentId=${paymentId}`;
  }
  if (request.method !== 'POST' || url.search
    || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') || !body?.length || body.length > COMPANY_PAYMENT_MAX_BODY) return false;
  try {
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    if (url.pathname === `${COMPANY_PAYMENT_PREFIX}/prepare`) return Object.keys(input).length === 2 && UUID.test(input.requestId || '')
      && typeof input.amountAtomic === 'string' && /^[1-9][0-9]{0,77}$/.test(input.amountAtomic) && BigInt(input.amountAtomic) < (1n << 256n);
    if (url.pathname === `${COMPANY_PAYMENT_PREFIX}/submit`) return Object.keys(input).length === 2 && UUID.test(input.paymentId || '') && HASH.test(input.transactionHash || '');
    return ['verify', 'abandon'].some(action => url.pathname === `${COMPANY_PAYMENT_PREFIX}/${action}`)
      && Object.keys(input).length === 1 && UUID.test(input.paymentId || '');
  } catch { return false; }
}
