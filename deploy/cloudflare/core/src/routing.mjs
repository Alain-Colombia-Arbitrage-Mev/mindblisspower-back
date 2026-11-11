import { NOWPAYMENTS_CHECKOUT, NOWPAYMENTS_MAX_INVOICE_BODY, nowpaymentsOperationalReady,
  operationalCheckoutRequest, parseCheckout, validOperationalInvoice } from './nowpayments-operation.mjs';
import { NOWPAYMENTS_PURCHASE_MAX_BODY, nowpaymentsPurchaseRequest, purchasesNamespace } from './nowpayments-purchases.mjs';
import { REFERRAL_ATTRIBUTION_MAX_BODY, referralAttributionRequest, referralAttributionNamespace } from './referral-attribution.mjs';
import { boundedBody as readBoundedBody, fetchWithDeadline } from './transport.mjs';
import { authTraceEnabled } from './auth-trace-store.mjs';
import { WALLET_FUNDING_MAX_BODY, walletFundingNamespace, walletFundingRequest } from './wallet-funding.mjs';
import { COMPANY_PAYMENT_MAX_BODY, companyPaymentNamespace, companyPaymentRequest } from './company-payments.mjs';
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
const MAX_MELD_WEBHOOK_BODY = 128 * 1024;
const NOWPAYMENTS_IPN_PATH = '/api/webhooks/nowpayments';
const MELD_WEBHOOK_PATH = '/api/webhooks/meld';
const NOWPAYMENTS_STATUS_PATH = '/api/payments/nowpayments/status';
const OTP_DIAGNOSTIC_PATH = '/api/admin/auth/otp-diagnostic';
const NOW_CHECKOUT_ERRORS = new Set(['nowpayments-unavailable', 'nowpayments_financial_configuration_unavailable',
  'membership_eligibility_unavailable', 'membership_payment_pending_review']);
const FUNDING_SERVICE_ERRORS = new Set(['wallet_funding_unconfigured', 'wallet_funding_provider_unavailable',
  'wallet_funding_valuation_unavailable', 'wallet_funding_unavailable']);
const ADMINISTRATIVE_FUNDING_SERVICE_ERRORS = new Set([...FUNDING_SERVICE_ERRORS, 'wallet_funding_provider_authentication_unavailable']);
const COMPANY_PAYMENT_SERVICE_ERRORS = new Set(['company_payment_unconfigured', 'company_payment_rpc_unavailable', 'company_payment_unavailable']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GRPC_TUNNEL_HOST = 'engine-grpc.core.internal';
export const GRPC_TUNNEL_PATH = '/v1/engine-tunnel';
export const TUNNEL_PROTOCOL = 'mindbliss-opaque-tcp-v1';
const AUTH_ONLY_PATHS = Object.freeze({
  GET: new Set(['/api/auth/get-session', '/api/auth/jwks', '/api/auth/token', '/health']),
  POST: new Set(['/api/auth/email-otp/send-verification-otp', '/api/auth/sign-in/email-otp', '/api/auth/sign-out',
    '/api/auth/sign-up/email', '/api/auth/email-otp/verify-email', '/api/auth/sign-in/email',
    '/api/auth/email-otp/request-password-reset', '/api/auth/email-otp/reset-password']),
});
const WALLET_LINK_PATHS = Object.freeze({
  GET: new Set(['/api/member/wallet-link', '/api/member/administrative-wallet']),
  POST: new Set(['/api/member/wallet-link/challenge', '/api/member/wallet-link/confirm',
    '/api/member/administrative-wallet/ensure']),
});

function failure(error, status) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function bodyReadFailure(error) {
  return error?.message === 'body_limit' ? failure('request_too_large', 413) : failure('upstream_unavailable', 503);
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

function walletLinkRequest(request, url) {
  if (url.protocol !== 'https:' || url.hostname !== 'auth.core.internal' || url.search
    || !WALLET_LINK_PATHS[request.method]?.has(url.pathname)) return false;
  if (request.method === 'GET') return true;
  if (url.pathname === '/api/member/administrative-wallet/ensure') {
    return typeof request.headers.get('origin') === 'string' && !request.headers.has('content-encoding')
      && /^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '');
  }
  return !request.headers.has('content-encoding')
    && /^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')
    && typeof request.headers.get('origin') === 'string';
}

function meldWebhookRequest(request, url, env) {
  return envMeldWebhookReady(env) && url.protocol === 'https:' && url.hostname === 'auth.core.internal'
    && url.pathname === MELD_WEBHOOK_PATH && !url.search && request.method === 'POST'
    && !request.headers.has('content-encoding')
    && /^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')
    && /^[A-Za-z0-9_-]{43}={0,1}$/.test(request.headers.get('meld-signature') || '')
    && typeof request.headers.get('meld-signature-timestamp') === 'string';
}

function envMeldWebhookReady(env) {
  return authReady(env) && env.MELD_WEBHOOK_ENABLED === 'true';
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
  if (url.hostname === 'observability.core.internal') {
    // Only API-container egress can submit terminal mail observations. Reads
    // and provider refreshes are generated inside this Worker, never forwarded.
    const enabled = url.pathname === '/v1/email' ? env.CORE_OBSERVABILITY_ENABLED === 'true'
      : ['/v1/trace', '/v1/probe'].includes(url.pathname) && authTraceEnabled(env);
    if (source !== 'api' || !enabled || !authReady(env)) return failure('not_found', 404);
    if (url.protocol !== 'https:' || url.search || url.port || url.username || url.password || url.hash
      || request.method !== 'POST' || request.headers.has('upgrade')) return failure('not_found', 404);
    return resolve('api', 'singleton').fetch(request);
  }
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
      catch (error) { return bodyReadFailure(error); }
      if (!invoiceBody?.length || !validOperationalInvoice(invoiceBody)) return failure('invalid_invoice_request', 400);
    }
    try {
      const forwarded = new Request(request, { ...(invoice ? { body: invoiceBody } : {}), redirect: 'manual',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]) });
      const response = await fetchWithDeadline(forwarded, internetFetch, 12_000);
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

