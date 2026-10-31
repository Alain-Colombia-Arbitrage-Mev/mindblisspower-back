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

/** Email proof may link one eligible legacy person; signup alone never does. */
export async function provisionAuthPerson(database: IdentityDatabase, input: { userId: string }): Promise<IdentityResult> {
  const { userId } = userInput.parse(input);
  return database.transaction(async tx => {
    const locked = await tx.execute<{ id: string; contact_phone_e164: string | null }>(sql`
      SELECT id,contact_phone_e164 FROM auth.user WHERE id=${userId} FOR UPDATE`);
    if (!locked.length) return { status: 'quarantined' };
    const auth = (await principal(tx, userId))!;
    const existing = principalResult(auth);
    if (auth.email_verified !== true) return existing;
    if (auth.person_id) return existing.status === 'quarantined'
      ? quarantine(tx, userId, 'person_unavailable', auth.person_id) : existing;

    // Serializes normalized email variants across auth subjects. Existing
    // bindings remain authoritative; no email, person data or node is replaced.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'person-email:' + normalizedEmail(auth.auth_email)},0))`);
    const candidates = await tx.execute<{ id: string; user_id: string | null; status: string; blacklisted: boolean; is_admin: boolean }>(sql`
      SELECT id::text,user_id,status::text,blacklisted,is_admin FROM mlm.person
      WHERE lower(btrim(email::text))=${normalizedEmail(auth.auth_email)} ORDER BY id FOR UPDATE`);
    if (candidates.length > 1) return quarantine(tx, userId, 'identity_collision');
    const candidate = candidates[0];
    if (candidate) {
      if (candidate.blacklisted || !['pending', 'active'].includes(candidate.status)) return quarantine(tx, userId, 'person_unavailable', candidate.id);
      if (candidate.user_id && candidate.user_id !== userId) return quarantine(tx, userId, 'identity_collision', candidate.id);
      // The person row is already locked. The immutable binding is read-only
      // here: SELECT FOR UPDATE would require forbidden UPDATE privileges.
      const bindings = await tx.execute<{ subject: string }>(sql`
        SELECT subject FROM identity.auth_binding WHERE person_id=${candidate.id}::bigint`);
      if (bindings.length) return quarantine(tx, userId, 'identity_collision', candidate.id);
      // Email ownership must never grant legacy administrative privileges.
      // Privileged accounts keep the separate reviewed-claim path.
      if (candidate.is_admin !== false) {
        await quarantine(tx, userId, 'legacy_claim_required', candidate.id);
        return { status: 'claim_required' };
      }
      return bind(tx, userId, candidate.id, candidate.user_id === userId ? 'legacy_user_id' : 'verified_email');
    }
    const [first, ...last] = (auth.name ?? '').trim().split(/\s+/);
    const created = await tx.execute<{ id: string }>(sql`
      INSERT INTO mlm.person(user_id,first_name,last_name,email,phone_number,status,kyc_status)
      VALUES(${userId},${first || auth.auth_email.split('@')[0]!},${last.join(' ') || '-'},${normalizedEmail(auth.auth_email)},${locked[0]!.contact_phone_e164 ?? ''},'pending','not_started') RETURNING id::text`);
    const result = await bind(tx, userId, created[0]!.id, 'new_registration');
    return { ...result, status: 'created' };
  });
}
