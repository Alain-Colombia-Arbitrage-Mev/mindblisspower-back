import { sql } from 'drizzle-orm';
import { requireAdmin } from '../server/admin-gate';
import { commandCenterSummary, commandCenterHealth, commandCenterAlerts, commandCenterAckAlert } from '../server/command-center';
import { alertId, reportingRange } from './input';
import type { ApiApplication } from './types';

export function registerCommandCenterRoutes(app: ApiApplication) {
  app.get('/api/admin/command-center/summary', requireAdmin, async context => {
    const range = reportingRange.parse({
      from: context.req.query('from') ?? '2026-01-01',
      to: context.req.query('to') ?? new Date().toISOString().slice(0, 10),
    });
    return context.json(await commandCenterSummary(range.from, range.to));
  });
  app.get('/api/admin/command-center/health', requireAdmin,
    async context => context.json(await commandCenterHealth()));
  app.get('/api/admin/command-center/alerts', requireAdmin,
    async context => context.json(await commandCenterAlerts()));

  app.post('/api/admin/command-center/alerts/:id/ack', requireAdmin, async context => {
    const id = alertId.parse(context.req.param('id'));
    const { db } = await import('../db/client');
    const rows = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM mlm.person WHERE user_id = ${context.get('session')?.user.id ?? ''} LIMIT 1`);
    if (!rows.length) return context.json({ error: 'person_not_found' }, 404);
    return context.json(await commandCenterAckAlert(id, BigInt(rows[0]!.id)));
  });
}
