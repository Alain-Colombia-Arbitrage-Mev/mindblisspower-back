import { z } from 'zod';
import { administrativeSigningCapabilities, createAdministrativeSigningChallenge, prepareAdministrativeTransfer,
  readAdministrativeSigningStatus, readAdministrativeTransferHistory, verifyAdministrativeSigningChallenge } from '../modules/payments/administrative-wallet-signing';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiApplication } from './types';
import { verifyAuthProxyEnvelope } from './auth-proxy-context';
import { readAdministrativeRequestBody } from './administrative-request-body';

const prefix = '/api/member/administrative-wallet', noStore = { 'Cache-Control': 'private, no-store' };
const known = new Set(['administrative_signing_unconfigured', 'administrative_signing_forbidden', 'administrative_signing_invalid_challenge',
  'administrative_signing_signature_invalid', 'administrative_signing_rate_limited', 'administrative_signing_unavailable',
  'administrative_transfer_binding_required', 'administrative_transfer_invalid_recipient', 'administrative_transfer_invalid_amount',
  'administrative_transfer_request_already_used', 'administrative_transfer_rate_limited', 'administrative_transfer_unavailable']);
function failure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { error: 'invalid_request', status: 400 as const };
  let value: unknown = error, code = '';
  for (let depth = 0; depth < 3 && value && typeof value === 'object'; depth++) {
    const next = value as { message?: unknown; cause?: unknown };
    if (typeof next.message === 'string' && known.has(next.message)) { code = next.message; break; } value = next.cause;
  }
  if (['administrative_signing_forbidden', 'administrative_signing_signature_invalid'].includes(code)) return { error: code, status: 403 as const };
  if (['administrative_signing_invalid_challenge', 'administrative_transfer_binding_required', 'administrative_transfer_request_already_used'].includes(code)) return { error: code, status: 409 as const };
  if (['administrative_signing_rate_limited', 'administrative_transfer_rate_limited'].includes(code)) return { error: code, status: 429 as const };
  if (['administrative_transfer_invalid_recipient', 'administrative_transfer_invalid_amount'].includes(code)) return { error: code, status: 400 as const };
  return { error: code || 'administrative_signing_unavailable', status: 503 as const };
}

export function registerAdministrativeWalletSigningRoutes(app: ApiApplication, { database, environment = process.env }: {
  database: Pick<IdentityDatabase, 'execute'>; environment?: Record<string, string | undefined>;
}) {
  const reads = [`${prefix}/signing/capabilities`, `${prefix}/signing/status`, `${prefix}/transfers/history`];
  const writes = [`${prefix}/signing/challenge`, `${prefix}/signing/verify`, `${prefix}/transfers/prepare`];
  for (const path of [...reads, ...writes]) app.use(path, async (context, next) => {
    context.header('Cache-Control', 'private, no-store');
    const session = context.get('session');
    if (!session?.user.id || !session.session?.id) return context.json({ error: 'unauthenticated' }, 401, noStore);
    if (context.req.raw.headers.has('x-vp-act-as')) return context.json({ error: 'invalid_request' }, 403, noStore);
    if (context.req.header('origin') !== 'https://wallet.mindblisspower.com') return context.json({ error: 'invalid_origin' }, 403, noStore);
    if (new URL(context.req.url).search) return context.json({ error: 'invalid_request' }, 400, noStore);
    return next();
  });
  for (const path of reads) app.get(path, async context => {
    const session = context.get('session')!, principal = { subject: session.user.id, nativeSessionId: session.session.id };
    try {
      if (path.endsWith('/capabilities')) return context.json(administrativeSigningCapabilities(environment), 200, noStore);
      if (path.endsWith('/history')) return context.json(await readAdministrativeTransferHistory(database, principal, { environment, signal: context.req.raw.signal }), 200, noStore);
      return context.json(await readAdministrativeSigningStatus(database, principal, { environment, signal: context.req.raw.signal }), 200, noStore);
    } catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
  for (const path of writes) app.post(path, async context => {
    const secret = environment.AUTH_BFF_SHARED_SECRET;
    if (!secret || secret.length < 32) return context.json({ error: 'administrative_signing_unconfigured' }, 503, noStore);
    if (context.req.raw.headers.has('content-encoding') || !/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') || '')) {
      return context.json({ error: 'json_required' }, 415, noStore);
    }
    const length = context.req.header('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > 2048)) return context.json({ error: 'request_too_large' }, 413, noStore);
    const session = context.get('session')!, principal = { subject: session.user.id, nativeSessionId: session.session.id };
    try {
      const raw = await readAdministrativeRequestBody(context.req.raw);
      if (!verifyAuthProxyEnvelope(secret, { method: context.req.method, path: context.req.path, ip: context.req.header('x-vp-auth-client-ip') || '',
        timestamp: context.req.header('x-vp-auth-timestamp') || '', signature: context.req.header('x-vp-auth-signature') || '',
        cookie: context.req.header('cookie') || '', body: raw })) return context.json({ error: 'invalid_auth_proxy' }, 403, noStore);
      const input: unknown = JSON.parse(raw);
      if (path.endsWith('/challenge')) return context.json(await createAdministrativeSigningChallenge(database, input, principal, { environment, signal: context.req.raw.signal }), 201, noStore);
      if (path.endsWith('/verify')) return context.json(await verifyAdministrativeSigningChallenge(database, input, principal, { environment, signal: context.req.raw.signal }), 200, noStore);
      return context.json(await prepareAdministrativeTransfer(database, input, principal, { environment, signal: context.req.raw.signal }), 201, noStore);
    } catch (error) {
      if (error instanceof RangeError && error.message === 'request_too_large') return context.json({ error: 'request_too_large' }, 413, noStore);
      const result = failure(error); return context.json({ error: result.error }, result.status, noStore);
    }
  });
}
