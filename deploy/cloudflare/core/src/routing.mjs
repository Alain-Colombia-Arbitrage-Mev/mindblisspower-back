import { NOWPAYMENTS_CHECKOUT, NOWPAYMENTS_MAX_INVOICE_BODY, nowpaymentsOperationalReady,
  operationalCheckoutRequest, parseCheckout, validOperationalInvoice } from './nowpayments-operation.mjs';
export { nowpaymentsOperationalReady } from './nowpayments-operation.mjs';

export const SERVICES = Object.freeze({
  'core.internal': 'api',
  'auth.core.internal': 'api',
  'engine.core.internal': 'engine',
  'payments.core.internal': 'payments',
  'withdrawals.core.internal': 'withdrawals',
});
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const MAX_BODY = 256 * 1024;
const MAX_NOWPAYMENTS_IPN_BODY = 128 * 1024;
const NOWPAYMENTS_IPN_PATH = '/api/webhooks/nowpayments';
const NOWPAYMENTS_STATUS_PATH = '/api/payments/nowpayments/status';
const NOW_CHECKOUT_ERRORS = new Set(['nowpayments-unavailable', 'nowpayments_financial_configuration_unavailable',
  'membership_eligibility_unavailable', 'membership_payment_pending_review']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GRPC_TUNNEL_HOST = 'engine-grpc.core.internal';
export const GRPC_TUNNEL_PATH = '/v1/engine-tunnel';
export const TUNNEL_PROTOCOL = 'mindbliss-opaque-tcp-v1';
const AUTH_ONLY_PATHS = Object.freeze({
  GET: new Set(['/api/auth/get-session', '/api/auth/jwks', '/api/auth/token', '/health']),
  POST: new Set(['/api/auth/email-otp/send-verification-otp', '/api/auth/sign-in/email-otp', '/api/auth/sign-out',
    '/api/auth/sign-up/email', '/api/auth/email-otp/verify-email', '/api/auth/sign-in/email']),
});

function failure(error, status) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export function coreReady(env) {
  return ['staging', 'production'].includes(env.CORE_ENV) && env.CORE_SERVICES_ENABLED === 'true'
    && env.CORE_NETWORK_VERIFIED === 'true' && env.CORE_DATA_ACCESS_VERIFIED === 'true';
}

/** Auth-only release does not assert that Go networking or financial rules work. */
export function authReady(env) {
  return ['staging', 'production'].includes(env.CORE_ENV) && env.AUTH_SERVICES_ENABLED === 'true'
    && env.CORE_DATA_ACCESS_VERIFIED === 'true' && env.AUTH_CUTOVER_VERIFIED === 'true';
}

/** Explicit report release, not an assertion that gRPC networking was verified. */
export function reportsReady(env) {
  return ['staging', 'production'].includes(env.CORE_ENV) && env.CORE_REPORTS_ENABLED === 'true'
    && env.CORE_DATA_ACCESS_VERIFIED === 'true' && env.AUTH_CUTOVER_VERIFIED === 'true';
}

/** Evidence capture is not permission to create an invoice or fulfil a purchase. */
export function nowpaymentsCaptureReady(env) {
  return authReady(env) && env.NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED === 'true';
}

function nowpaymentsCaptureRequest(request, url) {
  if (url.protocol !== 'https:' || url.hostname !== 'payments.core.internal') return false;
  if (url.pathname === NOWPAYMENTS_IPN_PATH) return request.method === 'POST' && !url.search;
  if (url.pathname !== NOWPAYMENTS_STATUS_PATH || request.method !== 'GET') return false;
  const order = url.searchParams.get('order_id');
  // No caller-selected account, pagination or provider endpoint may be forwarded.
  return UUID_PATTERN.test(order ?? '') && url.search === `?order_id=${order}`;
}

function reportOnlyRequest(request, url) {
  return url.protocol === 'https:' && ['payments.core.internal', 'withdrawals.core.internal'].includes(url.hostname)
    && ['GET', 'HEAD', 'OPTIONS'].includes(request.method) && url.pathname !== '/api/member/identity/claim';
}

function authOnlyRequest(request, url) {
  return url.protocol === 'https:' && url.hostname === 'auth.core.internal' && !url.search
    && Boolean(AUTH_ONLY_PATHS[request.method]?.has(url.pathname));
}

function blockedPhoneAuthPath(pathname) {
  let decodedPath = pathname;
  try {
    for (let index = 0; index < 8; index++) {
      const next = decodeURIComponent(decodedPath);
      if (next === decodedPath) break;
      decodedPath = next;
    }
  } catch { return true; }
  // Excessively nested encodings must not escape the namespace guards.
  return decodedPath.includes('%')
    || /^\/api\/auth\/(?:phone-number(?:\/|$)|sign-in\/phone-number(?:\/|$)|registration(?:\/|$))/.test(decodedPath);
}

export function isGrpcTunnelRequest(request) {
  try {
    const url = new URL(request.url);
    return url.protocol === 'http:' && url.hostname === GRPC_TUNNEL_HOST && !url.port && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === GRPC_TUNNEL_PATH && request.method === 'GET'
      && request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      && request.headers.get('sec-websocket-protocol') === TUNNEL_PROTOCOL;
  } catch { return false; }
}

/** Only ContainerProxy may call this route. A caller cannot select an origin. */
export async function dispatchContainerOutbound(source, request, env, resolve, internetFetch = fetch) {
  let url;
  try { url = new URL(request.url); } catch { return failure('not_found', 404); }
  if (url.hostname === 'api.nowpayments.io') {
    // Capture permits existing-payment verification. The separate operational
    // capability additionally permits only our bounded merchant invoice contract.
    if (source !== 'payments' || !nowpaymentsCaptureReady(env)) return failure('core_not_ready', 503);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
      || request.headers.has('upgrade')) return failure('not_found', 404);
    const paymentLookup = request.method === 'GET' && /^\/v1\/payment\/[1-9][0-9]{0,63}$/.test(url.pathname);
    const invoice = nowpaymentsOperationalReady(env) && request.method === 'POST' && url.pathname === '/v1/invoice';
    if (!paymentLookup && !invoice) return failure('not_found', 404);
    let invoiceBody;
    if (invoice) {
      if (request.headers.has('content-encoding') || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')
        || typeof env.NOWPAYMENTS_API_KEY !== 'string' || !env.NOWPAYMENTS_API_KEY
        || request.headers.get('x-api-key') !== env.NOWPAYMENTS_API_KEY) return failure('invalid_invoice_request', 400);
      try { invoiceBody = await boundedBody(request, NOWPAYMENTS_MAX_INVOICE_BODY); }
      catch { return failure('request_too_large', 413); }
      if (!invoiceBody?.length || !validOperationalInvoice(invoiceBody)) return failure('invalid_invoice_request', 400);
    }
    try {
      const forwarded = new Request(request, { ...(invoice ? { body: invoiceBody } : {}), redirect: 'manual',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]) });
      const response = await internetFetch(forwarded);
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        return failure('upstream_unavailable', 503);
      }
      return response;
    } catch { return failure('upstream_unavailable', 503); }
  }
  if (blockedPhoneAuthPath(url.pathname)) return failure('not_found', 404);
  const privateJwks = ['payments', 'withdrawals'].includes(source) && url.hostname === 'auth.core.internal'
    && url.protocol === 'https:' && !url.search && !url.port && !url.username && !url.password && !url.hash
    && !request.headers.has('upgrade') && request.method === 'GET' && url.pathname === '/api/auth/jwks';
  // Auth availability is independent of the Engine transport. This opens only
  // the public-key document, never a token, session, auth write or HTTP downgrade.
  if (privateJwks && authReady(env)) return dispatchCore(request, env, resolve);
  if (!coreReady(env)) return failure('core_not_ready', 503);
  if (source === 'api' && url.hostname === GRPC_TUNNEL_HOST) {
    if (!isGrpcTunnelRequest(request)) return failure('not_found', 404);
    return resolve('engine', 'singleton').fetch(request);
  }
  const nativeEngineHttp = ['api', 'payments'].includes(source) && url.hostname === 'engine.core.internal'
    && url.protocol === 'http:' && !url.search && ['GET', 'HEAD'].includes(request.method)
    && ['/health', '/ready', '/metrics'].includes(url.pathname);
  if (!nativeEngineHttp && !privateJwks) return failure('not_found', 404);
  return dispatchCore(request, env, resolve);
}

