import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { preparePersonalCompanyPayment, submitPersonalCompanyPayment, verifyPersonalCompanyPayment,
  readPersonalCompanyPayment, readPersonalCompanyPaymentHistory, readPersonalCompanyPaymentBalance, readPersonalCompanyPaymentBalances, abandonPersonalCompanyPayment } from '../modules/payments/personal-company-payment';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiApplication } from './types';
import { authProxyContext } from './auth-proxy-context';
import { recordPersonalCompanyPaymentEvent, readPersonalCompanyPaymentActivity } from '../modules/payments/personal-company-events';

const PREFIX = '/api/member/company-payments';
const ORIGINS = new Set(['https://mindblisspower.com', 'https://app.mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev']);
const noStore = { 'Cache-Control': 'private, no-store' };
const knownErrors = new Set(['company_payment_forbidden', 'company_payment_wallet_not_linked', 'wallet_identity_unavailable',
  'company_payment_not_found', 'company_payment_rate_limited', 'company_payment_request_already_used', 'company_payment_hash_reused',
  'company_payment_invalid_transition', 'company_payment_pending_exists', 'company_payment_insufficient_balance',
  'company_payment_transaction_pending', 'company_payment_transaction_mismatch', 'company_payment_confirmation_conflict',
  'company_payment_network_retired', 'company_payment_network_changed', 'company_payment_unconfigured', 'company_payment_rpc_unavailable',
  'company_payment_event_conflict', 'company_payment_invalid_cursor', 'company_payment_invalid_request']);
