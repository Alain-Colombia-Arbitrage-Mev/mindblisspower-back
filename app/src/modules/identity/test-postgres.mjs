// Explicit, ephemeral integration harness. No host/cloud DSN is ever accepted.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

if (process.argv.slice(2).join(' ') !== '--synthetic-docker') throw new Error('Requires --synthetic-docker');
const name = `identity-synthetic-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const app = fileURLToPath(new URL('../../../', import.meta.url));
const migration = fileURLToPath(new URL('../../../../_meta/migration/70_stable_identity_bindings.sql', import.meta.url));
let created = false;
const docker = args => {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || 'Synthetic Docker command failed').replaceAll(password, '[redacted]'));
  return result.stdout.trim();
};
try {
  docker(['run', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
    '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=identity_synthetic',
    'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'disposable PostgreSQL did not become ready');
  const args = ['run', '--rm', '--network', `container:${name}`, '--read-only', '--tmpfs', '/tmp:mode=1777',
    '-v', `${app}/src:/app/src:ro`, '-v', `${migration}:/_meta/migration/70_stable_identity_bindings.sql:ro`,
    '-e', 'IDENTITY_SYNTHETIC_DOCKER=1', '-e', `IDENTITY_TEST_DATABASE_URL=postgres://postgres:${password}@127.0.0.1:5432/identity_synthetic`,
    'mindbliss/rds-api-test', 'bun', '--no-env-file', 'test', 'src/modules/identity/model.test.ts', 'src/modules/identity/identity.integration.test.ts'];
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  // The only connection string contains a disposable random password; suppress
  // it defensively even if a driver ever includes it in an unexpected error.
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replaceAll(password, '[redacted]');
  console.log(output);
  assert.equal(result.status, 0, 'synthetic identity integration failed');
} finally {
  if (created) docker(['rm', '-f', name]);
}
