export const POLYGON_RELAY_PREFIX = '/api/member/polygon-relay';
export const POLYGON_RELAY_MAX_BODY = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ORIGINS = new Set(['https://mindblisspower.com', 'https://app.mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev']);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function polygonRelayNamespace(path) { return path === POLYGON_RELAY_PREFIX || path.startsWith(`${POLYGON_RELAY_PREFIX}/`); }

/** Only the reviewed Polygon native authorization may reach the API. This is
 * never an arbitrary RPC, signing, token approval or user-operation endpoint. */
export function polygonRelayRequest(request, url, body, env, ready) {
  const cookie = request.headers.get('cookie') || '';
  if (!ready || env.PERSONAL_POLYGON_RELAY_ENABLED !== 'true' || url.protocol !== 'https:' || url.host !== 'auth.core.internal'
    || !ORIGINS.has(request.headers.get('origin')) || request.headers.has('x-vp-act-as') || request.headers.has('content-encoding')
    || cookie.length > 8192 || !/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=[^;\s,]+(?:;|$)/.test(cookie)
    || !/^[a-f0-9]{64}$/.test(request.headers.get('x-vp-auth-signature') || '')
    || !/^\d{10}$/.test(request.headers.get('x-vp-auth-timestamp') || '')
    || !/^[a-f0-9:.]{2,45}$/i.test(request.headers.get('x-vp-auth-client-ip') || '')) return false;
  if (request.method === 'GET') {
    if ([`${POLYGON_RELAY_PREFIX}/capabilities`, `${POLYGON_RELAY_PREFIX}/history`].includes(url.pathname)) return url.search === '';
    const paymentId = url.searchParams.get('paymentId');
    return url.pathname === `${POLYGON_RELAY_PREFIX}/status` && UUID.test(paymentId || '') && url.search === `?paymentId=${paymentId}`;
  }
  if (request.method !== 'POST' || url.search || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')
    || !body?.length || body.length > POLYGON_RELAY_MAX_BODY) return false;
  try {
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    // Reconciliation and discarding an unsigned preparation remain available
    // after broadcasting is paused. The API/SQL reject accepted authorizations.
    if (['verify', 'abandon'].some(action => url.pathname === `${POLYGON_RELAY_PREFIX}/${action}`)) return exact(input, ['paymentId']) && UUID.test(input.paymentId || '');
    if (env.PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED !== 'true') return false;
    if (url.pathname === `${POLYGON_RELAY_PREFIX}/prepare`) return exact(input, ['requestId', 'amountAtomic']) && UUID.test(input.requestId || '')
      && typeof input.amountAtomic === 'string' && /^[1-9][0-9]{0,77}$/.test(input.amountAtomic) && BigInt(input.amountAtomic) < (1n << 256n);
    if (url.pathname === `${POLYGON_RELAY_PREFIX}/authorize`) return exact(input, ['paymentId', 'signature']) && UUID.test(input.paymentId || '')
      && typeof input.signature === 'string' && /^0x[0-9a-f]{130}$/.test(input.signature);
    return url.pathname === `${POLYGON_RELAY_PREFIX}/submit` && exact(input, ['paymentId']) && UUID.test(input.paymentId || '');
  } catch { return false; }
}
