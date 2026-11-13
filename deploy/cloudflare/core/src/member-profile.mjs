export const MEMBER_PROFILE_MAX_BODY = 2048;
export const memberProfileNamespace = path => path === '/api/member/profile' || path.startsWith('/api/member/profile/');
function validViewSubject(value) {
  if (!value || value.length > 1024) return false;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length >= 1 && decoded.length <= 255 && !/[\u0000-\u001f\u007f]/.test(decoded)
      && encodeURIComponent(decoded) === value;
  } catch { return false; }
}
export function memberProfileRequest(request, url, body, env, ready) {
  if (!ready || env.MEMBER_PROFILE_ENABLED !== 'true' || url.protocol !== 'https:' || url.host !== 'auth.core.internal'
    || url.pathname !== '/api/member/profile' || url.search || url.href.endsWith('?') || request.headers.has('x-vp-act-as')
    || request.headers.get('origin') !== 'https://app.mindblisspower.com'
    || !validViewSubject(request.headers.get('x-mindbliss-profile-subject'))
    || (request.headers.get('cookie') || '').length > 8192
    || !/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=[^;\s,]+(?:;|$)/.test(request.headers.get('cookie') || '')) return false;
  if (request.method === 'GET') return true;
  if (request.method !== 'POST' || request.headers.has('content-encoding')
    || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')
    || !/^[a-f0-9]{64}$/.test(request.headers.get('x-vp-auth-signature') || '')
    || !/^\d{10}$/.test(request.headers.get('x-vp-auth-timestamp') || '')
    || !/^[a-f0-9:.]{2,45}$/i.test(request.headers.get('x-vp-auth-client-ip') || '')
    || !body?.length || body.length > MEMBER_PROFILE_MAX_BODY) return false;
  try {
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return input && typeof input === 'object' && !Array.isArray(input) && [2, 3].includes(Object.keys(input).length)
      && Object.keys(input).every(key => ['name', 'phone', 'country'].includes(key))
      && typeof input.name === 'string' && input.name.length <= 240 && !/[\u0000-\u001f\u007f]/.test(input.name)
      && input.name.normalize('NFC').trim().replace(/\s+/gu, ' ').length >= 1
      && input.name.normalize('NFC').trim().replace(/\s+/gu, ' ').length <= 160
      && /^[\p{L}\p{M} .’'-]+$/u.test(input.name)
      && /\p{L}/u.test(input.name)
      && typeof input.phone === 'string' && input.phone.length <= 32 && !/[\u0000-\u001f\u007f]/.test(input.phone)
      && /^(?:\+[1-9][0-9]{6,14})?$/.test(input.phone.trim())
      && (!Object.hasOwn(input, 'country') || (typeof input.country === 'string' && /^(?:[A-Z]{2})?$/.test(input.country)));
  } catch { return false; }
}
