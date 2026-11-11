import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiApplication } from './types';
import { authProxyContext } from './auth-proxy-context';
import { polygonRelayCapabilities } from '../modules/payments/polygon-relay-policy';
import type { createPolygonAaRelayer } from '../modules/payments/polygon-relay-aa';
import { preparePersonalPolygonRelay, authorizePersonalPolygonRelay, submitPersonalPolygonRelay, verifyPersonalPolygonRelay,
  abandonPersonalPolygonRelay, readPersonalPolygonRelay, readPersonalPolygonRelayHistory } from '../modules/payments/polygon-relay-payment';

const PREFIX = '/api/member/polygon-relay';
const origins = new Set(['https://app.mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev']);
const noStore = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const forbidden = new Set(['polygon_relay_forbidden', 'polygon_relay_wallet_not_linked', 'wallet_identity_unavailable', 'company_payment_forbidden', 'company_payment_wallet_not_linked']);
const conflicts = new Set(['polygon_relay_request_already_used', 'polygon_relay_pending_exists', 'polygon_relay_insufficient_balance',
  'polygon_relay_authorization_conflict', 'polygon_relay_expired', 'polygon_relay_signature_invalid', 'polygon_relay_authorization_nonce_changed',
  'polygon_relay_nonce_reserved', 'polygon_relay_attempt_conflict', 'polygon_relay_account_busy', 'polygon_relay_operation_locked',
  'polygon_relay_invalid_transition', 'polygon_relay_lease_expired', 'polygon_relay_budget_exceeded', 'polygon_relay_operation_conflict',
  'polygon_relay_confirmation_conflict', 'polygon_relay_queue_busy', 'polygon_relay_lease_active', 'polygon_relay_lease_lost',
  'polygon_relay_requires_fresh_review', 'polygon_relay_receipt_conflict', 'polygon_relay_authorization_required',
  'company_payment_pending_exists', 'company_payment_insufficient_balance', 'company_payment_request_already_used']);
const unavailable = new Set(['polygon_relay_unconfigured', 'polygon_relay_provider_unavailable', 'polygon_relay_unavailable',
  'polygon_relay_authorization_unavailable', 'polygon_relay_fee_unavailable', 'polygon_relay_sponsorship_rejected', 'polygon_relay_broadcast_disabled',
  'polygon_relay_broadcast_ambiguous', 'polygon_relay_proof_unavailable', 'polygon_relay_contract_changed', 'company_payment_rpc_unavailable']);
export function polygonRelayFailure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { error: 'invalid_request', status: 400 as const };
  let current = error, code = '';
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === 'string' && (forbidden.has(candidate.message) || conflicts.has(candidate.message) || unavailable.has(candidate.message)
      || ['polygon_relay_not_found', 'polygon_relay_rate_limited', 'polygon_relay_invalid_request'].includes(candidate.message))) { code = candidate.message; break; }
    current = candidate.cause;
  }
  if (forbidden.has(code)) return { error: 'polygon_relay_forbidden', status: 403 as const };
  if (code === 'polygon_relay_invalid_request') return { error: code, status: 400 as const };
  if (code === 'polygon_relay_not_found') return { error: code, status: 404 as const };
  if (code === 'polygon_relay_rate_limited') return { error: code, status: 429 as const };
  if (conflicts.has(code)) return { error: code, status: 409 as const };
  return { error: unavailable.has(code) ? code : 'polygon_relay_unavailable', status: 503 as const };
}
export function registerPersonalPolygonRelayRoutes(app: ApiApplication, { database, environment = process.env, fetchImpl = fetch, createRelayer }: {
  database: Pick<IdentityDatabase, 'execute'>; environment?: Record<string, string | undefined>; fetchImpl?: typeof fetch; createRelayer?: typeof createPolygonAaRelayer;
}) {
  app.use(`${PREFIX}/*`, bodyLimit({ maxSize: 4096, onError: context => context.json({ error: 'request_too_large' }, 413, noStore) }));
  app.use(`${PREFIX}/*`, async (context, next) => {
    for (const [name, value] of Object.entries(noStore)) context.header(name, value);
    if (!context.get('session')?.user.id) return context.json({ error: 'unauthenticated' }, 401, noStore);
    if (environment.PERSONAL_POLYGON_RELAY_ENABLED !== 'true') return context.json({ error: 'polygon_relay_unconfigured' }, 503, noStore);
    if (!origins.has(context.req.header('origin') || '')) return context.json({ error: 'invalid_origin' }, 403, noStore);
    const secret = environment.AUTH_BFF_SHARED_SECRET;
    if (!secret || secret.length < 32) return context.json({ error: 'polygon_relay_unconfigured' }, 503, noStore);
    return authProxyContext(secret)(context, next);
  });
  const actions = { prepare: preparePersonalPolygonRelay, authorize: authorizePersonalPolygonRelay,
    submit: submitPersonalPolygonRelay, verify: verifyPersonalPolygonRelay, abandon: abandonPersonalPolygonRelay };
  for (const [action, perform] of Object.entries(actions)) app.post(`${PREFIX}/${action}`, async context => {
    if (new URL(context.req.url).search) return context.json({ error: 'invalid_request' }, 400, noStore);
    if (context.req.header('content-encoding') || !/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') || '')) return context.json({ error: 'json_required' }, 415, noStore);
    try { return context.json(await perform(database, JSON.parse(await context.req.text()), context.get('session')!.user.id,
      { environment, fetchImpl, signal: context.req.raw.signal, createRelayer }), action === 'prepare' ? 201 : 200, noStore); }
    catch (error) { const result = polygonRelayFailure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
  for (const action of ['capabilities', 'status', 'history'] as const) app.get(`${PREFIX}/${action}`, async context => {
    const url = new URL(context.req.url), paymentId = url.searchParams.get('paymentId');
    if (context.req.header('content-encoding') || (action === 'status'
      ? !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(paymentId || '') || url.search !== `?paymentId=${paymentId}`
      : url.search !== '')) return context.json({ error: 'invalid_request' }, 400, noStore);
    try {
      const result = action === 'capabilities' ? polygonRelayCapabilities(environment) : action === 'status'
        ? await readPersonalPolygonRelay(database, context.get('session')!.user.id, paymentId)
        : await readPersonalPolygonRelayHistory(database, context.get('session')!.user.id);
      return context.json(result, 200, noStore);
    } catch (error) { const result = polygonRelayFailure(error); return context.json({ error: result.error }, result.status, noStore); }
  });
}
