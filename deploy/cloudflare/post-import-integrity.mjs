import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { restoreTarget } from './import-verified-candidate.mjs';

export const integritySql = `BEGIN READ ONLY; SET LOCAL statement_timeout='300s'; SET LOCAL TimeZone='UTC';
SELECT json_build_object(
 'peopleHash',(SELECT md5(string_agg(md5(row_to_json(p)::text),'' ORDER BY p.id)) FROM mlm.person p),
 'packagesHash',(SELECT md5(string_agg(md5(row_to_json(p)::text),'' ORDER BY p.id)) FROM mlm.affiliate_package p),
 'walletsHash',(SELECT md5(string_agg(md5(row_to_json(w)::text),'' ORDER BY w.id)) FROM mlm.wallet w),
 'sequences',(SELECT json_agg(json_build_object('schema',schemaname,'name',sequencename,'lastValue',last_value::text,'startValue',start_value::text,'incrementBy',increment_by::text,'cycle',cycle) ORDER BY schemaname,sequencename)
              FROM pg_sequences WHERE schemaname IN ('audit','auth','mlm','payments','staging','support')));
ROLLBACK;`;

export function compareIntegrity(source, target) {
  if (!['peopleHash', 'packagesHash', 'walletsHash'].every(key => typeof source[key] === 'string' && /^[a-f0-9]{32}$/.test(source[key]) && target[key] === source[key]) ||
      !Array.isArray(source.sequences) || source.sequences.length !== 37 || JSON.stringify(source.sequences) !== JSON.stringify(target.sequences)) throw new Error('POST_IMPORT_CONTENT_MISMATCH');
  return { peoplePreserved: true, packagesPreserved: true, walletsPreserved: true, sequencesPreserved: source.sequences.length };
}

async function main() {
  const [name] = process.argv.slice(2);
  if (process.argv.length !== 3 || !/^mindbliss-import-[a-f0-9]{12}-pg18$/.test(name ?? '')) throw new Error('INVALID_ARGUMENTS');
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(directory, '../..');
  const output = path.join(directory, 'artifacts', name);
  const candidate = JSON.parse(readFileSync(path.join(output, 'candidate.json'), 'utf8'));
  const result = JSON.parse(readFileSync(path.join(output, 'import-result.json'), 'utf8'));
  const { pg, fingerprint } = restoreTarget(parseEnv(readFileSync(path.join(root, '.env.local'), 'utf8')));
  if (candidate.name !== name || candidate.database !== 'mindbliss_import_candidate' || result.status !== 'imported-and-verified' || result.targetFingerprint !== fingerprint) throw new Error('VERIFIED_IMPORT_REQUIRED');
  const sourceQuery = spawnSync('docker', ['exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-d', candidate.database, '-qAt', '-v', 'ON_ERROR_STOP=1'],
    { encoding: 'utf8', input: integritySql, maxBuffer: 4 * 1024 * 1024, timeout: 330000 });
  if (sourceQuery.status !== 0) throw new Error('SOURCE_READ_ONLY_CHECK_FAILED');
  const source = JSON.parse(sourceQuery.stdout);
  let targetQuery;
  for (let attempt = 0; attempt < 3; attempt++) {
    targetQuery = spawnSync('docker', ['run', '--rm', '-i', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      ...Object.keys(pg).flatMap(key => ['-e', key]), '--entrypoint', 'psql', 'mindbliss/backup:pg18-20261025', '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1'],
      { env: { ...process.env, ...pg, PGOPTIONS: '-c default_transaction_read_only=on -c timezone=UTC' }, encoding: 'utf8', input: integritySql, maxBuffer: 4 * 1024 * 1024, timeout: 330000 });
    if (targetQuery.status === 0 || !/could not translate host name/.test(targetQuery.stderr)) break;
    await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
  }
  if (targetQuery.status !== 0) throw new Error('TARGET_READ_ONLY_CHECK_FAILED');
  const target = JSON.parse(targetQuery.stdout);
  const verification = compareIntegrity(source, target);
  await writeFile(path.join(output, 'content-integrity.json'), JSON.stringify({ targetFingerprint: fingerprint, checkedAt: new Date().toISOString(), verification, source, target }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: 'additional-content-integrity-verified', ...verification }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => {
  console.log(JSON.stringify({ event: 'blocked', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'REDACTED_INTEGRITY_FAILURE' }));
  process.exitCode = 1;
});
