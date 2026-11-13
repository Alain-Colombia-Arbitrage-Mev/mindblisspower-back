import { z } from 'zod';
import { verifyAuthProxyEnvelope } from './auth-proxy-context';
import { readAdministrativeRequestBody } from './administrative-request-body';
import { prepareAdministrativeOfframp, type OfframpDatabase, type OfframpEnvironment } from '../modules/payments/administrative-offramp-session';
import { readAdministrativeOfframpHistory, readAdministrativeOfframpStatus } from '../modules/payments/administrative-offramp-status';
import type { ApiApplication } from './types';

const path = '/api/member/administrative-wallet/offramp', origin = 'https://wallet.mindblisspower.com';
const noStore = { 'Cache-Control': 'private, no-store' };
function failure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { error: 'invalid_request', status: 400 as const };
  let current: unknown = error;
  for (let index = 0; index < 3 && current && typeof current === 'object'; index++) {
    const value = current as { message?: unknown; cause?: unknown };
    const code = typeof value.message === 'string' ? value.message : '';
    if (['administrative_operation_forbidden', 'administrative_wallet_not_verified', 'administrative_signing_required', 'wallet_funding_forbidden',
      'administrative_signing_forbidden', 'administrative_transfer_binding_required'].includes(code)) return { error: 'administrative_operation_forbidden', status: 403 as const };
    if (['administrative_operation_already_used', 'administrative_offramp_request_already_used'].includes(code)) return { error: 'administrative_operation_already_used', status: 409 as const };
    if (code === 'administrative_offramp_method_unavailable') return { error: code, status: 409 as const };
    if (code === 'administrative_offramp_invalid_request') return { error: 'invalid_request', status: 400 as const };
    if (code === 'administrative_operation_not_found') return { error: code, status: 404 as const };
    if (['administrative_operation_rate_limited', 'wallet_funding_rate_limited', 'administrative_offramp_rate_limited'].includes(code)) return { error: 'administrative_operation_rate_limited', status: 429 as const };
    if (code === 'administrative_offramp_unconfigured') return { error: code, status: 503 as const };
    current = value.cause;
  }
  return { error: 'administrative_offramp_unavailable', status: 503 as const };
}

export function registerAdministrativeOfframpSessionRoutes(app: ApiApplication, { database, environment = process.env, fetchImpl = fetch }: {
  database: OfframpDatabase; environment?: OfframpEnvironment; fetchImpl?: typeof fetch;
}) {
  app.use(`${path}/*`, async (context, next) => {
    context.header('Cache-Control', 'private, no-store');
    const session = context.get('session');
    if (!session?.user.id || !session.session?.id) return context.json({ error: 'unauthenticated' }, 401, noStore);
    if (context.req.raw.headers.has('x-vp-act-as')) return context.json({ error: 'invalid_request' }, 403, noStore);
    if (context.req.header('origin') !== origin) return context.json({ error: 'invalid_origin' }, 403, noStore);
    return next();
  });
  app.post(`${path}/prepare`, async context => {
    if (!environment.AUTH_BFF_SHARED_SECRET || environment.AUTH_BFF_SHARED_SECRET.length < 32) return context.json({ error: 'administrative_offramp_unconfigured' }, 503, noStore);
    if (new URL(context.req.url).search) return context.json({ error: 'invalid_request' }, 400, noStore);
    if (context.req.header('content-encoding') || !/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') || '')) return context.json({ error: 'json_required' }, 415, noStore);
    const declared = context.req.header('content-length');
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > 2048)) return context.json({ error: 'request_too_large' }, 413, noStore);
    try {
      const text = await readAdministrativeRequestBody(context.req.raw);
      if (!verifyAuthProxyEnvelope(environment.AUTH_BFF_SHARED_SECRET, { method: context.req.method, path: context.req.path,
        ip: context.req.header('x-vp-auth-client-ip') || '', timestamp: context.req.header('x-vp-auth-timestamp') || '',
        signature: context.req.header('x-vp-auth-signature') || '', cookie: context.req.header('cookie') || '', body: text })) {
        return context.json({ error: 'invalid_auth_proxy' }, 403, noStore);
      }
      const session = context.get('session')!;
      return context.json(await prepareAdministrativeOfframp(database, JSON.parse(text), { subject: session.user.id,
        nativeSessionId: session.session.id, clientIp: context.req.header('x-vp-auth-client-ip') || '', environment, fetchImpl,
        signal: context.req.raw.signal }), 201, noStore);
    } catch (error) {
      if (error instanceof RangeError && error.message === 'request_too_large') return context.json({ error: 'request_too_large' }, 413, noStore);
      const result = failure(error); return context.json({ error: result.error }, result.status, noStore);
    }
  });
  app.get(`${path}/status`, async context => {
    try {
      const query = new URL(context.req.url).searchParams;
      if (query.getAll('reference').length !== 1 || [...query.keys()].some(key => key !== 'reference')) return context.json({ error: 'invalid_request' }, 400, noStore);
      const session = context.get('session')!;
      return context.json(await readAdministrativeOfframpStatus(database,
        { subject: session.user.id, nativeSessionId: session.session.id, reference: query.get('reference')! },
        { environment, fetchImpl, signal: context.req.raw.signal }), 200, noStore);
    } catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
  app.get(`${path}/history`, async context => {
    if (new URL(context.req.url).search) return context.json({ error: 'invalid_request' }, 400, noStore);
    try { const session = context.get('session')!;
      return context.json(await readAdministrativeOfframpHistory(database, session.user.id, session.session.id, environment, context.req.raw.signal), 200, noStore);
    } catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
}
