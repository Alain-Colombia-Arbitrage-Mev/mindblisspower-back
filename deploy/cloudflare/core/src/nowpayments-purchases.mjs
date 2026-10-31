import { nowpaymentsOperationalReady } from './nowpayments-operation.mjs';

export const NOWPAYMENTS_PURCHASES = '/api/payments/nowpayments/purchases';
export const NOWPAYMENTS_PURCHASE_MAX_BODY = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function purchasesNamespace(normalizedPath) {
  return normalizedPath === NOWPAYMENTS_PURCHASES || normalizedPath.startsWith(`${NOWPAYMENTS_PURCHASES}/`);
}

// This private gateway cannot select an owner, provider endpoint or refund.
// The Go handler separately verifies the signature, binding and current state.
export function nowpaymentsPurchaseRequest(request, url, bytes, env, historyReady) {
  if (url.protocol !== 'https:' || url.hostname !== 'payments.core.internal' || url.search || url.href.endsWith('?')
    || request.headers.has('content-encoding')
    || typeof env.PAYMENTS_SERVICE_TOKEN !== 'string' || env.PAYMENTS_SERVICE_TOKEN.length < 16
    || request.headers.get('x-vp-service-token') !== env.PAYMENTS_SERVICE_TOKEN
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(request.headers.get('x-vp-id-token') ?? '')
    || (request.headers.get('x-vp-id-token')?.length ?? 0) > 16384
    || request.headers.has('x-vp-act-as')) return false;
  if (request.method === 'GET') return historyReady && url.pathname === NOWPAYMENTS_PURCHASES;
  if (!nowpaymentsOperationalReady(env) || request.method !== 'POST'
    || ![`${NOWPAYMENTS_PURCHASES}/resume`, `${NOWPAYMENTS_PURCHASES}/cancel`].includes(url.pathname)
    || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')
    || !bytes?.length || bytes.length > NOWPAYMENTS_PURCHASE_MAX_BODY) return false;
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // One literal field only: escaped/duplicate keys and owner overrides cannot
    // acquire different meanings in the Worker, BFF and Go JSON parsers.
    if (!/^\s*\{\s*"order_id"\s*:\s*"[0-9a-f-]+"\s*\}\s*$/.test(source)) return false;
    const value = JSON.parse(source);
    return UUID.test(value.order_id) && value.order_id !== '00000000-0000-0000-0000-000000000000';
  } catch { return false; }
}
