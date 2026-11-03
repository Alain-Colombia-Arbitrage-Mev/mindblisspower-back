export const REFERRAL_ATTRIBUTION_PATH = '/api/payments/referral-attribution';
export const REFERRAL_ATTRIBUTION_MAX_BODY = 1024;

export function referralAttributionNamespace(normalizedPath) {
  return normalizedPath === REFERRAL_ATTRIBUTION_PATH || normalizedPath.startsWith(`${REFERRAL_ATTRIBUTION_PATH}/`);
}

function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && email === email.trim().toLowerCase()
    && /^[^\s@<>]+@[^\s@<>]+$/.test(email);
}

// Metadata-only capability. Owner JWT signature, verified DB binding, bans,
// sponsor eligibility and placement lock are enforced independently in Go/SQL.
export function referralAttributionRequest(request, url, bytes, env, ready) {
  if (!ready || url.protocol !== 'https:' || url.hostname !== 'payments.core.internal'
    || url.pathname !== REFERRAL_ATTRIBUTION_PATH || url.href.endsWith('?')
    || request.headers.has('content-encoding') || request.headers.has('x-vp-act-as')
    || typeof env.PAYMENTS_SERVICE_TOKEN !== 'string' || env.PAYMENTS_SERVICE_TOKEN.length < 16
    || request.headers.get('x-vp-service-token') !== env.PAYMENTS_SERVICE_TOKEN
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(request.headers.get('x-vp-id-token') ?? '')
    || (request.headers.get('x-vp-id-token')?.length ?? 0) > 16384) return false;
  if (request.method === 'GET') {
    return url.search.startsWith('?email=') && [...url.searchParams.keys()].length === 1
      && validEmail(url.searchParams.get('email'))
      && !request.headers.has('transfer-encoding') && (!request.headers.has('content-length') || request.headers.get('content-length') === '0');
  }
  if (request.method !== 'POST' || url.search
    || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')
    || !bytes?.length || bytes.length > REFERRAL_ATTRIBUTION_MAX_BODY) return false;
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(source);
    // Canonical BFF JSON: one literal occurrence per field, no caller-selected
    // owner/subject/sponsor IDs, duplicate or escaped keys, or trailing JSON.
    if (source.trim() !== JSON.stringify(value) || !value || Array.isArray(value)
      || Object.keys(value).join(',') !== 'email,ref,preferred_side') return false;
    return validEmail(value.email) && typeof value.ref === 'string' && [...value.ref].length >= 1
      && [...value.ref].length <= 64 && !/[\s\p{Cc}]/u.test(value.ref)
      && ['', 'L', 'R'].includes(value.preferred_side);
  } catch { return false; }
}
