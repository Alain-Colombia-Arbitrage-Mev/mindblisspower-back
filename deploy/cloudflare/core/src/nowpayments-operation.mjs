export const NOWPAYMENTS_CALLBACK = 'https://mindblisspower.com/api/webhooks/nowpayments';
export const NOWPAYMENTS_CHECKOUT = '/api/payments/checkout';
export const NOWPAYMENTS_MAX_INVOICE_BODY = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A separate, explicitly reviewed capability; never enables the full Core. */
export function nowpaymentsOperationalReady(env) {
  return env.CORE_ENV === 'production' && env.NOWPAYMENTS_OPERATIONAL_ENABLED === 'true'
    && env.NOWPAYMENTS_ENGINE_ENABLED === 'true'
    && env.NOWPAYMENTS_MEMBERSHIPS_ENABLED === 'true' && env.NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED === 'true'
    && env.AUTH_SERVICES_ENABLED === 'true' && env.AUTH_CUTOVER_VERIFIED === 'true'
    && env.CORE_DATA_ACCESS_VERIFIED === 'true';
}

export function parseCheckout(body) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** The Go handler independently verifies the JWT, subject binding and eligibility. */
export function operationalCheckoutRequest(request, url, payload, env) {
  return nowpaymentsOperationalReady(env) && request.method === 'POST' && url.protocol === 'https:'
    && url.hostname === 'payments.core.internal' && url.pathname === NOWPAYMENTS_CHECKOUT && !url.search
    && !request.headers.has('content-encoding')
    && /^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')
    && typeof env.PAYMENTS_SERVICE_TOKEN === 'string' && env.PAYMENTS_SERVICE_TOKEN.length >= 16
    && request.headers.get('x-vp-service-token') === env.PAYMENTS_SERVICE_TOKEN
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(request.headers.get('x-vp-id-token') ?? '')
    && (request.headers.get('x-vp-id-token')?.length ?? 0) <= 16384 && payload?.provider === 'nowpayments'
    && UUID.test(payload?.purchase_request_id ?? '') && payload.purchase_request_id !== '00000000-0000-0000-0000-000000000000';
}

/** Validate only the fixed merchant invoice contract emitted by our Go client. */
export function validOperationalInvoice(body) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    // Go's JSON encoder escapes ampersands in the fixed return URL. No other
    // escaped token is needed by this ASCII-only provider contract.
    const source = text.replace(/\\u0026/g, '&');
    if (source.includes('\\')) return false;
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = ['price_amount', 'price_currency', 'order_id', 'order_description', 'ipn_callback_url',
      'success_url', 'cancel_url', 'is_fee_paid_by_user'];
    if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return false;
    // Values below are fixed ASCII/decimal/UUID contracts. Reject duplicate or
    // escaped property names rather than depending on a parser's last-key rule.
    const properties = [...source.matchAll(/"([A-Za-z_]+)"\s*:/g)].map(match => match[1]);
    if (properties.length !== keys.length || new Set(properties).size !== keys.length
      || properties.some(key => !keys.includes(key))) return false;
    const amount = typeof value.price_amount === 'number' && Number.isFinite(value.price_amount)
      ? String(value.price_amount) : '';
    if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(amount) || value.price_amount <= 0
      || value.price_currency !== 'usd' || !UUID.test(value.order_id ?? '') || value.order_id === '00000000-0000-0000-0000-000000000000'
      || value.order_description !== 'Mindbliss Power membership' || value.is_fee_paid_by_user !== false
      || value.ipn_callback_url !== NOWPAYMENTS_CALLBACK) return false;
    const success = new URL(value.success_url);
    const order = value.order_id;
    if (success.origin !== 'https://mindblisspower.com' || success.pathname !== '/dashboard/packages'
      || success.href !== value.success_url || success.username || success.password || success.port || success.hash
      || success.searchParams.get('payment_provider') !== 'nowpayments'
      || success.searchParams.get('status') !== 'review' || success.searchParams.get('order_id') !== order
      || [...success.searchParams.keys()].length !== 3) return false;
    return value.cancel_url === 'https://mindblisspower.com/dashboard/packages?payment_provider=nowpayments&status=cancelled';
  } catch { return false; }
}
