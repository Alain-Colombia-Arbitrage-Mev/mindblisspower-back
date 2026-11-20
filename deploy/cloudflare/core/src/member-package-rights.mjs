const path = '/api/member/package-rights';
const rechargePath = '/api/member/recharge-package';
export const memberPackageRightsNamespace = value => value === path || value.startsWith(`${path}/`)
  || value === rechargePath || value.startsWith(`${rechargePath}/`);
function subject(value) {
  if (!value || value.length > 1024) return false;
  try { const decoded = decodeURIComponent(value); return decoded.length >= 1 && decoded.length <= 255
    && !/[\u0000-\u0020\u007f]/.test(decoded) && encodeURIComponent(decoded) === value; } catch { return false; }
}
/** Explicit read-only app route. No grant/revoke or provider endpoint is proxied. */
export function memberPackageRightsRequest(request, url, env, ready) {
  const enabled = url.pathname === path ? env.MEMBER_PACKAGE_RIGHTS_ENABLED : url.pathname === rechargePath
    ? env.APP_MELD_PRODUCTION_ENABLED : undefined;
  return ready && enabled === 'true' && request.method === 'GET'
    && url.protocol === 'https:' && url.host === 'auth.core.internal'
    && !url.search && !url.hash && !url.href.endsWith('?') && !request.headers.has('x-vp-act-as')
    && request.headers.get('origin') === 'https://app.mindblisspower.com'
    && subject(request.headers.get('x-mindbliss-profile-subject'))
    && (request.headers.get('cookie') || '').length <= 8192
    && /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=[^;\s,]+(?:;|$)/.test(request.headers.get('cookie') || '');
}
