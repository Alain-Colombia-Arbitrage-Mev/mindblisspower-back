import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import type { DBAdapter } from '@better-auth/core/db/adapter';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { createAuthOptions } from './options';
import type { AuthEnvironment, EmailMessage } from './delivery';
import { getAuthPersonBinding, provisionAuthPerson, type IdentityDatabase } from '../modules/identity';

// Real Better Auth and real identity policy; only adapter storage, SQL result
// rows and email delivery are synthetic. No environment URL or socket is used.
const env: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-pending-access-secret-at-least-32-characters',
  BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
  BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false',
  BETTER_AUTH_JWT_ENABLED: 'true', BETTER_AUTH_JWT_ISSUER: 'https://auth.example.test',
  BETTER_AUTH_JWT_AUDIENCE: 'synthetic-pending-members', CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-not-real',
  CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001', AUTH_EMAIL_FROM: 'auth@example.test',
};
const email = 'pending-member@example.test';
type Legacy = { id: string; email: string; user_id: null; status: string; blacklisted: boolean; is_admin: boolean };

function fixture(kind: 'unique' | 'duplicate' | 'blacklisted' = 'unique',
  canonicalFault?: 'unverified' | 'other-subject' | 'other-email' | 'missing' | 'unavailable') {
  const userId = 'synthetic-precreated-access';
  const store: MemoryDB = {
    user: [{ id: userId, email, name: 'Acceso pendiente', emailVerified: false,
      createdAt: new Date(), updatedAt: new Date() }],
    account: [], session: [], verification: [], rateLimit: [], jwks: [],
  };
  const legacy: Legacy[] = [{ id: '71', email, user_id: null, status: 'active', blacklisted: kind === 'blacklisted', is_admin: false }];
  if (kind === 'duplicate') legacy.push({ ...legacy[0]!, id: '72', email: email.toUpperCase() });
  const affiliates = legacy.map(row => ({ id: row.id, person_id: row.id, parent_id: null,
    sponsor_id: null, position: null, rank: 'PRESERVED', points_left: '110', points_right: '220' }));
  const fingerprint = JSON.stringify({ legacy, affiliates });
  const conflicts: { subject: string; candidate: string; reason: string }[] = [];
  const statements: string[] = [];
  const dialect = new PgDialect();
  const synthetic = {
    async execute(query: SQL) {
      const compiled = dialect.sqlToQuery(query);
      const text = compiled.sql.replace(/\s+/g, ' ').trim();
      statements.push(text);
      if (text.startsWith('SELECT id,contact_phone_e164 FROM auth.user')) return [{ id: userId, contact_phone_e164: null }];
      if (text.includes('FROM auth.user u LEFT JOIN identity.auth_binding')) return [{
        subject: userId, auth_email: email, email_verified: store.user![0]!.emailVerified,
        name: store.user![0]!.name, person_id: null, public_id: null, person_email: null,
        person_status: null, blacklisted: null, user_id: null, is_admin: null,
      }];
      if (text.startsWith('SELECT pg_advisory_xact_lock')) return [];
      if (text.includes('FROM mlm.person WHERE email=')) return legacy.filter(row => row.email.toLowerCase() === String(compiled.params[0]).toLowerCase());
      if (text.startsWith('INSERT INTO identity.link_conflict')) {
        const conflict = { subject: String(compiled.params[0]), candidate: String(compiled.params[1]), reason: String(compiled.params[2]) };
        if (!conflicts.some(row => JSON.stringify(row) === JSON.stringify(conflict))) conflicts.push(conflict);
        return [];
      }
      if (text.startsWith('SELECT 1 FROM identity.link_conflict')) return conflicts.filter(row =>
        row.subject === compiled.params[0] && ['identity_collision', 'person_unavailable'].includes(row.reason)).map(() => ({ one: 1 }));
      // A person insert, a binding, a grant, a role change or any other query
      // would fail this test rather than be silently accepted by a broad mock.
      throw new Error('Unexpected identity query in synthetic pending-access fixture');
    },
    async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> { return callback(synthetic); },
  };
  const database = synthetic as unknown as IdentityDatabase;
  const emails: EmailMessage[] = [];
  const provisioned: string[] = [];
  // PostgreSQL returns detached snapshots. Live memory references would hide
  // Better Auth's stale pre-verification user in the first OTP response.
  const memory = memoryAdapter(store);
  let canonicalReads = 0;
  const detached = (options: Parameters<typeof memory>[0]): DBAdapter => {
    const adapter = memory(options);
    return { ...adapter, findOne: async <T>(input: Parameters<DBAdapter['findOne']>[0]): Promise<T | null> => {
      const row = structuredClone(await adapter.findOne<T>(input));
      if (input.model === 'user' && input.where?.some(condition => condition.field === 'id') && store.session!.length > 0) {
        canonicalReads++;
        if (canonicalFault === 'unavailable') throw new Error('Synthetic canonical lookup unavailable');
        if (canonicalFault === 'missing') return null;
        if (row && typeof row === 'object') {
          if (canonicalFault === 'unverified') Object.assign(row, { emailVerified: false });
          if (canonicalFault === 'other-subject') Object.assign(row, { id: 'different-canonical-subject' });
          if (canonicalFault === 'other-email') Object.assign(row, { email: 'different-canonical@example.test' });
        }
      }
      return row;
    } };
  };
  const auth = betterAuth(createAuthOptions(env, detached, {
    provision: async subject => {
      const result = await provisionAuthPerson(database, { userId: subject });
      provisioned.push(result.status);
      return result;
    },
    binding: subject => getAuthPersonBinding(database, { userId: subject }),
    registrationAllowed: async () => true,
  }, { email: async message => { emails.push(message); }, phone: async () => { throw new Error('Unexpected synthetic SMS'); } }));
  let ip = 1;
  const request = (path: string, body?: unknown, cookie = '') => auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin: 'https://portal.example.test',
      'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${ip++}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const code = () => /\b(\d{6})\b/.exec(emails.at(-1)!.text)![1]!;
  function unchanged() {
    expect(JSON.stringify({ legacy, affiliates })).toBe(fingerprint);
    expect(store.user).toHaveLength(1);
    expect(store.user![0]!.id).toBe(userId);
    expect(store.user![0]!.name).toBe('Acceso pendiente');
    expect(store.user![0]!.role).toBeUndefined();
    expect(store.account).toHaveLength(0);
    expect(statements.some(text => /^(?:UPDATE|INSERT INTO) (?:mlm\.|identity\.auth_binding|identity\.legacy_claim_grant)/.test(text))).toBe(false);
  }
  return { store, emails, database, request, code, unchanged, provisioned, conflicts, canonicalReads: () => canonicalReads };
}
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

