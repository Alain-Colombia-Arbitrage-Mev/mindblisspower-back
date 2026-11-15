export const MEMBER_REFERRAL_MAX_BODY = 1024;
export const memberReferralNamespace = path => ['/api/member/referral', '/api/member/referral-attribution'].some(base => path === base || path.startsWith(`${base}/`));
function subject(value) {
  if (!value || value.length > 1536) return false;
  try { const decoded = decodeURIComponent(value); return decoded.length >= 1 && decoded.length <= 255
    && !/[\u0000-\u0020\u007f]/.test(decoded) && encodeURIComponent(decoded) === value; } catch { return false; }
}
export function memberReferralRequest(request, url, body, env, ready) {
  if (!ready || env.MEMBER_REFERRAL_ENABLED !== 'true' || url.protocol !== 'https:' || url.host !== 'auth.core.internal'
    || url.search || url.href.endsWith('?') || request.headers.has('x-vp-act-as')
    || request.headers.get('origin') !== 'https://app.mindblisspower.com'
    || !subject(request.headers.get('x-mindbliss-referral-subject')) || (request.headers.get('cookie') || '').length > 8192
    || !/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=[^;\s,]+(?:;|$)/.test(request.headers.get('cookie') || '')) return false;
  if (url.pathname === '/api/member/referral') return request.method === 'GET';
  if (url.pathname !== '/api/member/referral-attribution' || request.method !== 'POST' || request.headers.has('content-encoding')
    || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')
    || !/^[a-f0-9]{64}$/.test(request.headers.get('x-vp-auth-signature') || '')
    || !/^\d{10}$/.test(request.headers.get('x-vp-auth-timestamp') || '')
    || !/^[a-f0-9:.]{2,45}$/i.test(request.headers.get('x-vp-auth-client-ip') || '')
    || !body?.length || body.length > MEMBER_REFERRAL_MAX_BODY) return false;
  try { const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).join(',') === 'ref'
      && typeof input.ref === 'string' && input.ref.length <= 64 && !/[\s\u0000-\u001f\u007f]/u.test(input.ref);
  } catch { return false; }
}
