import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import { preparePersonalCompanyPayment, submitPersonalCompanyPayment, verifyPersonalCompanyPayment,
  readPersonalCompanyPayment, readPersonalCompanyPaymentHistory, abandonPersonalCompanyPayment } from '../modules/payments/personal-company-payment';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiApplication } from './types';
import { authProxyContext } from './auth-proxy-context';

const PREFIX = '/api/member/company-payments';
const ORIGINS = new Set(['https://app.mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev']);
const noStore = { 'Cache-Control': 'private, no-store' };
const knownErrors = new Set(['company_payment_forbidden', 'company_payment_wallet_not_linked', 'wallet_identity_unavailable',
  'company_payment_not_found', 'company_payment_rate_limited', 'company_payment_request_already_used', 'company_payment_hash_reused',
  'company_payment_invalid_transition', 'company_payment_pending_exists', 'company_payment_insufficient_balance',
  'company_payment_transaction_pending', 'company_payment_transaction_mismatch', 'company_payment_confirmation_conflict',
  'company_payment_unconfigured', 'company_payment_rpc_unavailable']);
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
  if (code === 'company_payment_rate_limited') return { error: code, status: 429 as const };
  if (['company_payment_request_already_used', 'company_payment_hash_reused', 'company_payment_invalid_transition',
    'company_payment_pending_exists', 'company_payment_insufficient_balance', 'company_payment_transaction_pending',
    'company_payment_transaction_mismatch', 'company_payment_confirmation_conflict'].includes(code)) return { error: code, status: 409 as const };
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
