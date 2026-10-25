import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { bind, claimInput, normalizedEmail, principal, principalResult, quarantine, tokenHash, type IdentityDatabase, type IdentityResult } from './model';

const approvalInput = z.object({
  approverUserId: z.string().min(1).max(255), userId: z.string().min(1).max(255), personPublicId: z.string().uuid(),
  kind: z.enum(['approved_claim', 'single_use_invite']), lifetimeSeconds: z.number().int().min(60).max(86400).default(900),
});

// Operator-only command: use an app_admin connection and an authenticated
// approver principal, never accept an approver ID supplied by a public request.
export async function approveLegacyClaim(database: IdentityDatabase, input: z.input<typeof approvalInput>) {
  const value = approvalInput.parse(input);
  return database.transaction(async tx => {
    const approver = await principal(tx, value.approverUserId);
    if (value.approverUserId === value.userId || principalResult(approver).status !== 'existing' || !approver?.is_admin) throw new Error('identity_approval_denied');
    await tx.execute(sql`SELECT id FROM auth.user WHERE id=${value.userId} FOR UPDATE`);
    const target = await principal(tx, value.userId);
    const people = await tx.execute<{ id: string; email: string; status: string; blacklisted: boolean; user_id: string | null }>(sql`
      SELECT id::text,email::text,status::text,blacklisted,user_id FROM mlm.person WHERE public_id=${value.personPublicId}::uuid FOR UPDATE`);
    const person = people[0];
    if (!target?.email_verified || target.person_id || !person || person.user_id || person.blacklisted
      || !['pending', 'active'].includes(person.status) || normalizedEmail(target.auth_email) !== normalizedEmail(person.email)) throw new Error('identity_approval_denied');
    const token = randomBytes(32).toString('hex');
    const grants = await tx.execute<{ id: string }>(sql`
      INSERT INTO identity.legacy_claim_grant(person_id,subject,token_hash,kind,approved_by_subject,expires_at)
      VALUES(${person.id}::bigint,${value.userId},${tokenHash(token)},${value.kind},${value.approverUserId},now()+${value.lifetimeSeconds}*interval '1 second') RETURNING id::text`);
    return { grantId: grants[0]!.id, token };
  });
}

export async function claimLegacyPerson(database: IdentityDatabase, input: { userId: string; token: string }): Promise<IdentityResult> {
  const { userId, token } = claimInput.parse(input);
  return database.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM auth.user WHERE id=${userId} FOR UPDATE`);
    const auth = await principal(tx, userId);
    if (!auth) return { status: 'quarantined' };
    if (!auth.email_verified) return { status: 'verification_required' };
    if (auth.person_id) return principalResult(auth); // safe replay: never reassign an existing binding
    const grants = await tx.execute<{ id: string; subject: string; person_id: string; kind: string; valid: boolean }>(sql`
      SELECT id::text,subject,person_id::text,kind,
        (expires_at>now() AND consumed_at IS NULL AND revoked_at IS NULL) AS valid
      FROM identity.legacy_claim_grant WHERE token_hash=${tokenHash(token)} FOR UPDATE`);
    const grant = grants[0];
    if (!grant || grant.subject !== userId || !grant.valid) return quarantine(tx, userId, 'invalid_claim');
    const people = await tx.execute<{ id: string; email: string; status: string; blacklisted: boolean; user_id: string | null }>(sql`
      SELECT id::text,email::text,status::text,blacklisted,user_id FROM mlm.person WHERE id=${grant.person_id}::bigint FOR UPDATE`);
    const person = people[0];
    if (!person || person.user_id || person.blacklisted || !['pending', 'active'].includes(person.status)
      || normalizedEmail(auth.auth_email) !== normalizedEmail(person.email)) return quarantine(tx, userId, 'identity_collision', grant.person_id);
    const result = await bind(tx, userId, person.id, grant.kind);
    await tx.execute(sql`UPDATE identity.legacy_claim_grant SET consumed_at=now() WHERE id=${grant.id}::uuid`);
    return result;
  });
}
