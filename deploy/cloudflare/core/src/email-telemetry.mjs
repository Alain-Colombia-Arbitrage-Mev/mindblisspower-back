import { createHash, createHmac } from 'node:crypto';
import { authTraceEnabled, emptyAuthTrace, validDeliveryTrace, validTraceSelector } from './auth-trace-store.mjs';
import { signedObservationRequest, readOperationalText } from './observability-store.mjs';

const unavailable = () => new Error('email_telemetry_unavailable');
// Only the fixed Bun readiness probe may wait for a cold container. Normal
// telemetry and storage calls retain their short deadline and never retry.
const API_READINESS_TIMEOUT_MS = 15_000;
const secretReady = env => typeof env.API_BFF_SHARED_SECRET === 'string' && env.API_BFF_SHARED_SECRET.length >= 32
  && env.API_BFF_SHARED_SECRET.length <= 4096 && !/[\r\n]/.test(env.API_BFF_SHARED_SECRET);

async function privateJson(resolve, request, maxBytes = 16 * 1024, timeoutMs = 3000) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([(async () => {
      const response = await resolve('api', 'singleton').fetch(request);
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw unavailable(); }
      if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
        void response.body?.cancel().catch(() => {}); throw unavailable();
      }
      return JSON.parse(await readOperationalText(response, maxBytes, controller.signal));
    })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, timeoutMs); })]);
  } catch { throw unavailable(); }
  finally { clearTimeout(timer); }
}

/** Portal binding capability: only a prevalidated pseudonymous projection. */
export async function recordDeliveryTelemetry(env, resolve, event, now = Date.now()) {
  if (!authTraceEnabled(env) || !secretReady(env) || !validDeliveryTrace(event, now)) throw unavailable();
  const result = await privateJson(resolve, signedObservationRequest(env, '/v1/delivery', event, now), 128);
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 || result.recorded !== true) throw unavailable();
  return { recorded: true };
}

/** The existing admin-only binding is the authorization boundary for this read. */
export async function privateAuthTrace(env, resolve, selector, now = Date.now()) {
  if (!validTraceSelector(selector)) throw unavailable();
  if (!authTraceEnabled(env)) return emptyAuthTrace(false);
  if (!secretReady(env)) throw unavailable();
  const result = await privateJson(resolve, signedObservationRequest(env, '/v1/trace-read', selector, now));
  // The DO produces the strict allowlisted projection; the BFF validates it
  // again before anything crosses its authenticated browser boundary.
  if (result?.version !== 1 || result.enabled !== true || !result.coverage || !Array.isArray(result.events) || result.events.length > 20) throw unavailable();
  return result;
}

export async function prunePrivateAuthTraces(env, resolve, now = Date.now()) {
  if (!authTraceEnabled(env)) return;
  if (!secretReady(env)) throw unavailable();
  const result = await privateJson(resolve, signedObservationRequest(env, '/v1/prune-traces', {}, now), 128);
  if (result?.recorded !== true) throw unavailable();
}

/** Fixed signed Bun -> DO TLS probe. No user, OTP, provider or durable write. */
export async function authTraceTransportReadiness(env, resolve, now = Date.now()) {
  if (!authTraceEnabled(env) || !secretReady(env)) return { ready: false };
  const path = '/internal/otp-trace-readiness';
  const timestamp = String(Math.floor(now / 1000));
  const raw = '{}';
  const signature = createHmac('sha256', env.API_BFF_SHARED_SECRET).update(['POST', path, timestamp, '127.0.0.1',
    createHash('sha256').update('').digest('hex'), createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
  try {
    const result = await privateJson(resolve, new Request(`https://auth.core.internal${path}`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-vp-auth-client-ip': '127.0.0.1',
        'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': signature }, body: raw, signal: AbortSignal.timeout(API_READINESS_TIMEOUT_MS) }), 128, API_READINESS_TIMEOUT_MS);
    return { ready: result?.ready === true && Object.keys(result).length === 1 };
  } catch { return { ready: false }; }
}

const classifications = new Map([
  ['observability_disabled', 'gate_closed'], ['unauthorized', 'unauthorized'], ['invalid_auth_proxy', 'unauthorized'],
  ['unauthenticated', 'unauthorized'], ['invalid_request', 'invalid_request'], ['invalid_observation', 'invalid_request'],
  ['request_too_large', 'invalid_request'], ['not_found', 'invalid_request'],
  ['observability_unavailable', 'unavailable'], ['otp_trace_unavailable', 'unavailable'],
]);
async function readinessStep(resolve, request, acknowledgement, timeoutMs = 3000) {
  let timer;
  const controller = new AbortController();
  const operation = (async () => {
    const response = await resolve('api', 'singleton').fetch(request);
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined;
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); return { ready: false, status, classification: 'unavailable' }; }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
      void response.body?.cancel().catch(() => {}); return { ready: false, status, classification: 'unknown' };
    }
    let value;
    try { value = JSON.parse(await readOperationalText(response, 256, controller.signal)); }
    catch { return { ready: false, status, classification: 'unknown' }; }
    const object = value && typeof value === 'object' && !Array.isArray(value);
    if (status === 200 && object && Object.keys(value).length === 1 && value[acknowledgement] === true) return { ready: true, status };
    return { ready: false, status, classification: object && Object.keys(value).length === 1
      && typeof value.error === 'string' ? classifications.get(value.error) || 'unknown' : 'unknown' };
  })();
  try {
    return await Promise.race([operation, new Promise(resolve => { timer = setTimeout(() => {
      controller.abort(); resolve({ ready: false, classification: 'unavailable' });
    }, timeoutMs); })]);
  } catch { return { ready: false, classification: 'unavailable' }; }
  finally { clearTimeout(timer); }
}

/** Status/enums only: distinguishes the fixed DO sink from Bun TLS transport.
 * No environment, body, header, key, recipient or error text may cross this RPC.
 */
export async function authTraceReadinessDiagnostics(env, resolve, now = Date.now()) {
  if (!authTraceEnabled(env)) return { phase: 'unavailable', ready: false, classification: 'gate_closed' };
  if (!secretReady(env)) return { phase: 'unavailable', ready: false, classification: 'unavailable' };
  const sink = await readinessStep(resolve, signedObservationRequest(env, '/v1/probe', {}, now), 'recorded');
  const storageStatus = sink.status === undefined ? {} : { storage_status: sink.status };
  if (!sink.ready) return { phase: 'storage', ready: false, ...storageStatus, classification: sink.classification };
  const path = '/internal/otp-trace-readiness';
  const timestamp = String(Math.floor(now / 1000));
  const raw = '{}';
  const signature = createHmac('sha256', env.API_BFF_SHARED_SECRET).update(['POST', path, timestamp, '127.0.0.1',
    createHash('sha256').update('').digest('hex'), createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
  const api = await readinessStep(resolve, new Request(`https://auth.core.internal${path}`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', 'x-vp-auth-client-ip': '127.0.0.1', 'x-vp-auth-timestamp': timestamp,
      'x-vp-auth-signature': signature }, body: raw, signal: AbortSignal.timeout(API_READINESS_TIMEOUT_MS) }), 'ready', API_READINESS_TIMEOUT_MS);
  return { phase: api.ready ? 'complete' : 'api', ready: api.ready, ...storageStatus,
    ...(api.status === undefined ? {} : { api_status: api.status }), ...(api.ready ? {} : { classification: api.classification }) };
}
