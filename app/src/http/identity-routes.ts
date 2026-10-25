import { z } from 'zod';
import { db } from '../db/client';
import { claimLegacyPerson, getAuthPersonBinding } from '../modules/identity';
import type { ApiApplication } from './types';

const claimInput = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) });

// A limited, verified auth session may inspect/claim its own identity, not choose
// a person ID or approver. Approval is a separate operator-only domain command.
export function registerIdentityRoutes(app: ApiApplication) {
  app.get('/api/member/identity', async context => {
    context.header('Cache-Control', 'private, no-store');
    const userId = context.get('session')?.user.id;
    if (!userId) return context.json({ error: 'unauthenticated' }, 401);
    return context.json(await getAuthPersonBinding(db, { userId }));
  });
  app.post('/api/member/identity/claim', async context => {
    context.header('Cache-Control', 'private, no-store');
    const userId = context.get('session')?.user.id;
    if (!userId) return context.json({ error: 'unauthenticated' }, 401);
    const allowed = [process.env.BETTER_AUTH_URL, ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS || '').split(',')]
      .filter(Boolean).map(value => new URL(value!.trim()).origin);
    if (!allowed.includes(context.req.header('origin') || '')) return context.json({ error: 'invalid_origin' }, 403);
    const { token } = claimInput.parse(await context.req.json());
    const result = await claimLegacyPerson(db, { userId, token });
    return context.json(result, result.status === 'existing' ? 200 : 409);
  });
}