async function boundedBody(request, limit = MAX_BODY) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('body_limit');
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('body_limit'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return body;
}

// Preserve only reviewed NOW checkout error enums. A failure can follow invoice
// creation, so this never asserts that no external charge/invoice exists.
async function nowCheckoutFailure(response) {
  let reader, timer;
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
      || response.headers.has('content-encoding')) return failure('upstream_unavailable', 503);
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024)) return failure('upstream_unavailable', 503);
    reader = response.body?.getReader();
    if (!reader) return failure('upstream_unavailable', 503);
    const read = async () => {
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024) return null;
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return typeof value?.error === 'string' && NOW_CHECKOUT_ERRORS.has(value.error) ? value.error : null;
    };
    const code = await Promise.race([read(), new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
    return failure(code ?? 'upstream_unavailable', 503);
  } catch { return failure('upstream_unavailable', 503); }
  finally {
    clearTimeout(timer);
    // A malicious/broken stream cannot extend the response deadline via cancel.
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else { void response.body?.cancel().catch(() => {}); }
  }
}

/** Private service-binding dispatcher; never trusts a client-selected origin/header. */
export async function dispatchCore(request, env, resolve) {
  let url;
  try { url = new URL(request.url); } catch { return failure('invalid_request', 400); }
  if (!Object.hasOwn(SERVICES, url.hostname) || url.username || url.password || url.hash
    || !['http:', 'https:'].includes(url.protocol) || url.port) return failure('not_found', 404);
  // Registration and login are email-only. Old flags and provider credentials
  // cannot revive any phone-auth capability or start a Container for these paths.
  if (blockedPhoneAuthPath(url.pathname)) return failure('not_found', 404);
  if (!METHODS.has(request.method) || request.headers.has('upgrade')) return failure('method_not_allowed', 405);
  if (!['staging', 'production'].includes(env.CORE_ENV)) return failure('core_unconfigured', 503);
  // A GET resume link can create a new Stripe Checkout, so the generic read
  // allowlist is not sufficient. This independent provider gate never starts a
  // Container and does not change webhooks, reports or NOWPayments policy.
  let body;
  let checkoutPayload;
  let checkoutPath = url.pathname;
  try {
    for (let index = 0; index < 8; index++) {
      const next = decodeURIComponent(checkoutPath);
      if (next === checkoutPath) break;
      checkoutPath = next;
    }
  } catch { return failure('not_found', 404); }
  checkoutPath = checkoutPath.replace(/\/+/g, '/').replace(/\/+$/, '');
  // Scheduled processing is generated inside this Worker only. Never forward
  // this namespace from a portal, admin, public HTTP or private fetch caller.
  if (checkoutPath.startsWith('/api/payments/internal')) return failure('not_found', 404);
  const capturePath = [NOWPAYMENTS_IPN_PATH, NOWPAYMENTS_STATUS_PATH].includes(checkoutPath);
  const captureRequest = capturePath && nowpaymentsCaptureReady(env) && nowpaymentsCaptureRequest(request, url);
  // Reserved capture endpoints do not fall through the broad reports/read gate,
  // even if the regular infrastructure is ready or the path is encoded/aliased.
  if (capturePath && !captureRequest) return failure('nowpayments_capture_unavailable', 503);
  if (captureRequest && request.method === 'POST') {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')
      || request.headers.has('content-encoding')
      || !/^[a-f0-9]{128}$/i.test(request.headers.get('x-nowpayments-sig') ?? '')) return failure('invalid_webhook_request', 400);
    try { body = await boundedBody(request, MAX_NOWPAYMENTS_IPN_BODY); }
    catch { return failure('request_too_large', 413); }
    if (!body?.length) return failure('invalid_webhook_request', 400);
  }
  if (env.STRIPE_CHECKOUT_ENABLED !== 'true' && serviceHostname(url.hostname)) {
    if (checkoutPath === '/api/payments/resume') return failure('stripe_checkout_disabled', 503);
    if (checkoutPath === '/api/payments/checkout' && request.method === 'POST') {
      try { body = await boundedBody(request); }
      catch { return failure('request_too_large', 413); }
      if (!body?.length) return failure('stripe_checkout_disabled', 503);
      checkoutPayload = parseCheckout(body);
      if (!checkoutPayload) return failure('invalid_checkout_request', 400);
      if (typeof checkoutPayload.provider !== 'string' || checkoutPayload.provider.trim().toLowerCase() !== 'nowpayments') {
        return failure('stripe_checkout_disabled', 503);
      }
    }
  }
  let operationalCheckout = false;
  if (nowpaymentsOperationalReady(env) && checkoutPath === NOWPAYMENTS_CHECKOUT && request.method === 'POST') {
    try { body ??= await boundedBody(request); }
    catch { return failure('request_too_large', 413); }
    if ((body?.length ?? 0) > NOWPAYMENTS_MAX_INVOICE_BODY) return failure('request_too_large', 413);
    checkoutPayload ??= parseCheckout(body);
    operationalCheckout = operationalCheckoutRequest(request, url, checkoutPayload, env);
    if (!operationalCheckout) return failure('nowpayments_checkout_unavailable', 503);
  }
  // Exact auth routes can launch independently; this never starts Go, exposes a
  // business read, permits identity claims, or relaxes the financial write gate.
  const authOnly = !coreReady(env) && authReady(env) && authOnlyRequest(request, url);
  // Go's SERVICE_READ_ONLY router performs a second, exact endpoint allowlist.
  // The Worker release never permits methods that could mutate money or identity.
  const reportsOnly = !coreReady(env) && reportsReady(env) && reportOnlyRequest(request, url);
  if (!coreReady(env) && !authOnly && !reportsOnly && !captureRequest && !operationalCheckout) return failure('core_not_ready', 503);
  const service = SERVICES[url.hostname];
  // Infrastructure approval is not authorization to resume financial/business writes.
  const read = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const authWrite = service === 'api' && request.method === 'POST'
    && (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/member/identity/claim');
  if (!read && !authWrite && !captureRequest && !operationalCheckout) return failure('financial_review_required', 503);
  if (authWrite && env.AUTH_CUTOVER_VERIFIED !== 'true') return failure('authentication_not_ready', 503);
  try {
    body = read ? undefined : body ?? await boundedBody(request);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('content-length');
    headers.delete('cf-container-target-port');
    // No arbitrary target URL, no redirects followed by the gateway, no retries.
    const forwarded = new Request(request.url, {
      method: request.method, headers, body, redirect: 'manual', signal: request.signal,
    });
    const response = await resolve(service, 'singleton').fetch(forwarded);
    if (response.status >= 500) return operationalCheckout ? nowCheckoutFailure(response) : failure('upstream_unavailable', 503);
    const safeHeaders = new Headers(response.headers);
    safeHeaders.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: safeHeaders });
  } catch (error) {
    return failure(error?.message === 'body_limit' ? 'request_too_large' : 'upstream_unavailable', error?.message === 'body_limit' ? 413 : 503);
  }
}

function serviceHostname(hostname) {
  return ['payments.core.internal', 'core.internal'].includes(hostname);
}
