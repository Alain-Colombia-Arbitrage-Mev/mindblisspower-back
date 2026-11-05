import { expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { diagnoseOtp, otpDiagnosticStatement, type OtpDiagnosticMetadata } from './otp-diagnostic';
import { recipientBudgetKey } from './phone-otp';
import { traceRecipientRef } from './otp-trace';

const env = { AUTH_BFF_SHARED_SECRET: 'synthetic-diagnostic-shared-secret-at-least32', BETTER_AUTH_SECRET: 'synthetic-auth-secret-at-least-32-characters' };
const email = 'private-fixture@example.test', now = Date.now();
const normal: OtpDiagnosticMetadata = { account_exists: true, email_verified: true, blocked: false, active_affiliate: true,
  binding_exists: true, ambiguous: false, allowed_after: null };

test('diagnostic is a parameterized SELECT-only metadata snapshot; no credential/OTP/session/private-column query', () => {
  const budget = recipientBudgetKey(env.BETTER_AUTH_SECRET, email), query = new PgDialect().sqlToQuery(otpDiagnosticStatement(email, budget));
  expect(query.sql).toMatch(/^WITH accounts AS/); expect(query.sql).not.toContain(email); expect(query.params).toContain(email); expect(query.params).toContain(budget);
  expect(query.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE)\b/i);
  expect(query.sql).not.toMatch(/auth\.(account|session|verification)|password|\btoken\b|verification\.value|SELECT\s+\*/i);
  expect(query.sql).toContain('identity.link_conflict'); expect(query.sql).toContain('mlm.blacklist'); expect(query.sql).toContain('auth.rate_limit');
});

test('diagnosis precedence preserves restrictions/ambiguity, email proof and binding without writing any state', async () => {
  for (const [row, diagnosis] of [
    [normal, 'ready'], [{ ...normal, active_affiliate: false }, 'ready'],
    [{ ...normal, account_exists: false, email_verified: false, binding_exists: false }, 'account_not_registered'],
    [{ ...normal, email_verified: false }, 'email_verification_pending'], [{ ...normal, binding_exists: false }, 'binding_missing'],
    [{ ...normal, allowed_after: String(now + 5200) }, 'cooldown_active'], [{ ...normal, ambiguous: true }, 'ambiguous'],
    [{ ...normal, blocked: true, ambiguous: true }, 'blocked'],
  ] as const) {
    let calls = 0;
    const result = await diagnoseOtp(env, { email: ` ${email.toUpperCase()} ` }, async () => { calls++; return row; }, now);
    expect(calls).toBe(1); expect(result.diagnosis).toBe(diagnosis); expect(result.provider).toBe('better-auth');
    expect(result.recipient_ref).toBe(traceRecipientRef(env.AUTH_BFF_SHARED_SECRET, email));
    expect(result.checked_at).toBe(new Date(now).toISOString()); expect(JSON.stringify(result)).not.toContain(email);
    expect('allowed_after' in result).toBe(false);
    if (row.allowed_after) expect(result.cooldown_remaining_seconds).toBe(6);
  }
});

test('malformed input/configuration/driver data fail closed without partial or raw responses', async () => {
  for (const input of [{ email, extra: 'private' }, { email: 'not-email' }, { email: 9 }, {}]) {
    await expect(diagnoseOtp(env, input, async () => { throw Error('Must not query'); })).rejects.toBeDefined();
  }
  for (const row of [undefined, { ...normal, email_verified: null }, { ...normal, account_exists: 'yes' },
    { ...normal, allowed_after: 'private-value' }, { ...normal, allowed_after: '9999999999999999' }, { ...normal, private_password: 'forbidden' }]) {
    await expect(diagnoseOtp(env, { email }, async () => row as never)).rejects.toBeDefined();
  }
  for (const configuration of [{ ...env, AUTH_BFF_SHARED_SECRET: '' }, { ...env, BETTER_AUTH_SECRET: 'short' }]) {
    await expect(diagnoseOtp(configuration, { email }, async () => { throw Error('Must not query'); })).rejects.toBeDefined();
  }
  expect((await diagnoseOtp(env, { email }, async () => ({ ...normal, allowed_after: now - 1 }), now)).cooldown_remaining_seconds).toBe(0);
  expect((await diagnoseOtp(env, { email }, async () => ({ ...normal, allowed_after: now + 864000000 }), now)).cooldown_remaining_seconds).toBe(86400);
});
