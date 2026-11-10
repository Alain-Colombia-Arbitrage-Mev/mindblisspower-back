import { authDb } from '../db/auth-client';
import { administrativeWalletInventory, ensureAdministrativeWallet, readAdministrativeWallet } from '../modules/identity/administrative-wallet';
import { requireAdmin } from '../server/admin-gate';
import type { ApiApplication } from './types';

function allowedOrigin(value: string) {
  return [process.env.BETTER_AUTH_URL, ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS || '').split(',')]
    .filter(Boolean).some(candidate => {
      try { return new URL(candidate!.trim()).origin === value; }
      catch { return false; }
    });
}

function errorResponse(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code.includes('identity_unavailable') || code.includes('administrative_wallet_identity_unavailable')) {
    return { error: 'administrative_wallet_identity_unavailable', status: 403 as const };
  }
  return { error: 'administrative_wallet_unavailable', status: 503 as const };
}

export function registerAdministrativeWalletRoutes(app: ApiApplication) {
  app.get('/api/member/administrative-wallet', async context => {
    context.header('Cache-Control', 'private, no-store');
    const userId = context.get('session')?.user.id;
    if (!userId) return context.json({ error: 'unauthenticated' }, 401);
    try { return context.json(await readAdministrativeWallet(authDb, { userId })); }
    catch (error) { const failure = errorResponse(error); return context.json({ error: failure.error }, failure.status); }
  });

  app.post('/api/member/administrative-wallet/ensure', async context => {
    context.header('Cache-Control', 'private, no-store');
    const userId = context.get('session')?.user.id;
    if (!userId) return context.json({ error: 'unauthenticated' }, 401);
    if (!allowedOrigin(context.req.header('origin') || '')) return context.json({ error: 'invalid_origin' }, 403);
    try { return context.json(await ensureAdministrativeWallet(authDb, { userId })); }
    catch (error) { const failure = errorResponse(error); return context.json({ error: failure.error }, failure.status); }
  });

  app.get('/api/admin/administrative-wallet/inventory', requireAdmin, async context => {
    context.header('Cache-Control', 'private, no-store');
    try { return context.json(await administrativeWalletInventory(authDb)); }
    catch { return context.json({ error: 'administrative_wallet_inventory_unavailable' }, 503); }
  });
}