function failure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { error: 'invalid_request', status: 400 as const };
  let current: unknown = error, code = '';
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string' && knownErrors.has(candidate.message)) { code = candidate.message; break; }
    current = candidate.cause;
  }
  if (['company_payment_forbidden', 'company_payment_wallet_not_linked', 'wallet_identity_unavailable'].includes(code)) {
    return { error: 'company_payment_forbidden', status: 403 as const };
  }
  if (code === 'company_payment_not_found') return { error: code, status: 404 as const };
  if (['company_payment_invalid_cursor', 'company_payment_invalid_request'].includes(code)) return { error: code, status: 400 as const };
  if (code === 'company_payment_rate_limited') return { error: code, status: 429 as const };
  if (['company_payment_request_already_used', 'company_payment_hash_reused', 'company_payment_invalid_transition',
    'company_payment_pending_exists', 'company_payment_insufficient_balance', 'company_payment_network_retired', 'company_payment_network_changed', 'company_payment_transaction_pending',
    'company_payment_transaction_mismatch', 'company_payment_confirmation_conflict', 'company_payment_event_conflict'].includes(code)) return { error: code, status: 409 as const };
  if (['company_payment_unconfigured', 'company_payment_rpc_unavailable'].includes(code)) return { error: code, status: 503 as const };
  return { error: 'company_payment_unavailable', status: 503 as const };
}
export function registerPersonalCompanyPaymentRoutes(app: ApiApplication, { database, environment = process.env, fetchImpl = fetch }: {
  database: Pick<IdentityDatabase, 'execute'>; environment?: Record<string, string | undefined>; fetchImpl?: typeof fetch;
}) {
  app.use(`${PREFIX}/*`, bodyLimit({ maxSize: 2048, onError: context => context.json({ error: 'request_too_large' }, 413, noStore) }));
  app.use(`${PREFIX}/*`, async (context, next) => {
    context.header('Cache-Control', 'private, no-store');
    if (!context.get('session')?.user.id) return context.json({ error: 'unauthenticated' }, 401, noStore);
    if (environment.PERSONAL_COMPANY_PAYMENTS_ENABLED !== 'true') return context.json({ error: 'company_payment_unconfigured' }, 503, noStore);
    if (!ORIGINS.has(context.req.header('origin') || '')) return context.json({ error: 'invalid_origin' }, 403, noStore);
    const secret = environment.AUTH_BFF_SHARED_SECRET;
    if (!secret || secret.length < 32) return context.json({ error: 'company_payment_unconfigured' }, 503, noStore);
    return authProxyContext(secret)(context, next);
  });
  const actions = { prepare: preparePersonalCompanyPayment, submit: submitPersonalCompanyPayment, verify: verifyPersonalCompanyPayment,
    abandon: abandonPersonalCompanyPayment };
  for (const [action, perform] of Object.entries(actions)) app.post(`${PREFIX}/${action}`, async context => {
    if (new URL(context.req.url).search) return context.json({ error: 'invalid_request' }, 400, noStore);
    if (context.req.header('content-encoding') || !/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') || '')) {
      return context.json({ error: 'json_required' }, 415, noStore);
    }
    try {
      const result = await perform(database, JSON.parse(await context.req.text()), context.get('session')!.user.id,
        { environment, fetchImpl, signal: context.req.raw.signal });
      return context.json(result, action === 'prepare' ? 201 : 200, noStore);
    } catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
  app.post(`${PREFIX}/events`, async context => {
    if (new URL(context.req.url).search) return context.json({ error: 'invalid_request' }, 400, noStore);
    if (context.req.header('content-encoding') || !/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') || '')) {
      return context.json({ error: 'json_required' }, 415, noStore);
    }
    try {
      return context.json(await recordPersonalCompanyPaymentEvent(database, context.get('session')!.user.id,
        JSON.parse(await context.req.text()), { signal: context.req.raw.signal }), 200, noStore);
    } catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
  for (const action of ['events', 'activity'] as const) app.get(`${PREFIX}/${action}`, async context => {
    const url = new URL(context.req.url), params = url.searchParams;
    const keys = Array.from(params.keys()), uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const paymentId = params.get('paymentId'), cursor = params.get('cursor'), limit = params.get('limit');
    const canonical = new URLSearchParams();
    for (const key of ['paymentId', 'limit', 'cursor']) if (params.has(key)) canonical.set(key, params.get(key)!);
    if (context.req.header('content-encoding') || new Set(keys).size !== keys.length
      || keys.some(key => !(action === 'events' ? ['paymentId', 'cursor', 'limit'] : ['cursor', 'limit']).includes(key))
      || (action === 'events' && !uuid.test(paymentId || '')) || (cursor !== null && !uuid.test(cursor))
      || (limit !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit))
      || (url.search && url.search !== `?${canonical.toString()}`)) return context.json({ error: 'invalid_request' }, 400, noStore);
    try {
      return context.json(await readPersonalCompanyPaymentActivity(database, context.get('session')!.user.id,
        { ...(paymentId ? { paymentId } : {}), ...(cursor ? { cursor } : {}), limit: limit === null ? 20 : Number(limit) },
        { signal: context.req.raw.signal }), 200, noStore);
    } catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
  app.get(`${PREFIX}/balance`, async context => {
    if (new URL(context.req.url).search || context.req.header('content-encoding')) return context.json({ error: 'invalid_request' }, 400, noStore);
    context.header('Vary', 'Cookie');
    try { return context.json(await readPersonalCompanyPaymentBalance(database, context.get('session')!.user.id,
      { environment, fetchImpl, signal: context.req.raw.signal }), 200, noStore); }
    catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
  app.get(`${PREFIX}/balances`, async context => {
    if (new URL(context.req.url).search || context.req.header('content-encoding')) return context.json({ error: 'invalid_request' }, 400, noStore);
    context.header('Vary', 'Cookie');
    try { return context.json(await readPersonalCompanyPaymentBalances(database, context.get('session')!.user.id,
      { environment, fetchImpl, signal: context.req.raw.signal }), 200, noStore); }
    catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
  app.get(`${PREFIX}/status`, async context => {
    const url = new URL(context.req.url), paymentId = url.searchParams.get('paymentId');
    if (!paymentId || !/^[0-9a-f-]{36}$/.test(paymentId) || url.search !== `?paymentId=${paymentId}`) {
      return context.json({ error: 'invalid_request' }, 400, noStore);
    }
    try { return context.json(await readPersonalCompanyPayment(database, context.get('session')!.user.id, paymentId), 200, noStore); }
    catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
  app.get(`${PREFIX}/history`, async context => {
    if (new URL(context.req.url).search) return context.json({ error: 'invalid_request' }, 400, noStore);
    try { return context.json(await readPersonalCompanyPaymentHistory(database, context.get('session')!.user.id), 200, noStore); }
    catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
}
