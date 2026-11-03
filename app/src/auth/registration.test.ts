import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DB } from '../db/client';
import { createAuthOptions, type AuthIdentity } from './options';
import { registrationAllowed } from './registration';
import type { AuthEnvironment } from './delivery';

const email = 'registration@example.test';
const candidate = { email, name: 'Synthetic Registration' };
const env: AuthEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-registration-precheck-secret-at-least-32-characters',
  BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
};
type Reader = Pick<DB, 'execute'>;
const readerWithReason = (reason: string): Reader => ({ execute: async () => [{ reason }] }) as unknown as Reader;

function fixture(registrationCheck?: AuthIdentity['registrationAllowed']) {
  const store: MemoryDB = { user: [], session: [], account: [], verification: [], rateLimit: [], jwks: [] };
  let sends = 0;
  let provisions = 0;
  const auth = betterAuth(createAuthOptions(env, memoryAdapter(store), {
    provision: async () => { provisions++; return { status: 'verification_required' }; },
    binding: async () => ({ status: 'claim_required' }),
    ...(registrationCheck ? { registrationAllowed: registrationCheck } : {}),
  }, { email: async () => { sends++; }, phone: async () => { sends++; } }));
  const signup = (extra: Record<string, unknown> = {}) => auth.handler(new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-up/email`, {
    method: 'POST', headers: { origin: 'https://portal.example.test', 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.91' },
    body: JSON.stringify({ ...candidate, password: 'Synthetic-Registration-Password-123', ...extra }),
  }));
  return { store, signup, effects: () => ({ sends, provisions }) };
}

test('registration blocks blacklist email, phone, exact name and suspended account before creation or delivery', async () => {
  for (const reason of ['blacklist_email', 'blacklist_phone', 'blacklist_name', 'account_suspended']) {
    const app = fixture(input => registrationAllowed(readerWithReason(reason), input));
    const response = await app.signup();
    expect(response.status).toBe(403);
    expect((await response.clone().json() as { code: string }).code).toBe('REGISTRATION_NOT_ALLOWED');
    expect(await response.text()).not.toContain(reason);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(app.store.user).toHaveLength(0);
    expect(app.store.account).toHaveLength(0);
    expect(app.store.session).toHaveLength(0);
    expect(app.store.verification).toHaveLength(0);
    expect(app.effects()).toEqual({ sends: 0, provisions: 0 });
  }
});

test('missing precheck, query failures and malformed decisions fail closed without leaking the underlying error', async () => {
  const broken: Reader = { execute: async () => { throw new Error('synthetic-sensitive-database-credential'); } } as unknown as Reader;
  const malformed: Reader = { execute: async () => [] } as unknown as Reader;
  for (const check of [undefined, (input: typeof candidate) => registrationAllowed(broken, input),
    (input: typeof candidate) => registrationAllowed(malformed, input)]) {
    const app = fixture(check);
    const response = await app.signup();
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain('synthetic-sensitive');
    expect(body).not.toContain(email);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(app.store.user).toHaveLength(0);
    expect(app.store.account).toHaveLength(0);
    expect(app.effects()).toEqual({ sends: 0, provisions: 0 });
  }
});

test('registration precheck preserves database normalization and parameterized Go ban semantics with no write statement', async () => {
  let captured: ReturnType<PgDialect['sqlToQuery']> | undefined;
  const reader: Reader = { execute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
    captured = new PgDialect().sqlToQuery(query);
    return [{ reason: '' }];
  } } as unknown as Reader;
  expect(await registrationAllowed(reader, { email: ' REGISTRATION@EXAMPLE.TEST ', name: "Synthetic ' Name",
    phone: '+12025550123', birthDate: '1990-01-12' })).toBe(true);
  expect(captured!.params).toEqual([email, '+12025550123', "Synthetic ' Name", '1990-01-12']);
  expect(captured!.sql).not.toContain(email);
  expect(captured!.sql).not.toContain("Synthetic ' Name");
  const query = captured!.sql.replace(/\s+/g, ' ');
  for (const fragment of ['mlm.norm_email($1)', 'mlm.norm_phone10($2)', 'mlm.norm_name($3)', '$4::date',
    'FROM mlm.person p', 'FROM mlm.affiliate a', 'FROM mlm.blacklist b', 'COALESCE(p.blacklisted,false)',
    "p.status::text IN ('suspended','banned','deleted')", "a.status::text IN ('suspended','banned','deleted')",
    'b.birthdate IS NULL OR (c.birthdate IS NOT NULL AND b.birthdate=c.birthdate)',
    'COALESCE(i.phone_last10,a.phone_last10)', 'COALESCE(i.birthdate,a.birthdate)']) expect(query).toContain(fragment);
  expect(query).not.toMatch(/\b(INSERT|UPDATE|DELETE|GRANT|CREATE|ALTER|CALL)\b/i);
});

test('only validated optional phone and birth date can reach the registration decision', async () => {
  let checks = 0;
  for (const extra of [{ phoneNumber: 'untrusted-phone' }, { birthDate: '2026-02-31' }, { name: ' ' }]) {
    const app = fixture(async () => { checks++; return true; });
    expect((await app.signup(extra)).status).toBe(400);
    expect(app.store.user).toHaveLength(0);
    expect(app.effects()).toEqual({ sends: 0, provisions: 0 });
  }
  expect(checks).toBe(0);
});
