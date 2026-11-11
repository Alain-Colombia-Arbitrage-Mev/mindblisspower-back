export const COMPANY_PAYMENT_PREFIX = '/api/member/company-payments';
export const COMPANY_PAYMENT_MAX_BODY = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ORIGINS = new Set(['https://app.mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev']);
const CLIENT_EVENTS = new Set(['wallet_prompt_opened', 'wallet_rejected', 'wallet_failed', 'broadcast_uncertain',
  'broadcast_observed', 'recovery_detected', 'registration_failed', 'verification_requested', 'verification_failed']);
const EVENT_CODES = new Set(['user_rejected', 'wallet_changed', 'network_changed', 'rpc_unavailable',
  'registration_unavailable', 'verification_unavailable', 'recovery_unavailable', 'unknown']);
const HASH_EVENTS = new Set(['broadcast_observed', 'recovery_detected', 'registration_failed', 'verification_requested', 'verification_failed']);
function activityQuery(url, paymentRequired) {
  const params = url.searchParams, keys = Array.from(params.keys());
  const canonical = new URLSearchParams();
  for (const key of ['paymentId', 'limit', 'cursor']) if (params.has(key)) canonical.set(key, params.get(key));
  if (new Set(keys).size !== keys.length || keys.some(key => !(paymentRequired ? ['paymentId', 'cursor', 'limit'] : ['cursor', 'limit']).includes(key))
    || (paymentRequired && !UUID.test(params.get('paymentId') || ''))
    || (params.has('cursor') && !UUID.test(params.get('cursor') || ''))
    || (params.has('limit') && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(params.get('limit') || ''))
    || (url.search && url.search !== `?${canonical.toString()}`)) return false;
  return true;
}
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
    if (url.pathname === `${COMPANY_PAYMENT_PREFIX}/events`) return activityQuery(url, true);
    if (url.pathname === `${COMPANY_PAYMENT_PREFIX}/activity`) return activityQuery(url, false);
    const paymentId = url.searchParams.get('paymentId');
    return url.pathname === `${COMPANY_PAYMENT_PREFIX}/status` && UUID.test(paymentId || '') && url.search === `?paymentId=${paymentId}`;
  }
  if (request.method !== 'POST' || url.search
    || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') || !body?.length || body.length > COMPANY_PAYMENT_MAX_BODY) return false;
  try {
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    if (url.pathname === `${COMPANY_PAYMENT_PREFIX}/events`) {
      return Object.keys(input).every(key => ['eventId', 'paymentId', 'attemptId', 'event', 'transactionHash', 'code'].includes(key))
        && UUID.test(input.eventId || '') && UUID.test(input.paymentId || '') && CLIENT_EVENTS.has(input.event)
        && (!Object.hasOwn(input, 'attemptId') || UUID.test(input.attemptId || ''))
        && (!Object.hasOwn(input, 'code') || EVENT_CODES.has(input.code))
        && (!Object.hasOwn(input, 'transactionHash') || (HASH_EVENTS.has(input.event) && HASH.test(input.transactionHash || '')))
        && (input.event !== 'broadcast_observed' || HASH.test(input.transactionHash || ''));
    }
    if (url.pathname === `${COMPANY_PAYMENT_PREFIX}/prepare`) {
      const keys = Object.keys(input);
      return [2, 3].includes(keys.length) && keys.every(key => ['requestId', 'amountAtomic', 'chainId'].includes(key))
        && (input.chainId === undefined || input.chainId === 1 || input.chainId === 137) && UUID.test(input.requestId || '')
        && typeof input.amountAtomic === 'string' && /^[1-9][0-9]{0,77}$/.test(input.amountAtomic) && BigInt(input.amountAtomic) < (1n << 256n);
    }
    if (url.pathname === `${COMPANY_PAYMENT_PREFIX}/submit`) return Object.keys(input).length === 2 && UUID.test(input.paymentId || '') && HASH.test(input.transactionHash || '');
    return ['verify', 'abandon'].some(action => url.pathname === `${COMPANY_PAYMENT_PREFIX}/${action}`)
      && Object.keys(input).length === 1 && UUID.test(input.paymentId || '');
  } catch { return false; }
}
