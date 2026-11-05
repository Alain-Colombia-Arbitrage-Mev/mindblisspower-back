import { readFileSync, lstatSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Return private file contents only to the caller; never log the result object.
export function normalizePlanetScaleEnv(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const env = parseEnv(source);
  const assignment = key => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const bare = lines.map((line, index) => /^\s*postgres(?:ql)?:\/\//i.test(line) ? index : -1).filter(index => index >= 0);
  const assigned = lines.filter(line => assignment('DATABASE_URL').test(line)).length;
  if (assigned + bare.length !== 1) throw new Error('AMBIGUOUS_DATABASE_URL');
  let url;
  try { url = new URL(assigned ? env.DATABASE_URL : lines[bare[0]].trim()); }
  catch { throw new Error('INVALID_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.psdb.cloud') ||
      !url.username || !url.password || url.hash || url.pathname !== '/postgres' ||
      ![5432, 6432].includes(Number(url.port || 5432))) throw new Error('UNEXPECTED_PLANETSCALE_TARGET');
  if ([...url.searchParams.keys()].some(key => !['sslmode', 'sslrootcert'].includes(key)) ||
      ['sslmode', 'sslrootcert'].some(key => url.searchParams.getAll(key).length > 1)) throw new Error('UNREVIEWED_URL_OPTIONS');
  if (url.searchParams.get('sslmode') !== 'verify-full') throw new Error('VERIFIED_TLS_REQUIRED');
  if (url.searchParams.has('sslrootcert') && url.searchParams.get('sslrootcert') !== 'system') throw new Error('CUSTOM_CA_REQUIRES_REVIEW');
  if (env.DATABASE_CA_FILE || env.DATABASE_CA_PEM) throw new Error('CUSTOM_CA_REQUIRES_REVIEW');
  if (env.DATABASE_POOL_MAX !== undefined &&
      (!/^\d+$/.test(env.DATABASE_POOL_MAX) || Number(env.DATABASE_POOL_MAX) < 1 || Number(env.DATABASE_POOL_MAX) > 5)) throw new Error('POOL_LIMIT_REQUIRES_REVIEW');

  // Postgres.js forwards sslrootcert as a startup parameter (42704). Node uses
  // its trusted CA store with sslmode=verify-full; do not weaken certificate checks.
  url.searchParams.delete('sslrootcert');
  const values = { DATABASE_URL: JSON.stringify(url.href), PGBOUNCER: url.port === '6432' ? 'true' : 'false', DATABASE_POOL_MAX: env.DATABASE_POOL_MAX ?? '5' };
  if (bare.length) lines[bare[0]] = `DATABASE_URL=${values.DATABASE_URL}`;
  for (const [key, value] of Object.entries(values)) {
    const indices = lines.map((line, index) => assignment(key).test(line) ? index : -1).filter(index => index >= 0);
    if (indices.length > 1) throw new Error('DUPLICATE_DATABASE_SETTING');
    if (indices.length) lines[indices[0]] = `${key}=${value}`;
    else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
  }
  const contents = lines.join(newline);
  return { contents, changed: contents !== source, port: Number(url.port || 5432), pgbouncer: values.PGBOUNCER === 'true' };
}

function main() {
  let temporary;
  try {
    if (process.argv.slice(2).some(arg => !['--check', '--apply'].includes(arg)) || process.argv.length > 3) throw new Error('INVALID_ARGUMENTS');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const path = resolve(root, '.env.local');
    execFileSync('git', ['check-ignore', '-q', '--', '.env.local'], { cwd: root, stdio: 'ignore' });
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('REGULAR_PRIVATE_FILE_REQUIRED');
    const source = readFileSync(path, 'utf8');
    const result = normalizePlanetScaleEnv(source);
    let applied = false;
    if (process.argv.includes('--apply') && result.changed) {
      temporary = resolve(root, `.env.normalize-${randomUUID()}.local`);
      writeFileSync(temporary, result.contents, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
      if (readFileSync(path, 'utf8') !== source) throw new Error('CONFIGURATION_CHANGED_CONCURRENTLY');
      renameSync(temporary, path);
      temporary = undefined;
      applied = true;
    }
    console.log(JSON.stringify({ valid: true, changeRequired: result.changed, applied, port: result.port, pgbouncer: result.pgbouncer, tls: 'verify-full' }));
  } catch {
    console.log(JSON.stringify({ valid: false, code: 'LOCAL_CONFIGURATION_REQUIRES_REVIEW' }));
    process.exitCode = 1;
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* Do not log private paths or file contents. */ } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
