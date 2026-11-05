import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the production admin gate reads the canonical primary authority with parameterized SELECT only, never the business reader', () => {
  const result = spawnSync(process.execPath, ['--no-env-file', '-e', `
    import assert from 'node:assert/strict';
    import { mock } from 'bun:test';
    import { Hono } from 'hono';
    import { PgDialect } from 'drizzle-orm/pg-core';
    const subject = "synthetic' OR true --";
    let calls = 0;
    const row = { subject, auth_email: 'admin@example.test', email_verified: true, name: 'Synthetic',
      person_id: '7', public_id: '51f8d415-0f6c-40b9-9544-f553f8c247c6', person_email: 'ADMIN@example.test',
      person_status: 'active', blacklisted: false, user_id: subject, is_admin: true, access_restricted: false };
    mock.module('./src/db/client.ts', () => ({ get db() { throw new Error('business_reader_must_not_authorize'); } }));
    mock.module('./src/db/auth-client.ts', () => ({ authDb: { execute: async query => {
      calls++;
      const statement = new PgDialect().sqlToQuery(query);
      assert.deepEqual(statement.params, [subject]);
      assert.ok(!statement.sql.includes(subject));
      for (const fragment of ['identity.auth_binding', 'auth.user', 'mlm.affiliate', 'mlm.blacklist', 'AS access_restricted']) assert.ok(statement.sql.includes(fragment));
      assert.ok(!/\\b(INSERT|UPDATE|DELETE|GRANT|REVOKE)\\b/.test(statement.sql));
      return [row];
    } } }));
    const { requireAdmin } = await import('./src/server/admin-gate.ts');
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('session', { user: { id: subject, role: 'untrusted' } }); await next(); });
    app.use('*', requireAdmin);
    app.get('/', c => c.json({ ok: true }));
    assert.equal((await app.request('/')).status, 200);
    row.access_restricted = true;
    assert.equal((await app.request('/')).status, 403);
    assert.equal(calls, 2);
  `], { cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10_000 });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
