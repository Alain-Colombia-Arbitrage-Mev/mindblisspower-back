import { z } from 'zod';
import { createSandboxWalletChallenge, readSandboxWallet, sandboxWalletCapabilities, verifySandboxWallet,
  type SandboxWalletDatabase, type SandboxWalletEnvironment } from '../modules/identity/sandbox-wallet';
import { createSandboxWalletFundingSession, readSandboxWalletFundingHistory, readSandboxWalletFundingOptions,
  readSandboxWalletFundingStatus } from '../modules/payments/sandbox-wallet-funding';
import type { ApiApplication } from './types';
import { verifyAuthProxyEnvelope } from './auth-proxy-context';
import { readAdministrativeRequestBody } from './administrative-request-body';

const prefix = '/api/member/sandbox-wallet', noStore = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function currentViewSubject(encoded: string | undefined, actualSubject: string) {
  if (!encoded || encoded.length > 1536) return false;
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length >= 1 && decoded.length <= 255 && !/[\u0000-\u0020\u007f]/.test(decoded)
      && encodeURIComponent(decoded) === encoded && decoded === actualSubject;
  } catch { return false; }
}
const known = new Set(['sandbox_wallet_unconfigured', 'sandbox_wallet_unavailable', 'sandbox_wallet_forbidden', 'sandbox_wallet_address_in_use',
  'sandbox_wallet_already_linked', 'sandbox_wallet_invalid_challenge', 'sandbox_wallet_signature_invalid', 'sandbox_wallet_rate_limited',
  'sandbox_wallet_verification_required', 'sandbox_wallet_request_already_used', 'sandbox_wallet_not_found', 'sandbox_wallet_provider_unavailable',
  'wallet_funding_rate_limited', 'wallet_funding_request_pending', 'wallet_funding_request_already_used', 'wallet_funding_method_unavailable',
  'wallet_funding_amount_unavailable', 'wallet_funding_provider_unavailable']);
const databaseAliases: Record<string, string> = { sandbox_wallet_address_immutable: 'sandbox_wallet_already_linked',
  sandbox_wallet_binding_required: 'sandbox_wallet_verification_required', sandbox_wallet_funding_request_already_used: 'sandbox_wallet_request_already_used',
  sandbox_wallet_funding_rate_limited: 'sandbox_wallet_rate_limited', sandbox_wallet_funding_forbidden: 'sandbox_wallet_forbidden',
  administrative_signing_forbidden: 'sandbox_wallet_forbidden' };