for (const kind of ['unique', 'duplicate', 'blacklisted'] as const) {
  test(`precreated unverified ${kind} legacy access receives OTP but email proof never auto-links network or grants a JWT`, async () => {
    const app = fixture(kind);
    expect((await getAuthPersonBinding(app.database, { userId: 'synthetic-precreated-access' })).status).toBe('verification_required');
    const sent = await app.request('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    expect(sent.status).toBe(200);
    expect(app.emails).toHaveLength(1);
    expect(app.store.user![0]!.emailVerified).toBe(false);
    expect(app.store.session).toHaveLength(0);
    expect(app.provisioned).toHaveLength(0);
    const code = app.code();
    expect(app.store.verification![0]!.value).toMatch(/^[a-f0-9]{64}:0$/);
    expect(JSON.stringify(app.store.verification)).not.toContain(code);
    app.unchanged();

    const signedIn = await app.request('/sign-in/email-otp', { email, otp: code });
    expect(signedIn.status).toBe(200);
    expect((await signedIn.clone().json() as { user: { id: string; emailVerified: boolean } }).user)
      .toMatchObject({ id: 'synthetic-precreated-access', emailVerified: true });
    expect(app.store.user![0]!.emailVerified).toBe(true);
    expect(app.store.session).toHaveLength(1);
    expect(app.store.verification).toHaveLength(0);
    expect(signedIn.headers.has('set-auth-jwt')).toBe(false);
    expect(app.canonicalReads()).toBe(1);
    expect(app.provisioned).toEqual([kind === 'blacklisted' ? 'quarantined' : 'claim_required']);
    expect(app.conflicts.map(row => row.reason)).toEqual([kind === 'blacklisted' ? 'person_unavailable' : 'legacy_claim_required']);
    const binding = await getAuthPersonBinding(app.database, { userId: 'synthetic-precreated-access' });
    expect(binding).toEqual({ status: kind === 'blacklisted' ? 'quarantined' : 'claim_required' });
    const cookie = cookies(signedIn);
    expect(cookie).toContain('better-auth.session_token=');
    const session = await app.request('/get-session', undefined, cookie);
    expect(session.status).toBe(200);
    expect((await session.json() as { user: { email: string; emailVerified: boolean } }).user)
      .toMatchObject({ email, emailVerified: true });
    const token = await app.request('/token', undefined, cookie);
    expect(token.status).toBe(403);
    expect(await token.text()).not.toContain('person_public_id');
    expect((await app.request('/sign-in/email-otp', { email, otp: code })).status).toBe(400);
    expect(app.emails).toHaveLength(1);
    app.unchanged();
  });
}

test('wrong and expired codes cannot verify or provision a precreated pending access', async () => {
  const app = fixture();
  await app.request('/email-otp/send-verification-otp', { email, type: 'sign-in' });
  const code = app.code();
  expect((await app.request('/sign-in/email-otp', { email, otp: code === '000000' ? '111111' : '000000' })).status).toBe(400);
  app.store.verification![0]!.expiresAt = new Date(Date.now() - 1000);
  expect((await app.request('/sign-in/email-otp', { email, otp: code })).status).toBe(400);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.session).toHaveLength(0);
  expect(app.provisioned).toHaveLength(0);
  app.unchanged();
});

