import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const environment = {
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
  DATABASE_URL: 'postgres://business_reader:synthetic@db.example.invalid/mindbliss?sslmode=verify-full',
  AUTH_DATABASE_URL: 'postgres://auth_runtime:synthetic@db.example.invalid/mindbliss?sslmode=verify-full',
};
const execute = (script: string, env: Record<string, string | undefined> = environment) => spawnSync(process.execPath,
  ['--no-env-file', '-e', script], { cwd, env, encoding: 'utf8', timeout: 10_000 });

// Separate subprocesses keep module mocks out of the real handler test suite.
// Only explicit synthetic credentials are inherited; .env files are disabled.
describe('Bun authentication writer composition', () => {
  test('auth and business clients are distinct lazy pools with separate credentials and budgets', () => {
    const result = execute(`
      import assert from 'node:assert/strict';
      const { authDb } = await import('./src/db/auth-client.ts');
      const { db } = await import('./src/db/client.ts');
      assert.notEqual(authDb, db);
      assert.notEqual(authDb.$client, db.$client);
      assert.equal(authDb.$client.options.user, 'auth_runtime');
      assert.equal(db.$client.options.user, 'business_reader');
      assert.equal(authDb.$client.options.max, 4);
      assert.equal(db.$client.options.max, 10);
      assert.equal(authDb.$client.options.ssl, 'verify-full');
      assert.equal(authDb._.fullSchema.person, db._.fullSchema.person);
      await authDb.$client.end();
      await db.$client.end();
    `);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
  test('the Better Auth adapter and both identity callbacks receive only the auth writer', () => {
    const result = execute(`
      import assert from 'node:assert/strict';
      import { mock } from 'bun:test';
      const writer = { synthetic: 'writer' };
      const adapter = { synthetic: 'adapter' };
      let identity;
      const calls = [];
      mock.module('./src/db/auth-client.ts', () => ({ authDb: writer }));
      mock.module('better-auth/adapters/drizzle', () => ({ drizzleAdapter(database, options) {
        assert.equal(database, writer); assert.equal(options.provider, 'pg'); return adapter;
      } }));
      mock.module('./src/modules/identity/index.ts', () => ({
        provisionAuthPerson(database, input) { assert.equal(database, writer); calls.push(['provision', input.userId]); return { status: 'existing' }; },
        getAuthPersonBinding(database, input) { assert.equal(database, writer); calls.push(['binding', input.userId]); return { status: 'existing' }; },
      }));
      mock.module('./src/auth/options.ts', () => ({ createAuthOptions(_env, database, policy) {
        assert.equal(database, adapter); identity = policy; return { synthetic: 'options' };
      } }));
      mock.module('better-auth', () => ({ betterAuth(options) { return { options }; } }));
      const { auth } = await import('./src/auth.ts');
      assert.equal(auth.options.synthetic, 'options');
      await identity.provision('synthetic-user');
      await identity.binding('synthetic-user');
      assert.deepEqual(calls, [['provision', 'synthetic-user'], ['binding', 'synthetic-user']]);
    `);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
  test('production import fails closed before creating auth on a missing writer credential', () => {
    const result = execute(`await import('./src/db/auth-client.ts');`, { ...environment, AUTH_DATABASE_URL: undefined });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AUTH_DATABASE_URL required for production authentication');
    expect(result.stderr).not.toContain('business_reader:synthetic');
  });
  test('identity claim uses the writer, but its lookup and financial compatibility paths never gain that writer', () => {
    const result = execute(`
      import assert from 'node:assert/strict';
      import { mock } from 'bun:test';
      import { Hono } from 'hono';
      const reader = { transaction() { throw new Error('business_reader_is_not_writer'); } };
      const writer = { synthetic: 'writer' };
      const calls = [];
      const ledgerPost = () => 'ledger-post';
      const ledgerPv = () => 'ledger-pv';
      mock.module('./src/db/client.ts', () => ({ db: reader }));
      mock.module('./src/db/auth-client.ts', () => ({ authDb: writer }));
      mock.module('./src/modules/ledger/index.ts', () => ({ postTransaction: ledgerPost, registerPvCredit: ledgerPv }));
      mock.module('./src/modules/identity/index.ts', () => ({
        getAuthPersonBinding(database, input) { assert.equal(database, reader); assert.equal(input.userId, 'session-user'); calls.push('lookup'); return { status: 'existing' }; },
        claimLegacyPerson(database, input) { assert.equal(database, writer); assert.deepEqual(input, { userId: 'session-user', token: 'a'.repeat(64) }); calls.push('claim'); return { status: 'existing' }; },
        provisionAuthPerson(database, input) { assert.equal(database, writer); assert.deepEqual(input, { userId: 'session-user' }); calls.push('provision'); return { status: 'existing' }; },
      }));
      const { registerIdentityRoutes } = await import('./src/http/identity-routes.ts');
      const app = new Hono();
      app.use('*', async (context, next) => { context.set('session', context.req.header('x-synthetic-session') ? { user: { id: 'session-user' } } : null); await next(); });
      registerIdentityRoutes(app);
      assert.equal((await app.request('/api/member/identity', { headers: { 'x-synthetic-session': 'yes' } })).status, 200);
      const request = origin => app.request('/api/member/identity/claim', { method: 'POST',
        headers: { 'x-synthetic-session': 'yes', origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'a'.repeat(64), userId: 'attacker-selected-subject' }) });
      assert.equal((await request('https://portal.example.test')).status, 200);
      assert.equal((await request('https://evil.example.test')).status, 403);
      assert.equal((await app.request('/api/member/identity/claim', { method: 'POST' })).status, 401);
      const affiliate = await import('./src/server/affiliate.ts');
      await affiliate.createPersonFromUser({ userId: 'session-user', email: 'untrusted@example.test', name: 'Untrusted input' });
      assert.equal(affiliate.postTransaction, ledgerPost);
      assert.equal(affiliate.registerPvCredit, ledgerPv);
      await assert.rejects(() => affiliate.placeAffiliate({ personId: 1n, parentAffiliateId: 1n, position: 'L', sponsorAffiliateId: 2n }), /business_reader_is_not_writer/);
      await assert.rejects(() => affiliate.autoPlaceAffiliate({ personId: 1n, sponsorAffiliateId: 2n }), /business_reader_is_not_writer/);
      assert.deepEqual(calls, ['lookup', 'claim', 'provision']);
    `, { ...environment, BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
