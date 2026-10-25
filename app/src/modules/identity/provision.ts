import { sql } from 'drizzle-orm';
import { bind, normalizedEmail, principal, principalResult, quarantine, userInput, type IdentityDatabase, type IdentityResult } from './model';

/** Read-only authority for JWTs. No person creation, email matching or repair. */
export async function getAuthPersonBinding(database: Pick<IdentityDatabase, 'execute'>, input: { userId: string }): Promise<IdentityResult> {
  const value = userInput.parse(input);
  const result = principalResult(await principal(database, value.userId));
  if (result.status !== 'claim_required') return result;
  const conflicts = await database.execute(sql`SELECT 1 FROM identity.link_conflict WHERE subject=${value.userId}
    AND resolved_at IS NULL AND reason IN ('identity_collision','person_unavailable') LIMIT 1`);
  return conflicts.length ? { status: 'quarantined' } : result;
}

/** Called after verification/session creation. Signup is never a legacy claim. */
export async function provisionAuthPerson(database: IdentityDatabase, input: { userId: string }): Promise<IdentityResult> {
  const { userId } = userInput.parse(input);
  return database.transaction(async tx => {
    const locked = await tx.execute(sql`SELECT id FROM auth.user WHERE id=${userId} FOR UPDATE`);
    if (!locked.length) return { status: 'quarantined' };
    const auth = (await principal(tx, userId))!;
    const existing = principalResult(auth);
    if (!auth.email_verified) return existing;
    if (auth.person_id) return existing.status === 'quarantined'
      ? quarantine(tx, userId, 'person_unavailable', auth.person_id) : existing;

    // Serializes case variants across separate auth subjects; citext's unique
    // person.email index is the final protection. No ON CONFLICT email update.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'person-email:' + normalizedEmail(auth.auth_email)},0))`);
    const candidates = await tx.execute<{ id: string; user_id: string | null; status: string; blacklisted: boolean }>(sql`
      SELECT id::text,user_id,status::text,blacklisted FROM mlm.person WHERE email=${auth.auth_email} FOR UPDATE`);
    const candidate = candidates[0];
    if (candidate) {
      if (candidate.blacklisted || !['pending', 'active'].includes(candidate.status)) return quarantine(tx, userId, 'person_unavailable', candidate.id);
      if (candidate.user_id === userId) return bind(tx, userId, candidate.id, 'legacy_user_id');
      if (candidate.user_id) return quarantine(tx, userId, 'identity_collision', candidate.id);
      await quarantine(tx, userId, 'legacy_claim_required', candidate.id);
      return { status: 'claim_required' };
    }
    const [first, ...last] = (auth.name ?? '').trim().split(/\s+/);
    const created = await tx.execute<{ id: string }>(sql`
      INSERT INTO mlm.person(user_id,first_name,last_name,email,phone_number,status,kyc_status)
      VALUES(${userId},${first || auth.auth_email.split('@')[0]!},${last.join(' ') || '-'},${auth.auth_email},'','pending','not_started') RETURNING id::text`);
    const result = await bind(tx, userId, created[0]!.id, 'new_registration');
    return { ...result, status: 'created' };
  });
}
