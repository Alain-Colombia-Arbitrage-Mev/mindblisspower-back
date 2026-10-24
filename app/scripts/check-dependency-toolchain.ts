import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const output = await mkdtemp(join(tmpdir(), 'mindbliss-deps-'));
try {
  const env: Record<string, string> = { NODE_ENV: 'test' };
  for (const key of ['PATH', 'HOME', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  // Generation only: no application config, credentials or database is loaded.
  const result = spawnSync(process.execPath, ['node_modules/drizzle-kit/bin.cjs', 'generate',
    '--dialect=postgresql', '--schema=./src/db/schema/index.ts', `--out=${output}`],
  { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const migrations = (await readdir(output)).filter(file => file.endsWith('.sql'));
  assert.ok(migrations.length > 0, `Drizzle did not generate SQL with the patched esbuild: ${result.stdout} ${result.stderr}`);
  const generated = await readFile(join(output, migrations[0]!), 'utf8');
  assert.match(generated, /CREATE TABLE/);
  for (const column of ['left_count', 'right_count']) {
    assert.match(generated, new RegExp(`"${column}" bigint DEFAULT 0 NOT NULL`));
  }
  console.log('PASS: patched Drizzle/esbuild generates the actual schemas in a temporary directory; no SQL applied.');
} finally {
  assert.equal(dirname(resolve(output)), resolve(tmpdir()));
  assert.ok(basename(output).startsWith('mindbliss-deps-'));
  await rm(output, { recursive: true, force: true });
}
