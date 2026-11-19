import { z } from 'zod';
import type { ApiApplication } from './types';
import type { SandboxWalletDatabase, SandboxWalletEnvironment } from '../modules/identity/sandbox-wallet';
import { createProductionWalletSession, productionWalletCapabilities, quoteProductionWalletFunding, readProductionWalletDiscovery, readProductionWalletHistory,
  readProductionWalletOptions, readProductionWalletStatus } from '../modules/payments/wallet-meld-production';
import { readAdministrativeRequestBody } from './administrative-request-body';
import { verifyAuthProxyEnvelope } from './auth-proxy-context';

const prefix = '/api/member/wallet-funding', noStore = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
function subjectMatches(encoded: string | undefined, actual: string) {
  if (!encoded || encoded.length > 1536) return false;
  try { const value = decodeURIComponent(encoded); return value === actual && value.length <= 255 && !/[\u0000-\u0020\u007f]/.test(value) && encodeURIComponent(value) === encoded; }
  catch { return false; }
}
const errors = new Set(['wallet_production_unconfigured', 'wallet_production_unavailable', 'wallet_production_forbidden',
  'wallet_production_verification_required', 'wallet_production_request_already_used', 'wallet_production_method_unavailable',
  'wallet_production_amount_unavailable', 'wallet_production_provider_unavailable', 'wallet_production_quote_unavailable', 'wallet_production_rate_limited', 'wallet_production_not_found']);
const aliases: Record<string, string> = { wallet_funding_rate_limited: 'wallet_production_rate_limited', wallet_funding_request_pending: 'wallet_production_request_already_used',
  wallet_funding_request_already_used: 'wallet_production_request_already_used', sandbox_wallet_binding_required: 'wallet_production_verification_required',
  administrative_signing_forbidden: 'wallet_production_forbidden', sandbox_wallet_forbidden: 'wallet_production_forbidden' };