const boundedBody = (request, limit = MAX_BODY) => readBoundedBody(request, limit);

// Preserve only reviewed error enums, never provider messages or response headers.
// A failure can follow session/invoice creation and never proves settlement.
async function reviewedUpstreamFailure(response, allowedErrors) {
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
      return typeof value?.error === 'string' && allowedErrors.has(value.error) ? value.error : null;
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
  // This capability is a signed admin read, not a generic auth/admin write.
  // Bun verifies the full-path HMAC, native session and live canonical role.
  // Encoded aliases, query selectors and broad-Core fallthrough stay closed.
  let diagnosticRequest = false;
  if (checkoutPath === OTP_DIAGNOSTIC_PATH || checkoutPath.startsWith(`${OTP_DIAGNOSTIC_PATH}/`)) {
    if (!reportsReady(env) || !authReady(env) || url.protocol !== 'https:' || url.hostname !== 'auth.core.internal'
      || url.pathname !== OTP_DIAGNOSTIC_PATH || url.search || request.method !== 'POST'
      || request.headers.has('content-encoding') || request.headers.has('x-vp-act-as')
      || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')
      || !/^[a-f0-9]{64}$/.test(request.headers.get('x-vp-auth-signature') || '')
      || !/^\d{10}$/.test(request.headers.get('x-vp-auth-timestamp') || '')
      || !/^[a-f0-9:.]{2,45}$/i.test(request.headers.get('x-vp-auth-client-ip') || '')
      || !(request.headers.get('cookie')?.length > 0) || request.headers.get('cookie').length > 8192) return failure('diagnostic_service_unavailable', 503);
    try {
      const origin = request.headers.get('origin');
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin) return failure('invalid_diagnostic_request', 400);
      body = await boundedBody(request, 2048);
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
        || typeof input.email !== 'string' || input.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return failure('invalid_diagnostic_request', 400);
    } catch (error) { return error?.message === 'body_limit' ? failure('request_too_large', 413) : failure('invalid_diagnostic_request', 400); }
    diagnosticRequest = true;
  }
  // Scheduled processing is generated inside this Worker only. Never forward
  // this namespace from a portal, admin, public HTTP or private fetch caller.
  if (checkoutPath.startsWith('/api/payments/internal')) return failure('not_found', 404);
  const fundingPath = walletFundingNamespace(checkoutPath);
  let fundingRequest = false;
  if (fundingPath) {
    if (request.method === 'POST') {
      try { body = await boundedBody(request, WALLET_FUNDING_MAX_BODY); }
      catch (error) { return bodyReadFailure(error); }
    }
    fundingRequest = walletFundingRequest(request, url, body, env, authReady(env));
    if (!fundingRequest) return failure('wallet_funding_unavailable', 503);
  }
  const companyPath = companyPaymentNamespace(checkoutPath);
  let companyRequest = false;
  if (companyPath) {
    if (request.method === 'POST') {
      try { body = await boundedBody(request, COMPANY_PAYMENT_MAX_BODY); }
      catch (error) { return bodyReadFailure(error); }
    }
    companyRequest = companyPaymentRequest(request, url, body, env, authReady(env));
    if (!companyRequest) return failure('company_payment_unavailable', 503);
  }
  const referralPath = referralAttributionNamespace(checkoutPath);
  let referralRequest = false;
  if (referralPath) {
    if (request.method === 'POST') {
      try { body = await boundedBody(request, REFERRAL_ATTRIBUTION_MAX_BODY); }
      catch (error) { return bodyReadFailure(error); }
    }
    referralRequest = referralAttributionRequest(request, url, body, env, reportsReady(env) && authReady(env));
    // Reserved even when broad Core is enabled: never fall through to generic
    // report GETs or financial writes, aliases, ActAs or old registration APIs.
    if (!referralRequest) return failure('referral_service_unavailable', 503);
  }
  const purchasePath = purchasesNamespace(checkoutPath);
  let purchaseRequest = false;
  if (purchasePath) {
    if (request.method === 'POST') {
      try { body = await boundedBody(request, NOWPAYMENTS_PURCHASE_MAX_BODY); }
      catch (error) { return bodyReadFailure(error); }
    }
    purchaseRequest = nowpaymentsPurchaseRequest(request, url, body, env, reportsReady(env) && authReady(env));
    // Reserved paths never fall through generic report or full-Core gates.
    if (!purchaseRequest) return failure('purchase_service_unavailable', 503);
  }
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
    catch (error) { return bodyReadFailure(error); }
    if (!body?.length) return failure('invalid_webhook_request', 400);
  }
  const meldPath = checkoutPath === MELD_WEBHOOK_PATH;
  const meldWebhook = meldPath && meldWebhookRequest(request, url, env);
  if (meldPath && !meldWebhook) return failure('meld_webhook_unavailable', 503);
  if (meldWebhook) {
    try { body = await boundedBody(request, MAX_MELD_WEBHOOK_BODY); }
    catch (error) { return bodyReadFailure(error); }
    if (!body?.length) return failure('invalid_webhook_request', 400);
  }
  if (env.STRIPE_CHECKOUT_ENABLED !== 'true' && serviceHostname(url.hostname)) {
    if (checkoutPath === '/api/payments/resume') return failure('stripe_checkout_disabled', 503);
    if (checkoutPath === '/api/payments/checkout' && request.method === 'POST') {
      try { body = await boundedBody(request); }
      catch (error) { return bodyReadFailure(error); }
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
    catch (error) { return bodyReadFailure(error); }
    if ((body?.length ?? 0) > NOWPAYMENTS_MAX_INVOICE_BODY) return failure('request_too_large', 413);
    checkoutPayload ??= parseCheckout(body);
    operationalCheckout = operationalCheckoutRequest(request, url, checkoutPayload, env);
    if (!operationalCheckout) return failure('nowpayments_checkout_unavailable', 503);
  }
  // Exact auth routes can launch independently; this never starts Go, exposes a
  // business read, permits identity claims, or relaxes the financial write gate.
  const authOnly = !coreReady(env) && authReady(env) && authOnlyRequest(request, url);
  const walletLink = authReady(env) && walletLinkRequest(request, url);
  // Go's SERVICE_READ_ONLY router performs a second, exact endpoint allowlist.
  // The Worker release never permits methods that could mutate money or identity.
  const reportsOnly = !coreReady(env) && reportsReady(env) && reportOnlyRequest(request, url);
  if (!coreReady(env) && !authOnly && !walletLink && !reportsOnly && !captureRequest && !meldWebhook && !operationalCheckout && !purchaseRequest && !referralRequest && !diagnosticRequest && !fundingRequest && !companyRequest) return failure('core_not_ready', 503);
  const service = SERVICES[url.hostname];
  // Infrastructure approval is not authorization to resume financial/business writes.
  const read = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const authWrite = service === 'api' && request.method === 'POST'
    && (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/member/identity/claim' || walletLink || meldWebhook);
  if (!read && !authWrite && !captureRequest && !meldWebhook && !operationalCheckout && !purchaseRequest && !referralRequest && !diagnosticRequest && !fundingRequest && !companyRequest) return failure('financial_review_required', 503);
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
    const container = resolve(service, 'singleton');
    const response = await fetchWithDeadline(forwarded, input => container.fetch(input));
    if (response.status >= 500) {
      if (companyRequest) return reviewedUpstreamFailure(response, COMPANY_PAYMENT_SERVICE_ERRORS);
      if (operationalCheckout) return reviewedUpstreamFailure(response, NOW_CHECKOUT_ERRORS);
      if (fundingRequest) return reviewedUpstreamFailure(response,
        url.pathname === '/api/member/wallet-funding/administrative/session'
          ? ADMINISTRATIVE_FUNDING_SERVICE_ERRORS : FUNDING_SERVICE_ERRORS);
      void response.body?.cancel().catch(() => {});
      return failure('upstream_unavailable', 503);
    }
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
