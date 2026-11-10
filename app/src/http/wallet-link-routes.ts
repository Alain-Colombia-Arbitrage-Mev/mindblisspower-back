import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { confirmWalletLink, createWalletLinkChallenge, readWalletBinding } from '../modules/identity/wallet-link';
import type { ApiApplication } from './types';
import type { IdentityDatabase } from '../modules/identity/model';

const challengeInput = z.object({ address: z.string().regex(/^0x[0-9a-f]{40}$/i) }).strict();
const confirmInput = z.object({ challengeId: z.string().uuid(), signature: z.string().regex(/^0x[0-9a-f]{130}$/i) }).strict();

type LinkPhase = 'status' | 'challenge' | 'confirm';
type LinkDiagnostic = { event: 'wallet_link_failure'; phase: LinkPhase; requestId: string; status: number; code: string };
type Dependencies = { database: IdentityDatabase; environment?: Record<string, string | undefined>;
  diagnostic?: (event: LinkDiagnostic) => void };
const sqlStates = new Set(['42501', '42P01', '42703', '42883', '57014', '08000', '08001', '08003', '08006', '08004',
  '08007', '08P01', '23503', '23505', '22023', '40001', '40P01', '53300', '53400', '57P01', '57P02', '57P03', '25006']);
function diagnosticCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'string' && sqlStates.has(value.code)) return value.code;
    current = value.cause;
  }
  return 'WALLET_LINK_UNAVAILABLE';
}

function allowedOrigin(value: string, environment: Record<string, string | undefined>) {
  const configured = [environment.BETTER_AUTH_URL, ...(environment.BETTER_AUTH_TRUSTED_ORIGINS || '').split(',')]
    .filter(Boolean)
    .flatMap(candidate => {
      try { return [new URL(candidate!.trim()).origin]; }
      catch { return []; }
    });
  return configured.includes(value);
}

function walletLinkError(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { error: 'invalid_request', status: 400 as const };
  const code = error instanceof Error ? error.message : '';
  if (code === 'wallet_link_rate_limited') return { error: code, status: 429 as const };
  if (['wallet_already_linked', 'wallet_address_in_use'].includes(code)) return { error: code, status: 409 as const };
  if (['invalid_wallet_address', 'wallet_challenge_invalid', 'wallet_signature_invalid'].includes(code)) return { error: code, status: 400 as const };
  if (code === 'wallet_identity_unavailable') return { error: code, status: 403 as const };
  return { error: 'wallet_link_unavailable', status: 503 as const };
}

export function registerWalletLinkRoutes(app: ApiApplication, { database, environment = process.env,
  diagnostic = event => console.warn(JSON.stringify(event)),
}: Dependencies) {
  const failure = (error: unknown, phase: LinkPhase) => {
    const result = walletLinkError(error);
    const requestId = randomUUID();
    // Correlate failures without logging identity, signed messages, signatures,
    // cookies, SQL text or database/upstream error messages.
    try { diagnostic({ event: 'wallet_link_failure', phase, requestId, status: result.status, code: diagnosticCode(error) }); } catch { /* best effort */ }
    return { ...result, requestId };
  };
  app.get('/api/member/wallet-link', async context => {
    context.header('Cache-Control', 'private, no-store');
    const userId = context.get('session')?.user.id;
    if (!userId) return context.json({ error: 'unauthenticated' }, 401);
    try { return context.json(await readWalletBinding(database, { userId })); }
    catch (error) { const result = failure(error, 'status'); context.header('X-Mindbliss-Request-Id', result.requestId); return context.json({ error: result.error }, result.status); }
  });
  app.post('/api/member/wallet-link/challenge', async context => {
    context.header('Cache-Control', 'private, no-store');
    const userId = context.get('session')?.user.id;
    if (!userId) return context.json({ error: 'unauthenticated' }, 401);
    const origin = context.req.header('origin') || '';
    if (!allowedOrigin(origin, environment)) return context.json({ error: 'invalid_origin' }, 403);
    try {
      const body = challengeInput.parse(await context.req.json());
      return context.json(await createWalletLinkChallenge(database, { userId, address: body.address, origin }));
    } catch (error) { const result = failure(error, 'challenge'); context.header('X-Mindbliss-Request-Id', result.requestId); return context.json({ error: result.error }, result.status); }
  });
  app.post('/api/member/wallet-link/confirm', async context => {
    context.header('Cache-Control', 'private, no-store');
    const userId = context.get('session')?.user.id;
    if (!userId) return context.json({ error: 'unauthenticated' }, 401);
    if (!allowedOrigin(context.req.header('origin') || '', environment)) return context.json({ error: 'invalid_origin' }, 403);
    try {
      const body = confirmInput.parse(await context.req.json());
      return context.json(await confirmWalletLink(database, { userId, challengeId: body.challengeId, signature: body.signature }));
    } catch (error) { const result = failure(error, 'confirm'); context.header('X-Mindbliss-Request-Id', result.requestId); return context.json({ error: result.error }, result.status); }
  });
}
