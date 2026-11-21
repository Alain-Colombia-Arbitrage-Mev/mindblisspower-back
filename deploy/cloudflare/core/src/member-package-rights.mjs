const path = '/api/member/package-rights';
const rechargePath = '/api/member/recharge-package';
const commissionsPath = '/api/member/pagar-commissions';
const paths = [path, rechargePath, commissionsPath];
export const memberPackageRightsNamespace = value => paths.some(route => value === route || value.startsWith(`${route}/`));
function subject(value) {
  if (!value || value.length > 1024) return false;
  try { const decoded = decodeURIComponent(value); return decoded.length >= 1 && decoded.length <= 255
    && !/[\u0000-\u0020\u007f]/.test(decoded) && encodeURIComponent(decoded) === value; } catch { return false; }
}
function validQuery(url) {
  if (!url.search) return !url.href.endsWith('?');
  if (url.pathname !== commissionsPath) return false;
  const match = /^\?before=((?!0000)\d{4}-\d{2}-\d{2})$/.exec(url.search);
  if (!match) return false;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  return date.getUTCDay() === 1 && date.toISOString().slice(0, 10) === match[1];
}
/** Explicit read-only app route. No grant/revoke or provider endpoint is proxied. */
export function memberPackageRightsRequest(request, url, env, ready) {
  const enabled = {
    [path]: env.MEMBER_PACKAGE_RIGHTS_ENABLED === 'true',
    [rechargePath]: env.APP_MELD_PRODUCTION_ENABLED === 'true',
    [commissionsPath]: env.CORE_ENV === 'production' && env.APP_MELD_PRODUCTION_ENABLED === 'true'
      && env.APP_PAGAR_CLOSE_ENABLED === 'true',
  };
  return ready && enabled[url.pathname] === true && request.method === 'GET'
    && url.protocol === 'https:' && url.host === 'auth.core.internal'
    && !url.hash && validQuery(url) && !request.headers.has('x-vp-act-as')
    && request.headers.get('origin') === 'https://app.mindblisspower.com'
    && subject(request.headers.get('x-mindbliss-profile-subject'))
    && (request.headers.get('cookie') || '').length <= 8192
    && /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=[^;\s,]+(?:;|$)/.test(request.headers.get('cookie') || '');
}
