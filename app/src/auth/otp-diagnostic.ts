import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { recipientBudgetKey } from './phone-otp';
import { traceRecipientRef, traceSecret } from './otp-trace';
import { personAccessRestricted } from '../modules/identity/model';

type Environment = Record<string, string | undefined>;
export const otpDiagnosticInput = z.strictObject({ email: z.string().trim().toLowerCase().max(254).pipe(z.email()) });
export const OTP_DIAGNOSES = ['account_not_registered', 'blocked', 'ambiguous', 'cooldown_active',
  'email_verification_pending', 'binding_missing', 'ready'] as const;
export type OtpDiagnosticMetadata = { account_exists: boolean; email_verified: boolean; blocked: boolean;
  active_affiliate: boolean; binding_exists: boolean; ambiguous: boolean; allowed_after: number | string | null };
export type OtpDiagnostic = Omit<OtpDiagnosticMetadata, 'allowed_after'> & { provider: 'better-auth';
  cooldown_remaining_seconds: number; recipient_ref: string; diagnosis: typeof OTP_DIAGNOSES[number]; checked_at: string };
export type DiagnosticSelect = (statement: SQL) => Promise<OtpDiagnosticMetadata | undefined>;

/** One parameterized SELECT, final columns are booleans and a cooldown deadline.
 * Never reads passwords, sessions, tokens, OTP values or changes identity. */
export function otpDiagnosticStatement(email: string, budgetKey: string) {
  return sql`WITH accounts AS (
    SELECT id,email_verified FROM auth.user WHERE lower(trim(email))=${email}
  ), bindings AS (
    SELECT b.subject,b.person_id FROM identity.auth_binding b JOIN accounts u ON u.id=b.subject
    WHERE b.provider='better_auth'
  ), people AS (
    SELECT p.id,p.user_id,${personAccessRestricted} AS restricted
    FROM mlm.person p WHERE mlm.norm_email(p.email)=${email}
      OR EXISTS(SELECT 1 FROM bindings b WHERE b.person_id=p.id)
  ) SELECT
    EXISTS(SELECT 1 FROM accounts) AS account_exists,
    (SELECT count(*)=1 AND bool_and(email_verified) FROM accounts) AS email_verified,
    (EXISTS(SELECT 1 FROM people WHERE restricted)
      OR EXISTS(SELECT 1 FROM mlm.blacklist WHERE email_norm=${email})) AS blocked,
    EXISTS(SELECT 1 FROM mlm.affiliate a JOIN people p ON p.id=a.person_id
      WHERE a.status::text='active') AS active_affiliate,
    EXISTS(SELECT 1 FROM bindings b JOIN people p ON p.id=b.person_id
      JOIN mlm.person canonical ON canonical.id=p.id
      WHERE p.user_id=b.subject AND mlm.norm_email(canonical.email)=${email}) AS binding_exists,
    ((SELECT count(*)>1 FROM accounts) OR (SELECT count(*)>1 FROM people)
      OR EXISTS(SELECT 1 FROM bindings b JOIN mlm.person p ON p.id=b.person_id
        WHERE p.user_id IS DISTINCT FROM b.subject OR mlm.norm_email(p.email) IS DISTINCT FROM ${email})
      OR EXISTS(SELECT 1 FROM identity.link_conflict c JOIN accounts u ON u.id=c.subject
        WHERE c.resolved_at IS NULL AND c.reason IN ('identity_collision','person_unavailable'))) AS ambiguous,
    (SELECT last_request FROM auth.rate_limit WHERE key=${budgetKey} LIMIT 1) AS allowed_after`;
}

const metadataSchema = z.strictObject({ account_exists: z.boolean(), email_verified: z.boolean(), blocked: z.boolean(),
  active_affiliate: z.boolean(), binding_exists: z.boolean(), ambiguous: z.boolean(),
  allowed_after: z.union([z.number().int().safe(), z.string().regex(/^[0-9]{1,16}$/), z.null()]) });
async function primarySelect(statement: SQL) {
  const { authDb } = await import('../db/auth-client');
  return authDb.transaction(async transaction => {
    await transaction.execute(sql`SET TRANSACTION READ ONLY`);
    await transaction.execute(sql`SET LOCAL statement_timeout='3s'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='1s'`);
    await transaction.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
    return (await transaction.execute<OtpDiagnosticMetadata>(statement))[0];
  });
}
export async function diagnoseOtp(env: Environment, input: unknown, select: DiagnosticSelect = primarySelect,
  now = Date.now()): Promise<OtpDiagnostic> {
  const { email } = otpDiagnosticInput.parse(input), shared = traceSecret(env), authSecret = env.BETTER_AUTH_SECRET;
  if (!authSecret || authSecret.length < 32 || authSecret.length > 4096 || /[\r\n]/.test(authSecret)) throw new Error('diagnostic_unavailable');
  const metadata = metadataSchema.parse(await select(otpDiagnosticStatement(email, recipientBudgetKey(authSecret, email))));
  const allowedAfter = metadata.allowed_after === null ? 0 : Number(metadata.allowed_after);
  if (!Number.isSafeInteger(allowedAfter)) throw new Error('diagnostic_unavailable');
  const cooldown = Math.min(86400, Math.max(0, Math.ceil((allowedAfter - now) / 1000)));
  const diagnosis: OtpDiagnostic['diagnosis'] = metadata.blocked ? 'blocked' : metadata.ambiguous ? 'ambiguous'
    : !metadata.account_exists ? 'account_not_registered' : cooldown > 0 ? 'cooldown_active'
    : !metadata.email_verified ? 'email_verification_pending' : !metadata.binding_exists ? 'binding_missing' : 'ready';
  // Explicit projection: no private key or unrequested driver field can escape.
  return { provider: 'better-auth', account_exists: metadata.account_exists, email_verified: metadata.email_verified,
    blocked: metadata.blocked, active_affiliate: metadata.active_affiliate, binding_exists: metadata.binding_exists,
    ambiguous: metadata.ambiguous, cooldown_remaining_seconds: cooldown,
    recipient_ref: traceRecipientRef(shared, email), diagnosis, checked_at: new Date(now).toISOString() };
}
