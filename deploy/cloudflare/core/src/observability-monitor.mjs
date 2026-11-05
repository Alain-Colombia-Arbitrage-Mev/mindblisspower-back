import { collectOperationalProviders } from './observability-collectors.mjs';
import { operationalMonitoringEnabled, signedObservationRequest, unknownOperationalSnapshot, readOperationalText } from './observability-store.mjs';
import { authTraceEnabled } from './auth-trace-store.mjs';

async function privateRead(response, signal, max = 32 * 1024) {
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    void response.body?.cancel().catch(() => {}); throw new Error('observability_unavailable');
  }
  return JSON.parse(await readOperationalText(response, max, signal));
}

async function boundedOperation(resolve, request) {
  let timer;
  const controller = new AbortController();
  try {
    return await Promise.race([(async () => {
      const response = await resolve('api', 'singleton').fetch(request);
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('observability_unavailable'); }
      return privateRead(response, controller.signal);
    })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('observability_unavailable')); }, 3000); })]);
  } finally { clearTimeout(timer); }
}

// One scheduled provider read, never a health sweep or a database query. The
// API Durable Object handles this URL in storage WITHOUT starting its Container.
export async function runOperationalMonitoring(env, resolve, dependencies = {}) {
  if (!operationalMonitoringEnabled(env)) return;
  const snapshot = await collectOperationalProviders(env, dependencies);
  const result = await boundedOperation(resolve, signedObservationRequest(env, '/v1/refresh', snapshot));
  if (result.recorded !== true) throw new Error('observability_unavailable');
}

// Named service RPC only: no browser-selected target, no provider calls per
// administrator, no account identity or sending/monitoring credentials returned.
export async function privateOperationalSnapshot(env, resolve, now = Date.now()) {
  if (!operationalMonitoringEnabled(env) && !authTraceEnabled(env)) return unknownOperationalSnapshot(false, now);
  try {
    const result = await boundedOperation(resolve, signedObservationRequest(env, '/v1/snapshot', undefined, now));
    if (result.version !== 1 || !Array.isArray(result.email) || !Array.isArray(result.infrastructure) || !Array.isArray(result.alerts)) throw new Error('invalid_snapshot');
    return result;
  } catch { return unknownOperationalSnapshot(operationalMonitoringEnabled(env), now); }
}
