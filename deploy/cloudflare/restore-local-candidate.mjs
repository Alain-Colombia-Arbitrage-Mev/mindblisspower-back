import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const expectedHash = 'b96f67ad91a69706f0c8c307293d0200fa4b90b74d5d958e0fa340787097d792';
const archiveName = 'vicionpower-local-historical-20261022.dump';
const source = 'D:/vicionpower/backups/local-historical-20261022';
const directory = path.dirname(fileURLToPath(import.meta.url));
const image = 'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
const tools = 'mindbliss/backup:pg18-20261025';
const id = randomBytes(6).toString('hex');
const name = `mindbliss-import-${id}-pg18`;
const volume = `${name}-data`;
const output = path.join(directory, 'artifacts', name);
const database = 'mindbliss_import_candidate';

async function docker(args, { input, env = {}, log } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', () => reject(new Error('DOCKER_PROCESS_FAILED')));
    child.on('close', async code => {
      try {
        if (log) await writeFile(path.join(output, log), Buffer.concat(stderr), { mode: 0o600 });
        if (code !== 0) return reject(new Error('DOCKER_COMMAND_FAILED'));
        resolve(Buffer.concat(stdout).toString('utf8').trim());
      } catch { reject(new Error('PRIVATE_LOG_WRITE_FAILED')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function query(sql) {
  return docker(['exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-d', database, '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, log: 'inspection.stderr.log' });
}

async function main() {
  if (process.env.CI) throw new Error('REAL_DATA_RESTORE_FORBIDDEN_IN_CI');
  if (process.argv.length !== 3 || process.argv[2] !== '--restore-local') throw new Error('LOCAL_RESTORE_FLAG_REQUIRED');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(source, archiveName))) hash.update(chunk);
  if (hash.digest('hex') !== expectedHash) throw new Error('ARCHIVE_CHECKSUM_MISMATCH');
  const manifest = JSON.parse(readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  if (manifest.database !== 'vicionpower' || manifest.created_on_bogota !== '2026-10-22' || manifest.postgresql_version !== '17.6') throw new Error('SOURCE_MANIFEST_CHANGED');
  const toc = await docker(['run', '--rm', '--network', 'none', '--read-only', '-v', `${source}:/input:ro`, '--entrypoint', 'pg_restore', tools, '--list', `/input/${archiveName}`]);
  const tables = toc.split('\n').map(line => line.match(/^\d+; \d+ \d+ TABLE (?!DATA )([a-z_][a-z0-9_]*) ([a-z_][a-z0-9_]*) /)).filter(Boolean).map(match => [match[1], match[2]]);
  if (tables.length !== 61 || new Set(tables.map(([schema]) => schema)).size !== 6) throw new Error('SOURCE_INVENTORY_CHANGED');
  await writeFile(path.join(output, 'full.toc'), toc, { mode: 0o600 });
  await writeFile(path.join(output, 'candidate.json'), JSON.stringify({ name, volume, database, image, archiveName, archiveSha256: expectedHash, output, status: 'created-not-restored' }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: 'archive-verified', name, volume, output, tables: tables.length }));
  await docker(['volume', 'create', '--label', 'mindbliss.restore=local-candidate', volume]);
  await docker(['run', '-d', '--name', name, '--network', 'none', '--restart', 'no', '--memory', '3g', '--cpus', '2', '--shm-size', '256m', '--security-opt', 'no-new-privileges:true', '--label', 'mindbliss.restore=local-candidate', '-v', `${volume}:/var/lib/postgresql`, '-v', `${source}:/input:ro`, '-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_DB=${database}`, image, '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'max_connections=20'], { env: { POSTGRES_PASSWORD: randomBytes(32).toString('hex') } });
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { await query('SELECT 1;'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  if (!ready) throw new Error('LOCAL_DATABASE_NOT_READY');
  console.log(JSON.stringify({ event: 'restoring-local-copy', name, remoteWrites: false }));
  const interval = setInterval(() => console.log(JSON.stringify({ event: 'local-restore-running', name })), 30000);
  try {
    await docker(['exec', name, 'pg_restore', '-U', 'postgres', '-d', database, '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', '--no-comments', '--no-security-labels', '--no-publications', '--no-subscriptions', '--no-tablespaces', `/input/${archiveName}`], { log: 'restore.stderr.log' });
  } finally { clearInterval(interval); }
  console.log(JSON.stringify({ event: 'local-restore-complete', name }));
  const summary = JSON.parse(await query(`BEGIN READ ONLY; SET LOCAL statement_timeout='300s';
    SELECT json_build_object('version',current_setting('server_version_num')::int,'sizeBytes',pg_database_size(current_database()),
      'extensions',(SELECT json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension),
      'people',(SELECT count(*) FROM mlm.person),'affiliates',(SELECT count(*) FROM mlm.affiliate),
      'movements',(SELECT count(*) FROM mlm.wallet_movement),'transactions',(SELECT count(*) FROM mlm.transaction),
      'purchaseIntents',(SELECT count(*) FROM payments.purchase_intent),'stripeEvents',(SELECT count(*) FROM payments.stripe_event),
      'treeHash',(SELECT md5(string_agg(md5(row_to_json(a)::text),'' ORDER BY a.id)) FROM mlm.affiliate a)); ROLLBACK;`));
  const counts = [];
  for (const [schema, table] of tables) {
    const count = Number(await query(`BEGIN READ ONLY; SET LOCAL statement_timeout='300s'; SELECT count(*) FROM "${schema}"."${table}"; ROLLBACK;`));
    if (!Number.isSafeInteger(count)) throw new Error('INVALID_TABLE_COUNT');
    counts.push({ schema, table, count });
  }
  const inventory = JSON.parse(await query(`BEGIN READ ONLY;
    SELECT json_build_object('columns',(SELECT json_agg(json_build_object('schema',table_schema,'table',table_name,'column',column_name,'type',data_type) ORDER BY table_schema,table_name,ordinal_position) FROM information_schema.columns WHERE table_schema IN ('audit','auth','mlm','payments','staging','support')),
      'invalidConstraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ('audit','auth','mlm','payments','staging','support') AND NOT c.convalidated),
      'invalidIndexes',(SELECT count(*) FROM pg_index WHERE NOT indisvalid),
      'schemaNames',(SELECT json_agg(nspname ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('audit','auth','mlm','payments','staging','support'))); ROLLBACK;`));
  const result = { name, volume, database, image, archiveName, archiveSha256: expectedHash, output, status: 'restored-local-only', summary, counts, inventory };
  await writeFile(path.join(output, 'candidate.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ event: 'candidate-verified', name, summary, tables: counts.length, invalidConstraints: inventory.invalidConstraints, invalidIndexes: inventory.invalidIndexes, remoteWrites: false }));
}

main().catch(error => {
  console.log(JSON.stringify({ event: 'blocked', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'REDACTED_FAILURE', name, output, remoteWrites: false }));
  process.exitCode = 1;
});
