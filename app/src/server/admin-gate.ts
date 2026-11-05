import type { Context, Next } from 'hono';
import { principal, principalResult, type Principal } from '../modules/identity/model';

export type PersonGateRow = Principal | null | undefined;

/** Email ownership, canonical binding and live restrictions precede the role. */
export function isAdminPerson(p: PersonGateRow, expectedSubject: string): boolean {
  return !!p && expectedSubject.length > 0 && p.subject === expectedSubject
    && principalResult(p).status === 'existing' && p.is_admin === true && p.person_status === 'active';
}

type AdminPrincipalLookup = (subject: string) => Promise<PersonGateRow>;

// Reuse the primary authority used to issue service JWTs, not a read replica or
// cookie role. This is SELECT-only; no provisioning, role changes or repair.
async function currentPrincipal(subject: string): Promise<PersonGateRow> {
  const { authDb } = await import('../db/auth-client');
  return principal(authDb, subject);
}

export function createRequireAdmin(lookup: AdminPrincipalLookup = currentPrincipal) {
  return async (c: Context, next: Next) => {
    const session = c.get('session') as { user?: { id?: string } } | null;
    const userId = session?.user?.id;
    if (typeof userId !== 'string' || !userId.trim() || userId.length > 255) return c.json({ error: 'unauthenticated' }, 401);
    let person: PersonGateRow;
    try { person = await lookup(userId); }
    catch { return c.json({ error: 'account_status_unavailable' }, 503); }
    if (!isAdminPerson(person, userId)) return c.json({ error: 'forbidden' }, 403);
    c.set('personIsAdmin', true);
    await next();
  };
}

export const requireAdmin = createRequireAdmin();