test('already verified OTP login keeps its native response without an extra canonical lookup', async () => {
  const app = fixture();
  app.store.user![0]!.emailVerified = true;
  await app.request('/email-otp/send-verification-otp', { email, type: 'sign-in' });
  const response = await app.request('/sign-in/email-otp', { email, otp: app.code() });
  expect(response.status).toBe(200);
  expect((await response.clone().json() as { user: { emailVerified: boolean } }).user.emailVerified).toBe(true);
  expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
  expect(app.canonicalReads()).toBe(0);
  app.unchanged();
});

for (const fault of ['unverified', 'other-subject', 'other-email', 'missing', 'unavailable'] as const) {
  test(`unproven canonical OTP response (${fault}) fails explicitly and installs no cookie`, async () => {
    const app = fixture('unique', fault);
    await app.request('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    const code = app.code();
    const response = await app.request('/sign-in/email-otp', { email, otp: code });
    expect(response.status).toBe(500);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('set-auth-jwt')).toBe(false);
    expect(app.canonicalReads()).toBe(1);
    const body = await response.text();
    expect(body).not.toContain(code);
    expect(body).not.toContain(String(app.store.session![0]!.token));
    expect(body).not.toContain('Synthetic canonical');
    expect(body).not.toContain('person_public_id');
    // Do not undo native email proof or retry/redeem the consumed challenge.
    expect(app.store.user![0]!.emailVerified).toBe(true);
    expect(app.store.verification).toHaveLength(0);
    app.unchanged();
  });
}

test('registration of an already precreated access remains generic and cannot install a supplied password or send a registration code', async () => {
  const app = fixture();
  const signup = await app.request('/sign-up/email', { email, name: 'Not the stored neutral name', password: 'Synthetic-Unproven-Password-123' });
  expect(signup.status).toBe(200);
  const payload = await signup.json() as { token: unknown; user: { id: string; emailVerified: boolean } };
  expect(payload.token).toBeNull();
  expect(payload.user.emailVerified).toBe(false);
  expect(payload.user.id).not.toBe('synthetic-precreated-access');
  expect(app.emails).toHaveLength(0);
  expect(app.store.user![0]!.emailVerified).toBe(false);
  expect(app.store.session).toHaveLength(0);
  expect(app.provisioned).toHaveLength(0);
  app.unchanged();
});
