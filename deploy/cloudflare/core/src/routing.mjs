export const SERVICES = Object.freeze({
  'core.internal': 'api',
  'auth.core.internal': 'api',
  'engine.core.internal': 'engine',
  'payments.core.internal': 'payments',
  'withdrawals.core.internal': 'withdrawals',
});
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const MAX_BODY = 256 * 1024;
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

function reportOnlyRequest(request, url) {
  return url.protocol === 'https:' && ['payments.core.internal', 'withdrawals.core.internal'].includes(url.hostname)
    && ['GET', 'HEAD', 'OPTIONS'].includes(request.method) && url.pathname !== '/api/member/identity/claim';
}

function authOnlyRequest(request, url) {
  return url.protocol === 'https:' && url.hostname === 'auth.core.internal' && !url.search
    && Boolean(AUTH_ONLY_PATHS[request.method]?.has(url.pathname));
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
export async function dispatchContainerOutbound(source, request, env, resolve) {
  let url;
  try { url = new URL(request.url); } catch { return failure('not_found', 404); }
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

async function boundedBody(request) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new Error('body_limit');
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error('body_limit'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
  return body;
}

/** Private service-binding dispatcher; never trusts a client-selected origin/header. */
export async function dispatchCore(request, env, resolve) {
  let url;
  try { url = new URL(request.url); } catch { return failure('invalid_request', 400); }
  if (!Object.hasOwn(SERVICES, url.hostname) || url.username || url.password || url.hash
    || !['http:', 'https:'].includes(url.protocol) || url.port) return failure('not_found', 404);
  if (!METHODS.has(request.method) || request.headers.has('upgrade')) return failure('method_not_allowed', 405);
  if (!['staging', 'production'].includes(env.CORE_ENV)) return failure('core_unconfigured', 503);
  // Exact auth routes can launch independently; this never starts Go, exposes a
  // business read, permits identity claims, or relaxes the financial write gate.
  const authOnly = !coreReady(env) && authReady(env) && authOnlyRequest(request, url);
  // Go's SERVICE_READ_ONLY router performs a second, exact endpoint allowlist.
  // The Worker release never permits methods that could mutate money or identity.
  const reportsOnly = !coreReady(env) && reportsReady(env) && reportOnlyRequest(request, url);
  if (!coreReady(env) && !authOnly && !reportsOnly) return failure('core_not_ready', 503);
  const service = SERVICES[url.hostname];
  // Infrastructure approval is not authorization to resume financial/business writes.
  const read = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const authWrite = service === 'api' && request.method === 'POST'
    && (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/member/identity/claim');
  if (!read && !authWrite) return failure('financial_review_required', 503);
  if (authWrite && env.AUTH_CUTOVER_VERIFIED !== 'true') return failure('authentication_not_ready', 503);
  try {
    const body = read ? undefined : await boundedBody(request);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('content-length');
    headers.delete('cf-container-target-port');
    // No arbitrary target URL, no redirects followed by the gateway, no retries.
    const forwarded = new Request(request.url, {
      method: request.method, headers, body, redirect: 'manual', signal: request.signal,
    });
    const response = await resolve(service, 'singleton').fetch(forwarded);
    if (response.status >= 500) return failure('upstream_unavailable', 503);
    const safeHeaders = new Headers(response.headers);
    safeHeaders.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: safeHeaders });
  } catch (error) {
    return failure(error?.message === 'body_limit' ? 'request_too_large' : 'upstream_unavailable', error?.message === 'body_limit' ? 413 : 503);
  }
}
