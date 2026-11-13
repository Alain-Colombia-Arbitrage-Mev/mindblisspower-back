export const ADMINISTRATIVE_ACTION_MAX_BODY = 2048;
const root = '/api/member/administrative-wallet';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const amount = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?$/;
const address = /^0x[0-9a-f]{40}$/i;
export function administrativeWalletActionNamespace(path) {
  return ['signing', 'transfers', 'offramp'].some(name => path === `${root}/${name}` || path.startsWith(`${root}/${name}/`));
}
function quantity(value) {
  if (typeof value !== 'string' || !amount.test(value)) return false;
  const [whole, decimals = ''] = value.split('.');
  const atomic = BigInt(whole) * 1000000n + BigInt(decimals.padEnd(6, '0'));
  return atomic > 0n && atomic <= 1000000000000000n;
}
function exact(input, fields) {
  return input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === fields.length
    && Object.keys(input).every(key => fields.includes(key));
}
/** Only ownership signatures and immutable dry-run drafts; no broadcast route exists. */
export function administrativeWalletActionRequest(request, url, body, env, ready) {
  if (!ready || url.protocol !== 'https:' || url.host !== 'auth.core.internal' || request.headers.has('x-vp-act-as')
    || request.headers.get('origin') !== 'https://wallet.mindblisspower.com'
    || !/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=[^;\s,]+(?:;|$)/.test(request.headers.get('cookie') || '')) return false;
  if (request.method === 'GET' && url.pathname === `${root}/signing/capabilities`) return !url.search;
  const signingReady = env.ADMINISTRATIVE_WALLET_SIGNING_ENABLED === 'true' && env.MELD_ADMIN_SANDBOX_ENABLED === 'true';
  if (!signingReady) return false;
  if (request.method === 'GET') {
    if ([`${root}/signing/status`, `${root}/transfers/history`].includes(url.pathname)) return !url.search;
    if (env.ADMINISTRATIVE_MELD_OFFRAMP_ENABLED !== 'true') return false;
    if (url.pathname === `${root}/offramp/history`) return !url.search;
    const reference = url.searchParams.get('reference');
    return url.pathname === `${root}/offramp/status` && uuid.test(reference || '') && url.search === `?reference=${reference}`;
  }
  if (request.method !== 'POST' || url.search || request.headers.has('content-encoding')
    || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') || !body?.length || body.length > ADMINISTRATIVE_ACTION_MAX_BODY) return false;
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return false; }
  if (url.pathname === `${root}/signing/challenge`) return exact(input, []);
  if (url.pathname === `${root}/signing/verify`) return exact(input, ['challengeId', 'signature']) && uuid.test(input.challengeId || '')
    && typeof input.signature === 'string' && /^0x(?:[0-9a-f]{128}|[0-9a-f]{130})$/i.test(input.signature);
  if (url.pathname === `${root}/transfers/prepare`) return exact(input, ['requestId', 'recipient', 'amount']) && uuid.test(input.requestId || '')
    && address.test(input.recipient || '') && !/^0x0{40}$/i.test(input.recipient) && quantity(input.amount);
  if (url.pathname === `${root}/offramp/prepare`) return env.ADMINISTRATIVE_MELD_OFFRAMP_ENABLED === 'true'
    && exact(input, ['requestId', 'country', 'destinationCurrencyCode', 'amount', 'serviceProvider', 'paymentMethodType'])
    && uuid.test(input.requestId || '') && ['US', 'MX', 'CO'].includes(input.country) && quantity(input.amount)
    && (input.destinationCurrencyCode === 'USD' || (input.country === 'MX' && input.destinationCurrencyCode === 'MXN')
      || (input.country === 'CO' && input.destinationCurrencyCode === 'COP'))
    && typeof input.serviceProvider === 'string' && /^[A-Z0-9_]{2,64}$/.test(input.serviceProvider)
    && typeof input.paymentMethodType === 'string' && /^[A-Z0-9_]{2,64}$/.test(input.paymentMethodType);
  return false;
}
