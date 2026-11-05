import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('production diagnostic default uses only the auth primary in a read-only bounded transaction', () => {
  const result = spawnSync(process.execPath, ['--no-env-file', '-e', `
    import assert from 'node:assert/strict';
    import { mock } from 'bun:test';
    import { PgDialect } from 'drizzle-orm/pg-core';
    const statements=[];
    mock.module('./src/db/client.ts', () => ({ db: new Proxy({}, {get(){assert.fail('No business reader');}}) }));
    mock.module('./src/db/auth-client.ts', () => ({ authDb: { transaction: async work => work({execute: async query => {
      const compiled=new PgDialect().sqlToQuery(query); statements.push(compiled);
      if(compiled.sql.startsWith('WITH accounts')) return [{account_exists:true,email_verified:false,blocked:false,
        active_affiliate:false,binding_exists:true,ambiguous:false,allowed_after:null}];
      return [];
    }}) } }));
    const {diagnoseOtp}=await import('./src/auth/otp-diagnostic.ts');
    const result=await diagnoseOtp({AUTH_BFF_SHARED_SECRET:'synthetic-shared-key-at-least-32-characters',
      BETTER_AUTH_SECRET:'synthetic-auth-key-at-least-32-characters'}, {email:'synthetic@example.test'});
    assert.equal(result.diagnosis,'email_verification_pending');
    assert.deepEqual(statements.slice(0,4).map(s=>s.sql),[
      'SET TRANSACTION READ ONLY',"SET LOCAL statement_timeout='3s'","SET LOCAL lock_timeout='1s'",
      "SET LOCAL idle_in_transaction_session_timeout='5s'"]);
    assert.equal(statements.length,5);
    assert.ok(statements[4].params.includes('synthetic@example.test'));
    assert.ok(!/auth\\.(account|session|verification)|password|\\btoken\\b|verification\\.value/i.test(statements[4].sql));
  `], { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    encoding: 'utf8', timeout: 10000 });
  expect(result.stderr).toBe(''); expect(result.status).toBe(0);
});