function failure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { error: 'invalid_request', status: 400 as const };
  let value = error, code = '';
  for (let i = 0; i < 3 && value && typeof value === 'object'; i++) {
    const item = value as { message?: unknown; cause?: unknown };
    if (typeof item.message === 'string' && (known.has(item.message) || Object.hasOwn(databaseAliases, item.message))) {
      code = databaseAliases[item.message] || item.message; break;
    }
    value = item.cause;
  }
  if (['sandbox_wallet_forbidden', 'sandbox_wallet_signature_invalid'].includes(code)) return { error: code, status: 403 as const };
  if (code === 'sandbox_wallet_not_found') return { error: code, status: 404 as const };
  if (['sandbox_wallet_address_in_use', 'sandbox_wallet_already_linked', 'sandbox_wallet_invalid_challenge', 'sandbox_wallet_verification_required',
    'sandbox_wallet_request_already_used', 'wallet_funding_request_pending', 'wallet_funding_request_already_used', 'wallet_funding_method_unavailable',
    'wallet_funding_amount_unavailable'].includes(code)) return { error: code, status: 409 as const };
  if (code.endsWith('rate_limited')) return { error: code, status: 429 as const };
  return { error: code || 'sandbox_wallet_unavailable', status: 503 as const };
}
export function registerSandboxWalletRoutes(app: ApiApplication, { database, environment = process.env, fetchImpl = fetch }: {
  database: SandboxWalletDatabase; environment?: SandboxWalletEnvironment; fetchImpl?: typeof fetch;
}) {
  const reads = ['/capabilities', '/status', '/funding/options', '/funding/status', '/funding/history'];
  const writes = ['/challenge', '/verify', '/funding/session'];
  for (const suffix of [...reads, ...writes]) app.use(`${prefix}${suffix}`, async (context, next) => {
    const session = context.get('session');
    if (!session?.user.id || !session.session?.id) return context.json({ error: 'unauthenticated' }, 401, noStore);
    if (context.req.raw.headers.has('x-vp-act-as')) return context.json({ error: 'invalid_request' }, 403, noStore);
    if (context.req.header('origin') !== 'https://wallet.mindblisspower.com') return context.json({ error: 'invalid_origin' }, 403, noStore);
    // A stale tab cannot apply its displayed wallet to another tab's new cookie.
    // This value is a comparison fence; only the actual native session owns SQL.
    if (!currentViewSubject(context.req.header('x-mindbliss-sandbox-subject'), session.user.id)) return context.json({ error: 'sandbox_wallet_forbidden' }, 403, noStore);
    return next();
  });
  for (const suffix of reads) app.get(`${prefix}${suffix}`, async context => {
    const session = context.get('session')!, principal = { subject: session.user.id, nativeSessionId: session.session.id };
    const query = new URL(context.req.url).searchParams;
    try {
      if (suffix === '/funding/options') {
        if (query.size !== 2 || query.getAll('country').length !== 1 || query.getAll('sourceCurrencyCode').length !== 1) return context.json({ error: 'invalid_request' }, 400, noStore);
        return context.json(await readSandboxWalletFundingOptions({ country: query.get('country'), sourceCurrencyCode: query.get('sourceCurrencyCode') },
          { environment, fetchImpl, signal: context.req.raw.signal }), 200, noStore);
      }
      if (suffix === '/funding/status') {
        if (query.size !== 1 || query.getAll('checkoutReference').length !== 1) return context.json({ error: 'invalid_request' }, 400, noStore);
        return context.json(await readSandboxWalletFundingStatus(database, { ...principal, checkoutReference: query.get('checkoutReference')! },
          { environment, fetchImpl, signal: context.req.raw.signal }), 200, noStore);
      }
      if (query.size) return context.json({ error: 'invalid_request' }, 400, noStore);
      if (suffix === '/capabilities') return context.json(sandboxWalletCapabilities(environment), 200, noStore);
      if (suffix === '/funding/history') return context.json(await readSandboxWalletFundingHistory(database, principal,
        { environment, signal: context.req.raw.signal }), 200, noStore);
      return context.json(await readSandboxWallet(database, principal, { environment, signal: context.req.raw.signal }), 200, noStore);
    } catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
  for (const suffix of writes) app.post(`${prefix}${suffix}`, async context => {
    const secret = environment.AUTH_BFF_SHARED_SECRET;
    if (!secret || secret.length < 32) return context.json({ error: 'sandbox_wallet_unconfigured' }, 503, noStore);
    if (new URL(context.req.url).search) return context.json({ error: 'invalid_request' }, 400, noStore);
    if (context.req.header('content-encoding') || !/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') || '')) return context.json({ error: 'json_required' }, 415, noStore);
    const session = context.get('session')!, principal = { subject: session.user.id, nativeSessionId: session.session.id };
    try {
      const raw = await readAdministrativeRequestBody(context.req.raw);
      const clientIp = context.req.header('x-vp-auth-client-ip') || '';
      if (!verifyAuthProxyEnvelope(secret, { method: context.req.method, path: context.req.path, ip: clientIp,
        timestamp: context.req.header('x-vp-auth-timestamp') || '', signature: context.req.header('x-vp-auth-signature') || '',
        cookie: context.req.header('cookie') || '', body: raw })) return context.json({ error: 'invalid_auth_proxy' }, 403, noStore);
      const value: unknown = JSON.parse(raw);
      if (suffix === '/challenge') return context.json(await createSandboxWalletChallenge(database, value, principal,
        { environment, signal: context.req.raw.signal }), 201, noStore);
      if (suffix === '/verify') return context.json(await verifySandboxWallet(database, value, principal,
        { environment, signal: context.req.raw.signal }), 200, noStore);
      return context.json(await createSandboxWalletFundingSession(database, value, { ...principal, clientIp, environment, fetchImpl,
        signal: context.req.raw.signal }), 201, noStore);
    } catch (error) {
      if (error instanceof RangeError && error.message === 'request_too_large') return context.json({ error: 'request_too_large' }, 413, noStore);
      const result = failure(error); return context.json({ error: result.error }, result.status, noStore);
    }
  });
}
