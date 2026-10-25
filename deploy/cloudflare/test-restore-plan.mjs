import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

assert.ok(process.argv.includes('--synthetic-docker'), 'Only --synthetic-docker is accepted; no external DB settings are read');
const directory = path.dirname(fileURLToPath(import.meta.url));
const id = randomBytes(6).toString('hex');
const network = `mindbliss-psrestore-${id}`;
const sourceName = `${network}-source`;
const targetName = `${network}-db`;
const output = path.join(directory, 'artifacts', network);
const tools = 'mindbliss/backup:pg18-20261025';
const tools17 = 'mindbliss/backup:infra-20261023';
const sourceImage = 'postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27';
const targetImage = 'postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888';
const password = randomBytes(24).toString('hex');
const created = [];
let createdNetwork = false;
function docker(args, env = {}, expected = 0) {
  const result = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return result.stdout.trim();
}
function query(container, database, sql) {
  return docker(['exec', container, 'psql', '-X', '-U', 'postgres', '-d', database, '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
}
async function start(name, image, major) {
  docker(['run', '-d', '--name', name, '--network', network, '--tmpfs', major === 18 ? '/var/lib/postgresql' : '/var/lib/postgresql/data', '-e', 'POSTGRES_PASSWORD', image], { POSTGRES_PASSWORD: password });
  created.push(name);
  for (let i = 0; i < 90; i++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.fail('synthetic database did not start');
}
const commonRun = () => ['run', '--rm', '--network', network, '--read-only', '--tmpfs', '/work:uid=70,gid=70,mode=0700', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];
let manifest;
function plan(envOverrides = {}, expected = 0, policyFile = 'policy.json') {
  const env = {
    RESTORE_DATABASE_URL: `postgres://restore_operator:${password}@${targetName}:5432/postgres?sslmode=disable`,
    RESTORE_EXPECTED_DATABASE: 'postgres', RESTORE_CREDENTIAL_ROTATION_CONFIRMED: 'yes',
    SOURCE_DATABASE_READY_CONFIRMED: 'yes', SOURCE_REFERENCE: 'synthetic:postgres17', SOURCE_DATABASE_NAME: 'source_fixture', ...envOverrides,
  };
  const args = [...commonRun(), '-v', `${output}:/input:ro`, '-v', `${path.join(directory, 'restore_plan.py')}:/tools/restore_plan.py:ro`];
  for (const key of Object.keys(env)) args.push('-e', key);
  args.push('--entrypoint', 'python3', tools, '-B', '/tools/restore_plan.py', '--synthetic-docker', '--policy', `/input/${policyFile}`, '--manifest', `/input/${manifest}`);
  return JSON.parse(docker(args, env, expected));
}
function restore(database, expected = 0) {
  const env = { PGHOST: targetName, PGPORT: '5432', PGDATABASE: database, PGUSER: 'restore_operator', PGPASSWORD: password, PGSSLMODE: 'disable' };
  const args = [...commonRun(), '-v', `${output}:/input:ro`];
  for (const key of Object.keys(env)) args.push('-e', key);
  args.push('--entrypoint', 'sh', tools, '-ec', 'set -o pipefail; age -d -i /input/drill.agekey "$1" | pg_restore -w --dbname="$PGDATABASE" --single-transaction --exit-on-error --use-list=/input/approved.list --no-owner --no-acl --no-comments --no-security-labels --no-publications --no-subscriptions --no-tablespaces', '--', `/input/${record.database.file}`);
  docker(args, env, expected);
}
let record;
try {
  await mkdir(output, { recursive: true });
  const policy = { schemas: ['mlm'], extensionVersions: { ltree: { source: '1.2', target: '1.3' } } };
  await writeFile(path.join(output, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
  await writeFile(path.join(output, 'unapproved.json'), JSON.stringify({ schemas: ['mlm'] }), { mode: 0o600 });
  await writeFile(path.join(output, 'approved.filter'), 'include schema mlm\n', { mode: 0o600 });
  docker(['network', 'create', '--internal', network]); createdNetwork = true;
  await start(sourceName, sourceImage, 17);
  await start(targetName, targetImage, 18);
  query(sourceName, 'postgres', 'CREATE DATABASE source_fixture TEMPLATE template0');
  query(sourceName, 'source_fixture', `CREATE EXTENSION ltree VERSION '1.2'; CREATE SCHEMA mlm; CREATE SCHEMA excluded_fixture;
    CREATE TABLE mlm.affiliate(id bigint PRIMARY KEY,parent_id bigint REFERENCES mlm.affiliate(id),position text,unavailable boolean NOT NULL,path public.ltree NOT NULL);
    CREATE INDEX affiliate_path_gist ON mlm.affiliate USING gist(path);
    INSERT INTO mlm.affiliate VALUES(1,NULL,NULL,false,'1'),(2,1,'L',true,'1.2'),(3,2,'R',false,'1.2.3');
    CREATE TABLE mlm.sales(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,amount numeric(12,2) NOT NULL);
    INSERT INTO mlm.sales(amount) VALUES(99.50),(50.25);
    ALTER TABLE mlm.sales ENABLE ROW LEVEL SECURITY;
    CREATE POLICY sales_read ON mlm.sales FOR SELECT TO PUBLIC USING(true);
    CREATE TABLE excluded_fixture.not_approved(id bigint PRIMARY KEY); INSERT INTO excluded_fixture.not_approved VALUES(1);`);
  query(targetName, 'postgres', `CREATE ROLE restore_operator LOGIN PASSWORD '${password}';
    GRANT CONNECT,CREATE ON DATABASE postgres TO restore_operator; GRANT USAGE,CREATE ON SCHEMA public TO restore_operator;
    CREATE SCHEMA pscale_extensions; CREATE EXTENSION pgcrypto WITH SCHEMA pscale_extensions;`);
  docker(['run', '--rm', '--network', 'none', '--user', '0', '-v', `${output}:/input`, '--entrypoint', 'sh', tools, '-ec', 'chown -R 70:70 /input']);
  docker(['run', '--rm', '--network', 'none', '-v', `${output}:/input`, '--entrypoint', 'age-keygen', tools, '-o', '/input/drill.agekey']);
  const recipient = docker(['run', '--rm', '--network', 'none', '-v', `${output}:/input:ro`, '--entrypoint', 'age-keygen', tools, '-y', '/input/drill.agekey']);
  const env = { DATABASE_URL: `postgres://postgres:${password}@${sourceName}:5432/source_fixture?sslmode=disable`,
    DEPLOY_ENV: 'drill', BACKUP_AGE_RECIPIENT: recipient, BACKUP_OUTPUT_DIR: '/input', BACKUP_INCLUDE_ROLES: '0' };
  const args = [...commonRun(), '-v', `${output}:/input`];
  for (const key of Object.keys(env)) args.push('-e', key);
  args.push(tools17, 'create');
  docker(args, env);
  manifest = (await readdir(output)).find(name => name.endsWith('.manifest.json'));
  assert.ok(manifest);
  record = JSON.parse(docker(['run', '--rm', '--network', 'none', '-v', `${output}:/input:ro`, '--entrypoint', 'cat', tools, `/input/${manifest}`]));
  assert.equal(plan({ RESTORE_CREDENTIAL_ROTATION_CONFIRMED: 'no' }, 2).code, 'CREDENTIAL_ROTATION_REQUIRED');
  assert.equal(plan({ SOURCE_DATABASE_READY_CONFIRMED: 'no' }, 2).code, 'SOURCE_READINESS_REQUIRED');
  assert.ok(plan({}, 2).blockers.includes('EXTENSION_INSTALLATION_REQUIRED:ltree'));
  query(targetName, 'postgres', 'CREATE EXTENSION ltree');
  assert.equal(query(sourceName, 'source_fixture', "SELECT extversion FROM pg_extension WHERE extname='ltree'"), '1.2');
  assert.equal(query(targetName, 'postgres', "SELECT extversion FROM pg_extension WHERE extname='ltree'"), '1.3');
  assert.ok(plan({}, 2, 'unapproved.json').blockers.includes('EXTENSION_VERSION_REVIEW_REQUIRED:ltree'));
  const reviewed = plan();
  assert.equal(reviewed.status, 'requires-manual-review');
  assert.equal(reviewed.writeCapable, false);
  assert.equal(reviewed.filter, 'include schema mlm\n');
  assert.equal(query(targetName, 'postgres', "SELECT count(*) FROM pg_namespace WHERE nspname='mlm'"), '0');
  assert.equal(query(targetName, 'postgres', "SELECT rolsuper FROM pg_roles WHERE rolname='restore_operator'"), 'f');
  // Native schema filtering omits SCHEMA TOC entries. Add their native IDs without rewriting SQL.
  const nativeTocs = [...commonRun(), '-v', `${output}:/input`, '--entrypoint', 'sh', tools, '-ec',
    'set -o pipefail; umask 077; age -d -i /input/drill.agekey "$1" | pg_restore --list > /input/full.toc; age -d -i /input/drill.agekey "$1" | pg_restore --list --strict-names --filter=/input/approved.filter > /input/selected.toc', '--', `/input/${record.database.file}`];
  docker(nativeTocs);
  const tocResult = JSON.parse(docker([...commonRun(), '-v', `${output}:/input:ro`, '-v', `${path.join(directory, 'restore_plan.py')}:/tools/restore_plan.py:ro`,
    '--entrypoint', 'python3', tools, '-B', '/tools/restore_plan.py', '--policy', '/input/policy.json', '--full-toc', '/input/full.toc', '--selected-toc', '/input/selected.toc']));
  assert.equal(tocResult.mode, 'toc-only');
  assert.ok(tocResult.toc.includes('SCHEMA - mlm'));
  assert.ok(!tocResult.toc.includes('excluded_fixture'));
  const written = spawnSync('docker', [...commonRun(), '-i', '-v', `${output}:/input`, '--entrypoint', 'sh', tools, '-ec', 'umask 077; cat > /input/approved.list'], {encoding:'utf8',input:tocResult.toc});
  assert.equal(written.status, 0, written.stderr);
  const providerFingerprint = "SELECT md5(string_agg(p.oid::text||':'||p.proname,',' ORDER BY p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='pscale_extensions'";
  const before = query(targetName, 'postgres', providerFingerprint);
  // Execution here is ONLY the independently generated native command in this disposable Docker network.
  restore('postgres');
  const rows = 'SELECT json_agg(a ORDER BY id) FROM (SELECT id,parent_id,position,unavailable,path::text FROM mlm.affiliate) a';
  assert.equal(query(targetName, 'postgres', rows), query(sourceName, 'source_fixture', rows));
  assert.equal(query(targetName, 'postgres', 'SELECT sum(amount) FROM mlm.sales'), '149.75');
  assert.equal(query(targetName, 'postgres', 'SELECT last_value FROM mlm.sales_id_seq'), query(sourceName, 'source_fixture', 'SELECT last_value FROM mlm.sales_id_seq'));
  assert.equal(query(targetName, 'postgres', "SELECT relrowsecurity FROM pg_class WHERE oid='mlm.sales'::regclass"), 't');
  assert.equal(query(targetName, 'postgres', "SELECT count(*) FROM pg_namespace WHERE nspname='excluded_fixture'"), '0');
  assert.equal(query(targetName, 'postgres', providerFingerprint), before);
  assert.ok(plan({}, 2).blockers.includes('TARGET_CONTAINS_UNREVIEWED_OBJECTS'));
  query(targetName, 'postgres', 'CREATE DATABASE drill_nonempty TEMPLATE template0');
  query(targetName, 'postgres', 'GRANT CONNECT,CREATE ON DATABASE drill_nonempty TO restore_operator');
  query(targetName, 'drill_nonempty', 'CREATE SCHEMA pgx_application');
  const nonempty = plan({ RESTORE_DATABASE_URL: `postgres://restore_operator:${password}@${targetName}:5432/drill_nonempty?sslmode=disable`, RESTORE_EXPECTED_DATABASE: 'drill_nonempty' }, 2);
  assert.ok(nonempty.blockers.includes('TARGET_CONTAINS_UNREVIEWED_OBJECTS'));
  query(targetName, 'postgres', 'CREATE DATABASE drill_rollback TEMPLATE template0');
  query(targetName, 'postgres', 'GRANT CONNECT,CREATE ON DATABASE drill_rollback TO restore_operator');
  restore('drill_rollback', 1); // Missing ltree must roll back even CREATE SCHEMA.
  assert.equal(query(targetName, 'drill_rollback', "SELECT count(*) FROM pg_namespace WHERE nspname='mlm'"), '0');
  console.log('PASS: read-only provider restore plan, rotation/readiness gates, extension approvals, restricted restore role, filtered PG17-to-PG18 restore, preserved provider objects/tree/amounts/sequences/RLS, populated-target refusal and atomic rollback. Synthetic Docker only.');
} finally {
  for (const name of created.reverse()) {
    assert.match(name, /^mindbliss-psrestore-[a-f0-9]{12}-(source|db)$/);
    docker(['rm', '-f', '-v', name]);
  }
  if (createdNetwork) { assert.match(network, /^mindbliss-psrestore-[a-f0-9]{12}$/); docker(['network', 'rm', network]); }
}
