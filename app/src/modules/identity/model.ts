import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../../db/client';

export type IdentityDatabase = Pick<DB, 'execute' | 'transaction'>;
export type IdentityTransaction = Parameters<Parameters<DB['transaction']>[0]>[0];
export type IdentityResult = {
  status: 'created' | 'existing' | 'verification_required' | 'claim_required' | 'quarantined';
  personId?: string; publicId?: string; email?: string; personStatus?: string;
};
export const userInput = z.object({ userId: z.string().min(1).max(255) });
export const claimInput = userInput.extend({ token: z.string().regex(/^[0-9a-f]{64}$/) });
export const normalizedEmail = (value: string) => value.trim().toLowerCase();
export const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export type Principal = {
  [key: string]: unknown;
  subject: string; auth_email: string; email_verified: boolean; name: string | null;
  person_id: string | null; public_id: string | null; person_email: string | null;
  person_status: string | null; blacklisted: boolean | null; user_id: string | null; is_admin: boolean | null;
};

export async function principal(database: Pick<DB, 'execute'>, userId: string) {
  const rows = await database.execute<Principal>(sql`
    SELECT u.id AS subject,u.email AS auth_email,u.email_verified,u.name,
      p.id::text AS person_id,p.public_id::text,p.email::text AS person_email,
      p.status::text AS person_status,p.blacklisted,p.user_id,p.is_admin
    FROM auth.user u LEFT JOIN identity.auth_binding b ON b.subject=u.id AND b.provider='better_auth'
    LEFT JOIN mlm.person p ON p.id=b.person_id WHERE u.id=${userId}`);
  return rows[0];
}

export function principalResult(row: Principal | undefined): IdentityResult {
  if (!row) return { status: 'quarantined' };
  if (!row.email_verified) return { status: 'verification_required' };
  if (!row.person_id) return { status: 'claim_required' };
  if (!row.public_id || row.user_id !== row.subject || row.blacklisted || !['pending', 'active'].includes(row.person_status ?? '')
    || normalizedEmail(row.auth_email) !== normalizedEmail(row.person_email ?? '')) return { status: 'quarantined' };
  return { status: 'existing', personId: row.person_id, publicId: row.public_id, email: row.person_email!, personStatus: row.person_status! };
}

export async function quarantine(tx: IdentityTransaction, userId: string, reason: string, personId: string | null = null) {
  await tx.execute(sql`INSERT INTO identity.link_conflict(subject,candidate_person_id,reason)
    VALUES(${userId},${personId}::bigint,${reason})
    ON CONFLICT(subject,candidate_person_id,reason) DO UPDATE SET last_seen_at=now(),resolved_at=NULL`);
  return { status: 'quarantined' } as const;
}

export async function bind(tx: IdentityTransaction, userId: string, personId: string, method: string) {
  await tx.execute(sql`UPDATE mlm.person SET user_id=${userId} WHERE id=${personId}::bigint AND user_id IS NULL`);
  await tx.execute(sql`INSERT INTO identity.auth_binding(subject,person_id,link_method) VALUES(${userId},${personId}::bigint,${method})`);
  await tx.execute(sql`UPDATE identity.link_conflict SET resolved_at=now()
    WHERE subject=${userId} AND candidate_person_id=${personId}::bigint AND resolved_at IS NULL`);
  return principalResult(await principal(tx, userId));
}
