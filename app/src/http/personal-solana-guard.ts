import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { authProxyContext } from './auth-proxy-context';
import type { ApiApplication } from './types';
export const SOLANA_PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
const ORIGINS = new Set(['https://mindblisspower.com', 'https://app.mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev']);
const conflicts = new Set(['wallet_already_linked', 'wallet_address_in_use', 'solana_payment_pending_exists', 'solana_payment_request_already_used',
  'solana_payment_invalid_transition', 'solana_payment_expired', 'solana_payment_insufficient_balance', 'solana_payment_transaction_mismatch', 'solana_payment_confirmation_conflict']);
const badInput = new Set(['invalid_wallet_address', 'wallet_signature_invalid', 'wallet_challenge_invalid', 'invalid_request',
  'solana_payment_invalid_transaction', 'solana_payment_signature_invalid']);
const unavailable = new Set(['solana_wallet_unavailable', 'solana_payment_unconfigured', 'solana_payment_provider_unconfigured', 'solana_payment_rpc_unavailable',
  'solana_payment_provider_unavailable', 'solana_payment_fee_unavailable', 'solana_payment_broadcast_disabled', 'solana_payment_broadcast_ambiguous', 'solana_payment_transaction_pending']);
export function personalSolanaFailure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { error: 'invalid_request', status: 400 as const };
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const value = current as { message?: unknown; cause?: unknown }, code = value.message;
    if (typeof code === 'string') {
      if (badInput.has(code)) return { error: code, status: 400 as const };
      if (conflicts.has(code)) return { error: code, status: 409 as const };
      if (['wallet_identity_unavailable', 'solana_payment_forbidden', 'solana_payment_wallet_not_linked'].includes(code)) return { error: code, status: 403 as const };
      if (['wallet_link_rate_limited', 'solana_payment_rate_limited', 'solana_payment_budget_exceeded'].includes(code)) return { error: code, status: 429 as const };
      if (code === 'solana_payment_not_found') return { error: code, status: 404 as const };
      if (unavailable.has(code)) return { error: code, status: 503 as const };
    }
    current = value.cause;
  }
  return { error: 'solana_payment_unavailable', status: 503 as const };
}
export function registerPersonalSolanaSessionGate(app: ApiApplication, prefix: string, environment: Record<string, string | undefined>) {
  const gate = async (context: any, next: () => Promise<void>) => {
    for (const [key, value] of Object.entries(SOLANA_PRIVATE_HEADERS)) context.header(key, value);
    if (!context.get('session')?.user.id) return context.json({ error: 'unauthenticated' }, 401);
    if (environment.PERSONAL_SOLANA_ENABLED !== 'true') return context.json({ error: 'solana_payment_unconfigured' }, 503);
    if (!ORIGINS.has(context.req.header('origin') || '')) return context.json({ error: 'invalid_origin' }, 403);
    if (!environment.AUTH_BFF_SHARED_SECRET || environment.AUTH_BFF_SHARED_SECRET.length < 32) return context.json({ error: 'solana_payment_unconfigured' }, 503);
    if (context.req.header('content-encoding')) return context.json({ error: 'invalid_request' }, 400);
    return authProxyContext(environment.AUTH_BFF_SHARED_SECRET)(context, next);
  };
  const limit = bodyLimit({ maxSize: 4096, onError: context => context.json({ error: 'request_too_large' }, 413, SOLANA_PRIVATE_HEADERS) });
  app.use(prefix, limit); app.use(`${prefix}/*`, limit);
  app.use(prefix, gate); app.use(`${prefix}/*`, gate);
}
