import { z } from 'zod';
import { authDb } from '../db/auth-client';
import { confirmWalletLink, createWalletLinkChallenge, readWalletBinding } from '../modules/identity/wallet-link';
import type { ApiApplication } from './types';

const challengeInput = z.object({ address: z.string().regex(/^0x[0-9a-f]{40}$/i) }).strict();
const confirmInput = z.object({ challengeId: z.string().uuid(), signature: z.string().regex(/^0x[0-9a-f]{130}$/i) }).strict();

function allowedOrigin(value: string) {
  const configured = [process.env.BETTER_AUTH_URL, ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS || '').split(',')]
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

export function registerWalletLinkRoutes(app: ApiApplication) {
  app.get('/api/member/wallet-link', async context => {
    context.header('Cache-Control', 'private, no-store');
    const userId = context.get('session')?.user.id;
    if (!userId) return context.json({ error: 'unauthenticated' }, 401);
    try { return context.json(await readWalletBinding(authDb, { userId })); }
    catch (error) { const failure = walletLinkError(error); return context.json({ error: failure.error }, failure.status); }
  });
  app.post('/api/member/wallet-link/challenge', async context => {
    context.header('Cache-Control', 'private, no-store');
    const userId = context.get('session')?.user.id;
    if (!userId) return context.json({ error: 'unauthenticated' }, 401);
    const origin = context.req.header('origin') || '';
    if (!allowedOrigin(origin)) return context.json({ error: 'invalid_origin' }, 403);
    try {
      const body = challengeInput.parse(await context.req.json());
      return context.json(await createWalletLinkChallenge(authDb, { userId, address: body.address, origin }));
    } catch (error) { const failure = walletLinkError(error); return context.json({ error: failure.error }, failure.status); }
  });
  app.post('/api/member/wallet-link/confirm', async context => {
    context.header('Cache-Control', 'private, no-store');
    const userId = context.get('session')?.user.id;
    if (!userId) return context.json({ error: 'unauthenticated' }, 401);
    if (!allowedOrigin(context.req.header('origin') || '')) return context.json({ error: 'invalid_origin' }, 403);
    try {
      const body = confirmInput.parse(await context.req.json());
      return context.json(await confirmWalletLink(authDb, { userId, challengeId: body.challengeId, signature: body.signature }));
    } catch (error) { const failure = walletLinkError(error); return context.json({ error: failure.error }, failure.status); }
  });
}
