import { z } from 'zod';
import type { IdentityDatabase } from '../modules/identity/model';
import { readMemberProfile, updateMemberProfile } from '../modules/identity/member-profile';
import type { ApiApplication } from './types';
import { verifyAuthProxyEnvelope } from './auth-proxy-context';
import { readAdministrativeRequestBody } from './administrative-request-body';

const path = '/api/member/profile', origin = 'https://app.mindblisspower.com', noStore = { 'Cache-Control': 'private, no-store' };
function viewSubject(value: string | undefined) {
  if (!value || value.length > 1024) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length >= 1 && decoded.length <= 255 && !/[\u0000-\u001f\u007f]/.test(decoded)
      && encodeURIComponent(decoded) === value ? decoded : null;
  } catch { return null; }
}
const known = new Set(['member_profile_unconfigured', 'member_profile_unavailable', 'member_profile_invalid_request',
  'member_profile_outcome_unconfirmed', 'member_profile_forbidden', 'member_profile_not_found', 'member_profile_rate_limited']);
function failure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { error: 'member_profile_invalid_request', status: 400 as const };
  let value: unknown = error, code = '';
  for (let depth = 0; depth < 3 && value && typeof value === 'object'; depth++) {
    const next = value as { message?: unknown; cause?: unknown };
    if (typeof next.message === 'string' && known.has(next.message)) { code = next.message; break; } value = next.cause;
  }
  if (code === 'member_profile_forbidden') return { error: code, status: 403 as const };
  if (code === 'member_profile_not_found') return { error: code, status: 404 as const };
  if (code === 'member_profile_invalid_request') return { error: code, status: 400 as const };
  if (code === 'member_profile_rate_limited') return { error: code, status: 429 as const };
  return { error: code || 'member_profile_unavailable', status: 503 as const };
}
export function registerMemberProfileRoutes(app: ApiApplication, { database, environment = process.env }: {
  database: Pick<IdentityDatabase, 'execute'>; environment?: Record<string, string | undefined>;
}) {
  app.use(path, async (context, next) => {
    context.header('Cache-Control', 'private, no-store');
    const session = context.get('session');
    if (!session?.user.id || !session.session?.id) return context.json({ error: 'unauthenticated' }, 401, noStore);
    // The mounted UI owner is a mismatch fence, never a selectable DB identity.
    // Another tab may have replaced the native cookie since this view loaded.
    const expectedSubject = viewSubject(context.req.header('x-mindbliss-profile-subject'));
    if (expectedSubject === null) return context.json({ error: 'member_profile_forbidden' }, 403, noStore);
    if (expectedSubject !== session.user.id) return context.json({ error: 'member_profile_owner_changed' }, 409, noStore);
    if (context.req.raw.headers.has('x-vp-act-as')) return context.json({ error: 'impersonation_read_only' }, 403, noStore);
    if (context.req.header('origin') !== origin) return context.json({ error: 'invalid_origin' }, 403, noStore);
    if (new URL(context.req.url).search || context.req.url.endsWith('?')) return context.json({ error: 'member_profile_invalid_request' }, 400, noStore);
    if (environment.MEMBER_PROFILE_ENABLED !== 'true') return context.json({ error: 'member_profile_unconfigured' }, 503, noStore);
    return next();
  });
  app.get(path, async context => {
    const session = context.get('session')!;
    try { return context.json(await readMemberProfile(database, { subject: session.user.id, nativeSessionId: session.session.id },
      { environment, signal: context.req.raw.signal }), 200, noStore); }
    catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
  app.post(path, async context => {
    const secret = environment.AUTH_BFF_SHARED_SECRET;
    if (!secret || secret.length < 32) return context.json({ error: 'member_profile_unconfigured' }, 503, noStore);
    if (context.req.raw.headers.has('content-encoding') || !/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') || '')) {
      return context.json({ error: 'json_required' }, 415, noStore);
    }
    try {
      const raw = await readAdministrativeRequestBody(context.req.raw);
      if (!verifyAuthProxyEnvelope(secret, { method: context.req.method, path: context.req.path,
        ip: context.req.header('x-vp-auth-client-ip') || '', timestamp: context.req.header('x-vp-auth-timestamp') || '',
        signature: context.req.header('x-vp-auth-signature') || '', cookie: context.req.header('cookie') || '', body: raw })) {
        return context.json({ error: 'invalid_auth_proxy' }, 403, noStore);
      }
      const session = context.get('session')!;
      return context.json(await updateMemberProfile(database, JSON.parse(raw), { subject: session.user.id, nativeSessionId: session.session.id },
        { environment, signal: context.req.raw.signal }), 200, noStore);
    } catch (error) {
      if (error instanceof RangeError && error.message === 'request_too_large') return context.json({ error: 'request_too_large' }, 413, noStore);
      const result = failure(error); return context.json({ error: result.error }, result.status, noStore);
    }
  });
}
