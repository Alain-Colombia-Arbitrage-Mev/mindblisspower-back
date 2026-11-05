import { expect, test } from 'bun:test';
import { classify, connectTarget, createPlan, targetConfiguration, validatePlan, type Snapshot, type Source } from './pending-email-access-migration';
const source = (id: number, email: string, extra: Partial<Source> = {}): Source => ({ id: String(id), email, status: 'active', userId: null, blocked: false, ...extra });
const snapshot = (rows: Source[]): Snapshot => ({ source: rows, existing: [{ id: 'admin', email: 'admin@example.test' }], schemaDigest: 'a'.repeat(64) });
const target = 'b'.repeat(64);

test('pending cohort uses the real email validator, rejects whitespace/collisions and never borrows existing auth identities', () => {
  const input = snapshot([
    source(1, 'GOOD@example.test'), source(2, 'invalid'), source(3, ' padded@example.test '),
    source(4, 'collision@example.test'), source(5, ' COLLISION@example.test '),
    source(6, 'admin@example.test'), source(7, 'suspended@example.test', { status: 'suspended' }),
    source(8, 'blocked@example.test', { blocked: true }), source(9, 'linked@example.test', { userId: 'old-subject' }),
    source(10, 'pending@example.test', { status: 'pending' }), source(11, 'banned@example.test', { status: 'banned' }),
    source(12, 'deleted@example.test', { status: 'deleted' }), source(13, 'a..b@example.test'),
  ]);
  expect(classify(input).eligible.map(row => row.email)).toEqual(['good@example.test', 'pending@example.test']);
  expect(classify(input).counts).toMatchObject({ eligible: 2, invalidEmail: 2, whitespaceEmail: 1,
    duplicateNormalizedEmail: 2, unavailable: 4, legacyLinked: 1, alreadyPresent: 1 });
  expect(input.source[0]!.email).toBe('GOOD@example.test');
});

test('plans contain only audit IDs/digests/counts, no plaintext contacts or business authority', () => {
  const input = snapshot([source(1, 'private-customer@example.test')]);
  const plan = createPlan(input, target);
  expect(validatePlan(JSON.parse(JSON.stringify(plan)), plan.digest, target)).toEqual(plan);
  expect(plan.candidates).toHaveLength(1);
  const text = JSON.stringify(plan);
  for (const forbidden of ['private-customer@example.test', 'admin@example.test', 'password', 'emailVerified', 'auth_binding', 'phone', 'superadmin']) expect(text).not.toContain(forbidden);
  expect(plan.candidates[0]!.authId).not.toBe(input.source[0]!.id);
});

test('cohort refuses addresses beyond the portal/admin OTP boundary of 254 characters', () => {
  const long = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.test`;
  expect(long.length).toBeGreaterThan(254);
  expect(classify(snapshot([source(1, long)])).counts).toMatchObject({ invalidEmail: 1, eligible: 0 });
});

test('operator plans are pinned and cannot silently accept a changed cohort, ID set or target', () => {
  const plan = createPlan(snapshot([source(1, 'one@example.test')]), target);
  expect(() => validatePlan(plan, 'c'.repeat(64), target)).toThrow('PLAN_PIN_MISMATCH');
  expect(() => validatePlan(plan, plan.digest, 'd'.repeat(64))).toThrow('PLAN_PIN_MISMATCH');
  expect(() => validatePlan({ ...plan, candidates: [] }, plan.digest, target)).toThrow('PLAN_PIN_MISMATCH');
  expect(() => validatePlan({ ...plan, authority: true }, plan.digest, target)).toThrow('PLAN_INVALID');
});

test('target validation requires explicit verified TLS, fixed connection routing and an independent target pin', () => {
  const raw = 'postgres://synthetic-user:synthetic-password@db.example.test:5432/postgres?sslmode=verify-full';
  const config = targetConfiguration(raw);
  expect(config.target).toMatch(/^[a-f0-9]{64}$/);
  for (const invalid of [undefined, 'https://db.example.test', raw.replace('verify-full', 'disable'),
    raw + '&options=unreviewed', raw + '&sslmode=disable', raw + '#fragment']) {
    expect(() => targetConfiguration(invalid)).toThrow();
  }
  expect(() => connectTarget(raw, 'e'.repeat(64))).toThrow('TARGET_PIN_MISMATCH');
  expect(targetConfiguration('postgres://fixture:fixture@127.0.0.1:5432/scratch?sslmode=disable').local).toBe(true);
});
