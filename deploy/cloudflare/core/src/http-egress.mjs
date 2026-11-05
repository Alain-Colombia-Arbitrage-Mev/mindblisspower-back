import { dispatchContainerOutbound } from './routing.mjs';
import { boundedBody, fetchWithDeadline } from './transport.mjs';

export const CONTAINER_HTTP_HOSTS = Object.freeze({
  api: ['engine-grpc.core.internal', 'engine.core.internal', 'observability.core.internal'],
  engine: [],
  payments: ['engine.core.internal', 'auth.core.internal', 'api.nowpayments.io'],
  withdrawals: ['auth.core.internal'],
});

// HTTP interception does not restrict PostgreSQL/raw TCP egress. Keep this
// separate from enableInternet and off until a reviewed canary confirms the
// injected HTTPS CA and all selected-provider traffic. No self-activation.
export function strictHttpEgressEnabled(env) {
  const value = env.CORE_HTTP_EGRESS_STRICT_ENABLED;
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('http_egress_configuration_unavailable');
}

/** Installed SDK 0.3.7 has no verified public catch-all rollback operation. */
export function assertHttpEgressActivationSafe(env) {
  if (strictHttpEgressEnabled(env)) throw new Error('http_egress_rollback_unavailable');
  // Disabled mode leaves every existing SDK handler and its storage untouched.
  // Do not invent a null setter, edit SDK-private keys or replace other handlers.
}
const unavailable = (status = 403) => Response.json({ error: 'egress_unavailable' }, {
  status, headers: { 'Cache-Control': 'private, no-store' },
});

/** Exact per-service HTTP contract, not a general-purpose outbound proxy. */
export async function containerHttpOutbound(source, request, env, resolve, internetFetch = fetch) {
  if (!Object.hasOwn(CONTAINER_HTTP_HOSTS, source)) return unavailable();
  let strict;
  try { strict = strictHttpEgressEnabled(env); }
  catch { return unavailable(503); }
  let url;
  try { url = new URL(request.url); } catch { return unavailable(); }
  // Preserve existing stronger internal/provider routing regardless of the
  // optional catch-all policy; no flag may bypass those capability guards.
  if (CONTAINER_HTTP_HOSTS[source].includes(url.hostname)) return dispatchContainerOutbound(source, request, env, resolve, internetFetch);
  if (!strict) return internetFetch(request);
  if (source !== 'api' || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.search
    || request.method !== 'POST' || request.headers.has('upgrade') || request.headers.has('content-encoding')
    || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return unavailable();

  const provider = env.AUTH_EMAIL_PROVIDER === undefined ? 'cloudflare' : env.AUTH_EMAIL_PROVIDER;
  let credential;
  if (provider === 'resend' && url.hostname === 'api.resend.com' && url.pathname === '/emails') {
    credential = env.RESEND_API_KEY;
  } else if (provider === 'cloudflare' && url.hostname === 'api.cloudflare.com'
    && /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')
    && url.pathname === `/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`) {
    credential = env.CLOUDFLARE_EMAIL_API_TOKEN;
  } else return unavailable();
  if (typeof credential !== 'string' || !credential.trim() || /\s/.test(credential)
    || request.headers.get('authorization') !== `Bearer ${credential}`) return unavailable();
  try {
    const body = await boundedBody(request, 128 * 1024);
    if (!body?.length) return unavailable();
    const response = await fetchWithDeadline(new Request(request, { body, redirect: 'manual' }), internetFetch, 10_000);
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {}); return unavailable(503);
    }
    // Preserve provider 4xx/5xx classifications used by the native sender;
    // do not retry, rewrite an ambiguous send as rejected, or switch provider.
    return response;
  } catch { return unavailable(503); }
}
