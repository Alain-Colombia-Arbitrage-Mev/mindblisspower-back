import { requireAdmin } from '../server/admin-gate';
import { postTransaction } from '../modules/ledger';
import { transactionInput } from './input';
import { sql } from 'drizzle-orm';
import type { ApiApplication } from './types';

export function registerTransactionRoutes(app: ApiApplication) {
  app.post('/api/transaction/post', requireAdmin, async context => {
    const input = transactionInput.parse(await context.req.json());
    const session = context.get('session');
    const userId = session?.user.id;
    if (!userId) return context.json({ error: 'unauthenticated' }, 401);
    const { db } = await import('../db/client');
    const people = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM mlm.person
       WHERE user_id = ${userId} AND is_admin = true AND status = 'active' LIMIT 1`);
    if (!people.length) return context.json({ error: 'person_not_found' }, 404);
    const result = await postTransaction({
      ...input,
      initiatedByPersonId: BigInt(people[0]!.id),
      actor: {
        userId,
        isAdmin: true,
        ipAddress: context.req.header('x-forwarded-for') ?? context.req.header('x-real-ip') ?? '',
        userAgent: context.req.header('user-agent') ?? '',
      },
    });
    return context.json({
      txnId: result.txnId,
      wasIdempotentReplay: result.wasIdempotentReplay,
      postedAt: result.postedAt?.toISOString() ?? null,
    });
  });
}
