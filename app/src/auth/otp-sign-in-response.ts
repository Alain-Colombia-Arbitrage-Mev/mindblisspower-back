const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const email = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
const invalidProof = () => new Error('Authentication response could not be verified');

/** Repair only Better Auth 1.6.22's stale first-OTP user snapshot, never auth state. */
export async function verifiedOtpSignInResponse(returned: unknown, newSession: unknown, recipient: unknown,
  readUser: (userId: string) => Promise<unknown>): Promise<Record<string, unknown> | undefined> {
  // Errors, other response shapes and an already-verified response are untouched.
  // A missing newSession can be an interrupted/2FA flow, not proof of a login.
  if (!record(returned) || returned instanceof Error || 'error' in returned || 'code' in returned
    || !record(returned.user) || returned.user.emailVerified !== false || newSession == null) return;
  if (!record(newSession) || !record(newSession.session) || !record(newSession.user)) throw invalidProof();
  const { session, user } = newSession;
  const subject = session.userId;
  if (typeof subject !== 'string' || !subject || subject !== user.id || subject !== returned.user.id
    || typeof returned.token !== 'string' || !returned.token || returned.token !== session.token) throw invalidProof();
  const canonical = await readUser(subject);
  const canonicalEmail = record(canonical) ? email(canonical.email) : null;
  if (!record(canonical) || canonical.id !== subject || canonical.emailVerified !== true || !canonicalEmail
    || email(returned.user.email) !== canonicalEmail || email(user.email) !== canonicalEmail
    || email(recipient) !== canonicalEmail) throw invalidProof();
  // Preserve the exact native payload and its projection; do not expose fields
  // from the database, approve bindings or issue a token/session of our own.
  return { ...returned, user: { ...returned.user, emailVerified: true } };
}