function failure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { error: 'invalid_request', status: 400 as const };
  let value = error, code = '';
  for (let i = 0; i < 3 && value && typeof value === 'object'; i++) {
    const item = value as { message?: unknown; cause?: unknown };
    if (typeof item.message === 'string' && (errors.has(item.message) || Object.hasOwn(aliases, item.message))) { code = aliases[item.message] || item.message; break; }
    value = item.cause;
  }
  if (code.endsWith('_forbidden')) return { error: code, status: 403 as const };
  if (code.endsWith('_not_found')) return { error: code, status: 404 as const };
  if (code.endsWith('_rate_limited')) return { error: code, status: 429 as const };
  if (['_verification_required', '_request_already_used', '_method_unavailable', '_amount_unavailable', '_quote_unavailable'].some(suffix => code.endsWith(suffix))) return { error: code, status: 409 as const };
  return { error: code || 'wallet_production_unavailable', status: 503 as const };
}
const reads = new WeakMap<SandboxWalletDatabase, Map<string, { active: number; count: number; until: number }>>();
function acquireRead(database: SandboxWalletDatabase, subject: string) {
  let owners = reads.get(database); if (!owners) { owners = new Map(); reads.set(database, owners); }
  const now = Date.now(); for (const [key, value] of owners) if (!value.active && value.until <= now) owners.delete(key);
  let item = owners.get(subject);
  if (item && (item.active >= 4 || item.count >= 60) || !item && owners.size >= 10000) throw Error('wallet_production_rate_limited');
  if (!item) { item = { active: 0, count: 0, until: now + 60000 }; owners.set(subject, item); }
  item.active++; item.count++; let released = false; return () => { if (!released) { released = true; item!.active--; } };
}
export function registerProductionWalletFundingRoutes(app: ApiApplication, { database, environment = process.env, fetchImpl = fetch }: {
  database: SandboxWalletDatabase; environment?: SandboxWalletEnvironment; fetchImpl?: typeof fetch;
}) {
  const readPaths = ['/capabilities', '/discovery', '/options', '/status', '/history'];
  for (const suffix of [...readPaths, '/session', '/quote']) app.use(`${prefix}${suffix}`, async (c, next) => {
    const session = c.get('session');
    if (!session?.user.id || !session.session?.id) return c.json({ error: 'unauthenticated' }, 401, noStore);
    if (c.req.raw.headers.has('x-vp-act-as')) return c.json({ error: 'invalid_request' }, 403, noStore);
    if (c.req.header('origin') !== 'https://wallet.mindblisspower.com') return c.json({ error: 'invalid_origin' }, 403, noStore);
    if (!subjectMatches(c.req.header('x-mindbliss-wallet-subject'), session.user.id)) return c.json({ error: 'wallet_production_forbidden' }, 403, noStore);
    return next();
  });
  for (const suffix of readPaths) app.get(`${prefix}${suffix}`, async c => {
    const session = c.get('session')!, input = { subject: session.user.id, nativeSessionId: session.session.id };
    let release: (() => void) | undefined;
    try {
      const query = new URL(c.req.url).searchParams;
      if (suffix === '/capabilities') {
        if (query.size) return c.json({ error: 'invalid_request' }, 400, noStore);
        return c.json(productionWalletCapabilities(environment), 200, noStore);
      }
      release = acquireRead(database, input.subject);
      const dependencies = { environment, fetchImpl, signal: c.req.raw.signal };
      if (suffix === '/discovery') {
        if (query.size > 1 || query.size === 1 && query.getAll('country').length !== 1) return c.json({ error: 'invalid_request' }, 400, noStore);
        return c.json(await readProductionWalletDiscovery(query.get('country') ?? undefined, dependencies), 200, noStore);
      }
      if (suffix === '/options') {
        if (query.size !== 2 || query.getAll('country').length !== 1 || query.getAll('sourceCurrencyCode').length !== 1) return c.json({ error: 'invalid_request' }, 400, noStore);
        return c.json(await readProductionWalletOptions({ country: query.get('country'), sourceCurrencyCode: query.get('sourceCurrencyCode') }, dependencies), 200, noStore);
      }
      if (suffix === '/status') {
        if (query.size !== 1 || query.getAll('checkoutReference').length !== 1) return c.json({ error: 'invalid_request' }, 400, noStore);
        return c.json(await readProductionWalletStatus(database, { ...input, checkoutReference: query.get('checkoutReference')! }, dependencies), 200, noStore);
      }
      if (query.size) return c.json({ error: 'invalid_request' }, 400, noStore);
      return c.json(await readProductionWalletHistory(database, input, dependencies), 200, noStore);
    } catch (error) { const result = failure(error); return c.json({ error: result.error }, result.status, noStore); }
    finally { release?.(); }
  });
  for (const suffix of ['/session', '/quote']) app.post(`${prefix}${suffix}`, async c => {
    if (new URL(c.req.url).search) return c.json({ error: 'invalid_request' }, 400, noStore);
    if (c.req.header('content-encoding') || !/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') || '')) return c.json({ error: 'json_required' }, 415, noStore);
    const secret = environment.AUTH_BFF_SHARED_SECRET;
    if (!secret || secret.length < 32) return c.json({ error: 'wallet_production_unconfigured' }, 503, noStore);
    try {
      const body = await readAdministrativeRequestBody(c.req.raw), clientIp = c.req.header('x-vp-auth-client-ip') || '';
      if (!verifyAuthProxyEnvelope(secret, { method: 'POST', path: c.req.path, ip: clientIp, timestamp: c.req.header('x-vp-auth-timestamp') || '',
        signature: c.req.header('x-vp-auth-signature') || '', cookie: c.req.header('cookie') || '', body })) return c.json({ error: 'invalid_auth_proxy' }, 403, noStore);
      const session = c.get('session')!;
      if (suffix === '/quote') return c.json(await quoteProductionWalletFunding(database, JSON.parse(body), { subject: session.user.id,
        nativeSessionId: session.session.id, clientIp, environment, fetchImpl, signal: c.req.raw.signal }), 200, noStore);
      return c.json(await createProductionWalletSession(database, JSON.parse(body), { subject: session.user.id, nativeSessionId: session.session.id,
        clientIp, environment, fetchImpl, signal: c.req.raw.signal }), 201, noStore);
    } catch (error) {
      if (error instanceof RangeError && error.message === 'request_too_large') return c.json({ error: 'request_too_large' }, 413, noStore);
      const result = failure(error); return c.json({ error: result.error }, result.status, noStore);
    }
  });
}
