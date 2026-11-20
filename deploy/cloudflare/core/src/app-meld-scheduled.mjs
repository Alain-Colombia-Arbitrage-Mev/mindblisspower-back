import { createHash, createHmac } from 'node:crypto';
import { boundedBody, fetchWithDeadline } from './transport.mjs';

export const APP_MELD_RECONCILIATION_PATH = '/internal/app-meld-reconcile';
const unavailable = () => new Error('App MELD scheduled reconciliation unavailable');

/** Invoked by Core's scheduled handler with a fixed address and no member session. */
export async function runAppMeldScheduled(env, resolve, now = Date.now()) {
  if (env.CORE_ENV !== 'production' || env.APP_MELD_PRODUCTION_ENABLED !== 'true') return { enabled: false };
  const secret = env.API_BFF_SHARED_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096 || /[\r\n]/.test(secret)) throw unavailable();
  const timestamp = String(Math.floor(now / 1000)), body = '{}', loopback = '127.0.0.1';
  const hash = value => createHash('sha256').update(value).digest('hex');
  const signature = createHmac('sha256', secret)
    .update(['POST', APP_MELD_RECONCILIATION_PATH, timestamp, loopback, hash(''), hash(body)].join('\n')).digest('hex');
  const request = new Request(`https://auth.core.internal${APP_MELD_RECONCILIATION_PATH}`, {
    method: 'POST', redirect: 'manual', body,
    headers: { 'content-type': 'application/json', 'x-vp-auth-client-ip': loopback,
      'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': signature },
  });
  try {
    const response = await fetchWithDeadline(request, next => resolve('api', 'singleton').fetch(next), 50_000);
    if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      void response.body?.cancel().catch(() => {});
      throw unavailable();
    }
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(response, 128)));
    if (!payload || typeof payload !== 'object' || Object.keys(payload).length !== 1
      || !Number.isSafeInteger(payload.processed) || payload.processed < 0 || payload.processed > 5) throw unavailable();
    return { enabled: true, processed: payload.processed };
  } catch { throw unavailable(); }
}
