const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const email = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
const invalidProof = () => new Error('Authentication response could not be verified');

/** Validate every successful OTP session against one fresh canonical user read.
 * Older releases also need the returned verified bit repaired; newer releases
 * already return it as true, but still must not bypass this proof boundary. */
export async function verifiedOtpSignInResponse(returned: unknown, newSession: unknown, recipient: unknown,
  readUser: (userId: string) => Promise<unknown>): Promise<Record<string, unknown> | undefined> {
  // Errors and interrupted/2FA flows have no new session to validate.
  if (!record(returned) || returned instanceof Error || 'error' in returned || 'code' in returned
    || !record(returned.user) || ![true, false].includes(returned.user.emailVerified as boolean) || newSession == null) return;
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
  // Preserve a current native payload exactly. For older stale snapshots,
  // change only the proven bit; never project private canonical fields.
  return returned.user.emailVerified === false
    ? { ...returned, user: { ...returned.user, emailVerified: true } }
    : undefined;
}
