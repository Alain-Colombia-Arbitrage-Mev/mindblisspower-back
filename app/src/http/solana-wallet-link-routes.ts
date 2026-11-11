import { z } from 'zod';
import type { IdentityDatabase } from '../modules/identity/model';
import { readSolanaWalletBinding, createSolanaWalletLinkChallenge, confirmSolanaWalletLink } from '../modules/identity/solana-wallet-link';
import type { ApiApplication } from './types';
import { personalSolanaFailure, registerPersonalSolanaSessionGate, SOLANA_PRIVATE_HEADERS } from './personal-solana-guard';
const PREFIX = '/api/member/solana-wallet-link';
const addressInput = z.object({ address: z.string().min(32).max(44) }).strict();
const proofInput = z.object({ challengeId: z.string().uuid(), signature: z.string().length(88) }).strict();
export function registerSolanaWalletLinkRoutes(app: ApiApplication, { database, environment = process.env }: {
  database: IdentityDatabase; environment?: Record<string, string | undefined>;
}) {
  registerPersonalSolanaSessionGate(app, PREFIX, environment);
  app.get(PREFIX, async context => {
    if (new URL(context.req.url).search) return context.json({ error: 'invalid_request' }, 400, SOLANA_PRIVATE_HEADERS);
    try { return context.json(await readSolanaWalletBinding(database, context.get('session')!.user.id), 200, SOLANA_PRIVATE_HEADERS); }
    catch (error) { const result = personalSolanaFailure(error); return context.json({ error: result.error }, result.status, SOLANA_PRIVATE_HEADERS); }
  });
  for (const action of ['challenge', 'confirm'] as const) app.post(`${PREFIX}/${action}`, async context => {
    if (new URL(context.req.url).search) return context.json({ error: 'invalid_request' }, 400, SOLANA_PRIVATE_HEADERS);
    if (!/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') || '')) return context.json({ error: 'json_required' }, 415, SOLANA_PRIVATE_HEADERS);
    try {
      const raw = await context.req.json(), owner = context.get('session')!.user.id;
      const result = action === 'challenge'
        ? await createSolanaWalletLinkChallenge(database, { ...addressInput.parse(raw), userId: owner, origin: context.req.header('origin')! })
        : await confirmSolanaWalletLink(database, { ...proofInput.parse(raw), userId: owner });
      return context.json(result, 200, SOLANA_PRIVATE_HEADERS);
    } catch (error) { const result = personalSolanaFailure(error); return context.json({ error: result.error }, result.status, SOLANA_PRIVATE_HEADERS); }
  });
}
