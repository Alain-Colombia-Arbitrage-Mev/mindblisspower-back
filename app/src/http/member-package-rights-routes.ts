import type { IdentityDatabase } from '../modules/identity/model';
import { readMemberPackageRights } from '../modules/packages/member-package-rights';
import { readAppRechargePackage } from '../modules/packages/app-recharge-package';
import { readAppPagarCommissions, readPagarCommissionCursor } from '../modules/packages/app-pagar-commissions';
import type { ApiApplication } from './types';

const path = '/api/member/package-rights', rechargePath = '/api/member/recharge-package';
export const PAGAR_COMMISSIONS_PATH = '/api/member/pagar-commissions';
const origin = 'https://app.mindblisspower.com';
const noStore = { 'Cache-Control': 'private, no-store' };
function viewSubject(value: string | undefined) {
  if (!value || value.length > 1024) return null;
  try { const decoded = decodeURIComponent(value); return decoded.length >= 1 && decoded.length <= 255
    && !/[\u0000-\u0020\u007f]/.test(decoded) && encodeURIComponent(decoded) === value ? decoded : null; } catch { return null; }
}
function failure(error: unknown) {
  let value: unknown = error;
  const allowed = new Set(['member_package_rights_unconfigured', 'member_package_rights_forbidden', 'member_package_rights_rate_limited', 'member_package_rights_unavailable']);
  for (let depth = 0; depth < 4 && value && typeof value === 'object'; depth++) {
    const next = value as { message?: unknown; cause?: unknown };
    if (typeof next.message === 'string' && allowed.has(next.message)) return { error: next.message,
      status: next.message === 'member_package_rights_forbidden' ? 403 as const : next.message === 'member_package_rights_rate_limited' ? 429 as const : 503 as const };
    value = next.cause;
  }
  return { error: 'member_package_rights_unavailable', status: 503 as const };
}
export function registerMemberPackageRightsRoutes(app: ApiApplication, { database, environment = process.env }: {
  database: Pick<IdentityDatabase, 'execute'>; environment?: Record<string, string | undefined>;
}) {
  const packageFlags = {
    [path]: environment.MEMBER_PACKAGE_RIGHTS_ENABLED === 'true',
    [rechargePath]: environment.APP_MELD_PRODUCTION_ENABLED === 'true',
    [PAGAR_COMMISSIONS_PATH]: environment.ENV === 'production' && environment.APP_MELD_PRODUCTION_ENABLED === 'true'
      && environment.APP_PAGAR_CLOSE_ENABLED === 'true',
  };
  for (const [route, enabled] of Object.entries(packageFlags)) app.use(route, async (context, next) => {
    const commissions = route === PAGAR_COMMISSIONS_PATH;
    const errorPrefix = commissions ? 'member_pagar_commissions' : 'member_package_rights';
    context.header('Cache-Control', 'private, no-store'); const session = context.get('session');
    if (!session?.user.id || !session.session?.id) return context.json({ error: 'unauthenticated' }, 401, noStore);
    const expected = viewSubject(context.req.header('x-mindbliss-profile-subject'));
    if (expected === null) return context.json({ error: `${errorPrefix}_forbidden` }, 403, noStore);
    if (expected !== session.user.id) return context.json({ error: `${errorPrefix}_owner_changed` }, 409, noStore);
    if (context.req.raw.headers.has('x-vp-act-as')) return context.json({ error: 'impersonation_read_only' }, 403, noStore);
    if (context.req.header('origin') !== origin) return context.json({ error: 'invalid_origin' }, 403, noStore);
    if (commissions && context.req.raw.method !== 'GET') return context.notFound();
    if (!commissions && (new URL(context.req.url).search || context.req.url.endsWith('?')))
      return context.json({ error: 'member_package_rights_invalid_request' }, 400, noStore);
    if (!enabled) return context.json({ error: `${errorPrefix}_unconfigured` }, 503, noStore);
    return next();
  });
  app.get(path, async context => {
    const session = context.get('session')!;
    try { return context.json(await readMemberPackageRights(database, { subject: session.user.id, nativeSessionId: session.session.id },
      { environment, signal: context.req.raw.signal }), 200, noStore); }
    catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
  app.get(rechargePath, async context => {
    const session = context.get('session')!;
    try { return context.json(await readAppRechargePackage(database, session.user.id, session.session.id,
      context.req.raw.signal, environment.APP_PAGAR_CLOSE_ENABLED === 'true'), 200, noStore); }
    catch { return context.json({ error: 'member_recharge_package_unavailable' }, 503, noStore); }
  });
  app.get(PAGAR_COMMISSIONS_PATH, async context => {
    const cursor = readPagarCommissionCursor(new URL(context.req.url));
    if (cursor === undefined) return context.json({ error: 'member_pagar_commissions_invalid_request' }, 400, noStore);
    const session = context.get('session')!;
    try { return context.json(await readAppPagarCommissions(database, session.user.id, session.session.id,
      cursor, context.req.raw.signal), 200, noStore); }
    catch { return context.json({ error: 'member_pagar_commissions_unavailable' }, 503, noStore); }
  });
}
