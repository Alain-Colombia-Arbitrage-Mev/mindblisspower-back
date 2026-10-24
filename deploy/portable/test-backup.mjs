import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { directory } from './manage.mjs';

if (!process.argv.includes('--synthetic-docker')) throw new Error('Requires --synthetic-docker; this test never accepts an external DATABASE_URL');
const id = randomBytes(6).toString('hex');
const network = `mindbliss-backup-drill-${id}`;
const container = `${network}-db`;
const output = path.join(directory, 'artifacts', network);
const vanilla = process.argv.includes('--vanilla-postgres');
const postgres = vanilla
  ? 'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27'
  : 'timescale/timescaledb@sha256:526d01720f91772948d1ddd90601bd3d96cfa7e6afa3f3af87d4f0638c6e4d1a';
const image = 'mindbliss/backup:infra-20261023';
const password = randomBytes(24).toString('hex');
let createdNetwork = false;
let createdContainer = false;
function docker(args, env = {}, expected = 0) {
  const result = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== expected) throw new Error(`Docker test step failed (${args[0]}). ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function query(database, sql) {
  return docker(['exec', container, 'psql', '-X', '-w', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);
}
function backupRun(env, command = 'create', shouldFail = false) {
  const args = ['run', '--rm', '--network', network, '--read-only', '--tmpfs', '/work:uid=70,gid=70,mode=0700', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '-v', `${output}:/backups`];
  for (const key of Object.keys(env)) args.push('-e', key);
  args.push(image, command);
  const result = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, ...env } });
  if (shouldFail) assert.notEqual(result.status, 0, 'unsafe operation unexpectedly succeeded');
  else assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
try {
  await mkdir(output, { recursive: true });
  docker(['network', 'create', '--internal', network]); createdNetwork = true;
  docker(['run', '-d', '--name', container, '--network', network, '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_PASSWORD', postgres], { POSTGRES_PASSWORD: password });
  createdContainer = true;
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    // The entrypoint temporarily starts a socket-only server for init scripts.
    // Wait for the final TCP listener, not that transient initialization server.
    const result = spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { encoding: 'utf8' });
    if (result.status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, 'synthetic Postgres did not start');
  query('postgres', 'CREATE DATABASE drill_source TEMPLATE template0');
  query('drill_source', `${vanilla ? '' : 'CREATE EXTENSION timescaledb;'} CREATE SCHEMA mlm;
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,parent_id bigint REFERENCES mlm.affiliate(id),side text,unavailable boolean NOT NULL);
    INSERT INTO mlm.affiliate VALUES(101,NULL,NULL,false),(102,101,'L',true),(103,101,'R',false),(104,102,'R',false);
    CREATE TABLE mlm.sales(time timestamptz NOT NULL,amount numeric NOT NULL);
    ${vanilla ? '' : "SELECT create_hypertable('mlm.sales',by_range('time'));"}
    INSERT INTO mlm.sales VALUES('2026-10-23T10:00:00Z',99.50),('2026-10-23T11:00:00Z',50.25);`);
  // Only this newly created, synthetic directory is given to a helper container.
  docker(['run', '--rm', '--network', 'none', '--user', '0', '-v', `${output}:/backups`, '--entrypoint', 'sh', image, '-ec', 'chown 70:70 /backups']);
  docker(['run', '--rm', '--network', 'none', '-v', `${output}:/backups`, '--entrypoint', 'age-keygen', image, '-o', '/backups/drill.agekey']);
  const recipient = docker(['run', '--rm', '--network', 'none', '-v', `${output}:/backups:ro`, '--entrypoint', 'age-keygen', image, '-y', '/backups/drill.agekey']);
  const source = `postgres://postgres:${password}@${container}:5432/drill_source?sslmode=disable`;
  const common = { DATABASE_URL: source, DEPLOY_ENV: 'drill', BACKUP_AGE_RECIPIENT: recipient, BACKUP_OUTPUT_DIR: '/backups', BACKUP_INCLUDE_ROLES: '1' };
  backupRun({ ...common, BACKUP_AGE_RECIPIENT: '' }, 'create', true);
  assert.equal((await readdir(output)).filter(name => name.endsWith('.manifest.json')).length, 0);
  backupRun(common);
  const files = await readdir(output);
  assert.ok(!files.some(name => name.endsWith('.dump') || name.endsWith('.sql')), 'plaintext backup escaped the container');
  const manifest = files.find(name => name.endsWith('.manifest.json'));
  assert.ok(manifest);
  // The Linux runner is not UID 70; keep the backup files private to their owner.
  const record = JSON.parse(docker(['run', '--rm', '--network', 'none', '--read-only',
    '-v', `${output}:/backups:ro`, '--entrypoint', 'cat', image, `/backups/${manifest}`]));
  assert.ok(record.roles?.sha256);
  assert.equal(record.extensions.some(e => e.name === 'timescaledb'), !vanilla);
  query('postgres', 'CREATE DATABASE drill_restore_ok TEMPLATE template0');
  const restore = { DATABASE_URL: source.replace('/drill_source?', '/drill_restore_ok?'), BACKUP_MANIFEST: `/backups/${manifest}`, AGE_IDENTITY_FILE: '/backups/drill.agekey', RESTORE_TARGET_NAME: 'drill_restore_ok', RESTORE_CONFIRM: 'drill_restore_ok' };
  backupRun({ ...restore, RESTORE_CONFIRM: 'wrong' }, 'restore', true);
  backupRun(restore, 'restore');
  const rows = "SELECT json_agg(a ORDER BY id) FROM mlm.affiliate a";
  assert.equal(query('drill_restore_ok', rows), query('drill_source', rows));
  assert.equal(query('drill_restore_ok', 'SELECT sum(amount) FROM mlm.sales'), '149.75');
  if (!vanilla) assert.equal(query('drill_restore_ok', "SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_schema='mlm'"), '1');
  backupRun(restore, 'restore', true); // Never overwrite a populated target.
  backupRun({ ...restore, DATABASE_URL: source, RESTORE_TARGET_NAME: 'drill_source', RESTORE_CONFIRM: 'drill_source' }, 'restore', true);
  query('postgres', 'CREATE DATABASE drill_restore_corrupt TEMPLATE template0');
  assert.match(record.database.file, /^drill-[a-zA-Z0-9._-]+\.dump\.age$/);
  docker(['run', '--rm', '--network', 'none', '--read-only', '-v', `${output}:/backups`,
    '--entrypoint', 'sh', image, '-ec', 'printf "%s" corrupt >> "$1"', '--', `/backups/${record.database.file}`]);
  const result = backupRun({ ...restore, DATABASE_URL: source.replace('/drill_source?', '/drill_restore_corrupt?'), RESTORE_TARGET_NAME: 'drill_restore_corrupt', RESTORE_CONFIRM: 'drill_restore_corrupt' }, 'restore', true);
  assert.match(result.stderr, /Checksum mismatch/);
  assert.equal(query('drill_restore_corrupt', "SELECT count(*) FROM pg_namespace WHERE nspname='mlm'"), '0');
  console.log(`PASS: encrypted backup + roles archive + ${vanilla ? 'native PostgreSQL' : 'Timescale'} restore + preserved binary positions + refusal of missing encryption, wrong confirmation, populated/non-restore databases and corrupt ciphertext.`);
  console.log(`Synthetic evidence only: ${output} (ciphertext intentionally corrupted by final negative test).`);
} finally {
  // Names are generated here, never read from user settings or existing stacks.
  assert.match(container, /^mindbliss-backup-drill-[a-f0-9]{12}-db$/);
  assert.match(network, /^mindbliss-backup-drill-[a-f0-9]{12}$/);
  if (createdContainer) docker(['rm', '-f', '-v', container]);
  if (createdNetwork) docker(['network', 'rm', network]);
}
