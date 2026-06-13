import type { Context, Next } from 'hono';
import { sql } from 'drizzle-orm';

export type PersonGateRow = { isAdmin: boolean; status: string } | null;

/** Pure predicate: only an active admin passes. */
export function isAdminPerson(p: PersonGateRow): boolean {
  return !!p && p.isAdmin === true && p.status === 'active';
}

/** Hono middleware: 401 if no session, 403 if the session's person is not an active admin. */
export async function requireAdmin(c: Context, next: Next) {
  const session = c.get('session') as { user?: { id?: string } } | null;
  const userId = session?.user?.id;
  if (!userId) return c.json({ error: 'unauthenticated' }, 401);

  const { db } = await import('../db/client');
  const rows = await db.execute<{ is_admin: boolean; status: string }>(sql`
    SELECT is_admin, status FROM mlm.person WHERE user_id = ${userId} LIMIT 1
  `);
  const p: PersonGateRow = rows.length
    ? { isAdmin: rows[0]!.is_admin, status: rows[0]!.status }
    : null;
  if (!isAdminPerson(p)) return c.json({ error: 'forbidden' }, 403);

  c.set('personIsAdmin', true);
  await next();
}
