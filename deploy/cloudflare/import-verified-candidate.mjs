import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, writeFile, stat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const archiveDirectory = 'D:/vicionpower/backups/local-historical-20261022';
const archiveName = 'vicionpower-local-historical-20261022.dump';
const expectedHash = 'b96f67ad91a69706f0c8c307293d0200fa4b90b74d5d958e0fa340787097d792';
const tools = 'mindbliss/backup:pg18-20261025';
const schemas = ['audit', 'auth', 'mlm', 'payments', 'staging', 'support'];
const schemasSql = schemas.map(s => `'${s}'`).join(',');

function require(condition, code) { if (!condition) throw new Error(code); }
export function restoreTarget(env) {
  let url, app;
  try { url = new URL(env.RESTORE_DATABASE_URL); app = new URL(env.DATABASE_URL); }
  catch { throw new Error('RESTORE_URL_REQUIRED'); }
  require(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname.endsWith('.psdb.cloud') &&
    url.hostname === app.hostname && url.pathname === '/postgres' && url.pathname === app.pathname &&
    url.username && url.password && !url.hash && [5432, 6432].includes(Number(url.port || 5432)), 'RESTORE_TARGET_MISMATCH');
  require(url.searchParams.get('sslmode') === 'verify-full' &&
    [...url.searchParams.keys()].every(key => ['sslmode', 'sslrootcert'].includes(key)) &&
    ['sslmode', 'sslrootcert'].every(key => url.searchParams.getAll(key).length <= 1) &&
    (!url.searchParams.has('sslrootcert') || url.searchParams.get('sslrootcert') === 'system'), 'VERIFIED_SYSTEM_TLS_REQUIRED');
  require(url.username !== app.username, 'SEPARATE_RESTORE_ROLE_REQUIRED');
  const pg = { PGHOST: url.hostname, PGPORT: '5432', PGDATABASE: 'postgres', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: 'verify-full', PGSSLROOTCERT: 'system', PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: 'mindbliss-verified-import', PGOPTIONS: '-c timezone=UTC -c lock_timeout=15000 -c statement_timeout=0 -c default_toast_compression=pglz' };
  require(Object.values(pg).every(value => !/[\r\n\x00]/.test(value)), 'INVALID_CONNECTION_FIELDS');
  return { pg, fingerprint: createHash('sha256').update(JSON.stringify([url.hostname, '5432', 'postgres'])).digest('hex') };
}

export function approvedToc(text) {
  const tables = text.split('\n').filter(line => /^\d+; \d+ \d+ TABLE (?!DATA )/.test(line));
  const data = text.split('\n').filter(line => /^\d+; \d+ \d+ TABLE DATA /.test(line));
  require(tables.length === 61 && data.length === 61 && tables.every(line => schemas.some(schema => new RegExp(` TABLE ${schema} `).test(line))), 'ARCHIVE_TABLE_SELECTION_CHANGED');
  require(!/^\d+; \d+ \d+ (?:FOREIGN|USER MAPPING|SUBSCRIPTION|EVENT TRIGGER)/m.test(text), 'UNREVIEWED_EXECUTABLE_OBJECT');
  const excluded = [];
  const result = text.split('\n').filter(line => {
    const omit = /^\d+; \d+ \d+ (?:EXTENSION - pg_stat_statements |COMMENT - EXTENSION pg_stat_statements(?:\s|$))/.test(line);
    if (omit) excluded.push(line.match(/^(\d+);/)[1]);
    return !omit;
  }).join('\n');
  require(excluded.length === 2, 'MONITORING_EXTENSION_SELECTION_CHANGED');
  return { text: result, excluded, tables: 61, tableData: 61 };
}

async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function docker(args, { env = {}, input, log } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', () => reject(new Error('DOCKER_FAILED')));
    child.on('close', async code => {
      try {
        if (log) await writeFile(log, Buffer.concat(stderr), { mode: 0o600 });
        if (code !== 0) return reject(new Error('DOCKER_COMMAND_FAILED_SEE_PRIVATE_LOG'));
        resolve(Buffer.concat(stdout).toString('utf8').trim());
      } catch { reject(new Error('PRIVATE_LOG_FAILED')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const sharedArgs = () => ['run', '--rm', '-i', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];
async function remoteQuery(pg, sql, log) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(await docker([...sharedArgs(), ...Object.keys(pg).flatMap(key => ['-e', key]), '--entrypoint', 'psql', tools, '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1'],
        { env: pg, input: `BEGIN READ ONLY; SET LOCAL statement_timeout='300s'; SET LOCAL TimeZone='UTC'; ${sql}; ROLLBACK;`, log }));
    } catch (error) {
      // Only retry DNS failures before a READ ONLY query. Never retry writes.
      if (attempt === 2 || !log || !/could not translate host name/.test(readFileSync(log, 'utf8'))) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
}
const baselineSql = `SELECT json_build_object('versionNum',current_setting('server_version_num')::int,
 'replica',pg_is_in_recovery(),'canCreateSchema',has_database_privilege(current_database(),'CREATE'),'canCreatePublic',has_schema_privilege('public','CREATE'),
 'schemas',(SELECT coalesce(json_agg(nspname ORDER BY nspname),'[]') FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname !~ '^pg_'),
 'appObjects',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('information_schema','pscale_extensions') AND n.nspname !~ '^pg_' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')),
 'customRoutines',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('information_schema','pscale_extensions') AND n.nspname !~ '^pg_' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')),
 'providerViews',(SELECT coalesce(json_agg(json_build_object('name',c.relname,'definition',md5(pg_get_viewdef(c.oid))) ORDER BY c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pscale_extensions' AND c.relkind='v'),
 'extensions',(SELECT json_agg(json_build_object('name',name,'version',default_version) ORDER BY name) FROM pg_available_extensions WHERE name IN ('btree_gist','citext','ltree','pgcrypto','unaccent','uuid-ossp')))`;

export function validateBaseline(baseline, candidate) {
  require(baseline.versionNum === 180006 && !baseline.replica && baseline.canCreateSchema && baseline.canCreatePublic, 'TARGET_ROLE_OR_VERSION_BLOCKED');
  require(baseline.appObjects === 0 && baseline.customRoutines === 0 && baseline.schemas.every(s => ['public', 'pscale_extensions'].includes(s)), 'TARGET_NOT_EMPTY');
  require(baseline.extensions.length === 6 && baseline.extensions.every(e => candidate.summary.extensions.some(x => x.name === e.name && x.version === e.version)), 'TARGET_EXTENSION_MISMATCH');
}

export const pathStorageSql = `ALTER TABLE mlm.affiliate ALTER COLUMN path SET COMPRESSION pglz;
SELECT json_build_object('compression',a.attcompression) FROM pg_attribute a
JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='mlm' AND c.relname='affiliate' AND a.attname='path' AND a.attnum>0 AND NOT a.attisdropped;`;

export function restoreFailureCode(stderr) {
  if (/No space left on device|disk quota exceeded/i.test(stderr)) return 'TARGET_STORAGE_EXHAUSTED_REVIEW_CAPACITY';
  if (/pg_readonly:|cluster is read-only/i.test(stderr)) return 'TARGET_READ_ONLY_REVIEW_PROVIDER';
  return 'DOCKER_COMMAND_FAILED_SEE_PRIVATE_LOG';
}

async function exists(file) { try { await access(file); return true; } catch { return false; } }

async function main() {
  require(!process.env.CI, 'REAL_DATA_IMPORT_FORBIDDEN_IN_CI');
  const [candidateName, mode] = process.argv.slice(2);
  require(/^mindbliss-import-[a-f0-9]{12}-pg18$/.test(candidateName ?? '') && ['--plan', '--apply'].includes(mode) && process.argv.length === 4, 'INVALID_ARGUMENTS');
  const output = path.join(directory, 'artifacts', candidateName);
  const candidate = JSON.parse(readFileSync(path.join(output, 'candidate.json'), 'utf8'));
  require(candidate.name === candidateName && candidate.status === 'restored-local-only' && candidate.archiveSha256 === expectedHash && candidate.counts.length === 61 &&
    candidate.inventory.invalidConstraints === 0 && candidate.inventory.invalidIndexes === 0 && candidate.summary.people === 121066 && candidate.summary.affiliates === 121013, 'UNVERIFIED_CANDIDATE');
  require(await sha256(path.join(archiveDirectory, archiveName)) === expectedHash, 'SOURCE_ARCHIVE_CHANGED');
  const toc = readFileSync(path.join(output, 'full.toc'), 'utf8');
  const freshToc = await docker(['run', '--rm', '--network', 'none', '--read-only', '-v', `${archiveDirectory}:/input:ro`, '--entrypoint', 'pg_restore', tools, '--list', `/input/${archiveName}`]);
  require(freshToc === toc, 'NATIVE_TOC_CHANGED');
  const approved = approvedToc(toc);
  await writeFile(path.join(output, 'approved.list'), approved.text, { mode: 0o600 });
  const { pg, fingerprint } = restoreTarget(parseEnv(readFileSync(path.join(root, '.env.local'), 'utf8')));
  const before = await remoteQuery(pg, baselineSql, path.join(output, 'preflight.stderr.log'));
  validateBaseline(before, candidate);
  const plan = { mode: 'plan', candidateName, archiveSha256: expectedHash, targetFingerprint: fingerprint, tables: 61, dataSections: 61,
    monitoringExtensionExcluded: 'pg_stat_statements', excludedTocIds: approved.excluded, approvedTocSha256: createHash('sha256').update(approved.text).digest('hex'), baseline: before };
  await writeFile(path.join(output, 'import-plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: 'preflight-passed', targetFingerprint: fingerprint, tables: 61, monitoringDeferred: 'pg_stat_statements', mode }));
  if (mode === '--plan') return;

  // Keep the recovery key outside the repository and separate from the archive.
  const keyDirectory = `D:/vicionpower/backups/private-keys/${candidateName}`;
  const encryptedDirectory = path.join(archiveDirectory, 'encrypted', candidateName);
  await mkdir(keyDirectory, { recursive: true, mode: 0o700 });
  await mkdir(encryptedDirectory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') execFileSync('icacls.exe', [keyDirectory, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], { stdio: 'ignore' });
  const encryptedPath = path.join(encryptedDirectory, `${archiveName}.age`);
  const manifestPath = path.join(encryptedDirectory, 'manifest.json');
  const prior = await Promise.all([exists(encryptedPath), exists(manifestPath), exists(path.join(keyDirectory, 'recovery.agekey'))]);
  let backup;
  if (prior.some(Boolean)) {
    require(prior.every(Boolean), 'INCOMPLETE_EXISTING_ENCRYPTED_BACKUP');
    backup = JSON.parse(readFileSync(manifestPath, 'utf8'));
    require(backup.sourceArchiveSha256 === expectedHash && backup.database.file === `${archiveName}.age` &&
      backup.database.bytes === (await stat(encryptedPath)).size && backup.database.sha256 === await sha256(encryptedPath), 'EXISTING_ENCRYPTED_BACKUP_CHANGED');
  } else {
    await docker(['run', '--rm', '--network', 'none', '-v', `${keyDirectory}:/keys`, '--entrypoint', 'age-keygen', tools, '-o', '/keys/recovery.agekey']);
    const recipient = await docker(['run', '--rm', '--network', 'none', '-v', `${keyDirectory}:/keys:ro`, '--entrypoint', 'age-keygen', tools, '-y', '/keys/recovery.agekey']);
    require(/^age1[a-z0-9]+$/.test(recipient), 'INVALID_BACKUP_RECIPIENT');
    await docker(['run', '--rm', '--network', 'none', '-v', `${archiveDirectory}:/input:ro`, '-v', `${encryptedDirectory}:/output`, '--entrypoint', 'age', tools, '-r', recipient, '-o', `/output/${archiveName}.age`, `/input/${archiveName}`]);
    backup = { format: 'mindbliss-historical-archive-v1', postgresMajor: 17, sourceArchiveSha256: expectedHash, archiveCreatedAt: '2026-10-22T12:02:20Z',
      database: { file: `${archiveName}.age`, bytes: (await stat(encryptedPath)).size, sha256: await sha256(encryptedPath) },
      sourceDataLatestUpdatedAt: '2026-07-14T04:29:16.275109Z', sourceExtensionVersions: 'not recorded in original archive; compatibility verified on PG18.6',
      candidateExtensions: candidate.summary.extensions, allBusinessTablesIncluded: true };
    await writeFile(manifestPath, JSON.stringify(backup, null, 2), { mode: 0o600 });
  }
  const fresh = await remoteQuery(pg, baselineSql, path.join(output, 'pre-import.stderr.log'));
  validateBaseline(fresh, candidate);
  require(JSON.stringify(fresh.providerViews) === JSON.stringify(before.providerViews), 'PROVIDER_BASELINE_CHANGED');
  console.log(JSON.stringify({ event: 'import-starting', tables: 61, singleTransaction: true, directPort: 5432, verifiedTls: true }));
  const interval = setInterval(() => console.log(JSON.stringify({ event: 'import-running', candidateName })), 30000);
  try {
    const script = `set -eu; age -d -i /keys/recovery.agekey -o /work/source.dump /input/${archiveName}.age; printf '%s  %s\\n' '${expectedHash}' /work/source.dump | sha256sum -c - >/dev/null; exec pg_restore -w --dbname="$PGDATABASE" --single-transaction --exit-on-error --use-list=/review/approved.list --no-owner --no-acl --no-comments --no-security-labels --no-publications --no-subscriptions --no-tablespaces /work/source.dump`;
    const log = path.join(output, `import-${new Date().toISOString().replaceAll(':', '-')}.stderr.log`);
    try {
      await docker([...sharedArgs(), '--memory', '2g', '--tmpfs', '/work:uid=70,gid=70,mode=0700,size=1g', '-v', `${encryptedDirectory}:/input:ro`, '-v', `${keyDirectory}:/keys:ro`, '-v', `${output}:/review:ro`, ...Object.keys(pg).flatMap(key => ['-e', key]), '--entrypoint', 'sh', tools, '-ec', script], { env: pg, log });
    } catch (error) {
      if (error.message !== 'DOCKER_COMMAND_FAILED_SEE_PRIVATE_LOG') throw error;
      throw new Error(restoreFailureCode(readFileSync(log, 'utf8')));
    }
  } finally { clearInterval(interval); }
  await writeFile(path.join(output, 'import-committed.json'), JSON.stringify({ targetFingerprint: fingerprint, committedAt: new Date().toISOString(), backup, status: 'committed-pending-verification' }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: 'import-committed-pending-verification' }));
  // Persist the tested storage choice for future tree placements as well as COPY.
  // This does not rewrite rows or alter any path/position value.
  const storage = JSON.parse(await docker([...sharedArgs(), ...Object.keys(pg).flatMap(key => ['-e', key]), '--entrypoint', 'psql', tools,
    '-X', '-w', '-qAt', '--single-transaction', '-v', 'ON_ERROR_STOP=1'], { env: pg, input: pathStorageSql, log: path.join(output, 'path-storage.stderr.log') }));
  require(storage.compression === 'p', 'PATH_STORAGE_COMPATIBILITY_FAILED');
  const counts = [];
  for (const row of candidate.counts) {
    require(schemas.includes(row.schema) && /^[a-z_][a-z0-9_]*$/.test(row.table), 'INVALID_TABLE_INVENTORY');
    const observed = await remoteQuery(pg, `SELECT json_build_object('count',count(*)) FROM "${row.schema}"."${row.table}"`, path.join(output, 'verification.stderr.log'));
    require(observed.count === row.count, 'IMPORTED_ROW_COUNT_MISMATCH');
    counts.push({ ...row, verified: true });
  }
  const verified = await remoteQuery(pg, `SELECT json_build_object(
    'treeHash',(SELECT md5(string_agg(md5(row_to_json(a)::text),'' ORDER BY a.id)) FROM mlm.affiliate a),
    'invalidConstraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN (${schemasSql}) AND NOT convalidated),
    'invalidIndexes',(SELECT count(*) FROM pg_index WHERE NOT indisvalid),
    'providerViews',(SELECT coalesce(json_agg(json_build_object('name',c.relname,'definition',md5(pg_get_viewdef(c.oid))) ORDER BY c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='pscale_extensions' AND c.relkind='v'),
    'extensions',(SELECT json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension),
    'latestPersonUpdate',(SELECT max(updated_at) FROM mlm.person),'latestAffiliateUpdate',(SELECT max(updated_at) FROM mlm.affiliate))`, path.join(output, 'final-verification.stderr.log'));
  require(verified.treeHash === candidate.summary.treeHash && verified.invalidConstraints === 0 && verified.invalidIndexes === 0 && JSON.stringify(verified.providerViews) === JSON.stringify(before.providerViews), 'POST_IMPORT_INTEGRITY_MISMATCH');
  const result = { status: 'imported-and-verified', targetFingerprint: fingerprint, archiveSha256: expectedHash, counts, verified, backup,
    applicationsStarted: false, financialJobsStarted: false, affiliatePathCompression: 'pglz', monitoringPending: 'pg_stat_statements dashboard enablement', verifiedAt: new Date().toISOString() };
  await writeFile(path.join(output, 'import-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: 'import-verified', tables: counts.length, people: 121066, affiliates: 121013, treeHashPreserved: true, invalidIndexes: 0, invalidConstraints: 0, applicationsStarted: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => {
  console.log(JSON.stringify({ event: 'blocked', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'REDACTED_IMPORT_FAILURE' }));
  process.exitCode = 1;
});
