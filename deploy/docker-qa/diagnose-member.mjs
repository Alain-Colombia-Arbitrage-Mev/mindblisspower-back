import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.argv.includes('--qa-docker'), 'Requires --qa-docker; no external target is accepted');
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, 'QA member diagnostic failed; check the configured read-only role');
  return result.stdout.trim();
}
const client = JSON.parse(docker(['inspect', 'mindbliss-qa-client-1']))[0];
assert.equal(client.Config.Labels['com.docker.compose.project'], 'mindbliss-qa');
const env = Object.fromEntries(client.Config.Env.map(entry => { const at = entry.indexOf('='); return [entry.slice(0, at), entry.slice(at + 1)]; }));
const target = new URL(env.MEMBER_DATABASE_URL);
assert.equal(target.hostname, 'postgres');
assert.equal(target.pathname, '/mindbliss_qa');
assert.equal(target.username, 'qa_member_read');
assert.equal(target.password, 'synthetic-qa-read-only');
const query = `SELECT current_database() AS database, current_user AS role,
  current_setting('transaction_read_only') AS read_only,
  (SELECT count(*)::int FROM mlm.person) AS persons,
  (SELECT count(*)::int FROM mlm.affiliate) AS affiliates,
  has_table_privilege(current_user,'mlm.affiliate','INSERT,UPDATE,DELETE') AS can_write,
  has_schema_privilege(current_user,'auth','USAGE') AS can_read_auth`;
// Use the actual memberDb module in a disposable test image sharing the client's
// network namespace. The production Next bundle does not expose npm modules.
const database = JSON.parse(docker(['run', '--rm', '--network', 'container:mindbliss-qa-client-1',
  '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user', 'node',
  '--env', `MEMBER_DATABASE_URL=${env.MEMBER_DATABASE_URL}`, '--env', 'MEMBER_DB_SSL=disable',
  '--entrypoint', 'node', 'mindbliss-qa-client-tests', '--input-type=module', '-e', `
import { memberDb } from './src/lib/member-db.js';
const sql = memberDb();
try {
  const [row] = await sql.unsafe(${JSON.stringify(query)});
  console.log(JSON.stringify(row));
} finally { await sql.end({ timeout: 2 }); }
`]));
assert.equal(database.database, 'mindbliss_qa');
assert.equal(database.role, 'qa_member_read');
assert.equal(database.read_only, 'on');
assert.equal(database.can_write, false);
assert.equal(database.can_read_auth, false);
const unauthenticated = [];
for (const endpoint of ['/api/member/tree', '/api/member/referral', '/api/payments/me']) {
  const response = await fetch(`http://127.0.0.1:3300${endpoint}`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 401);
  unauthenticated.push({ endpoint, status: response.status });
}
const report = { environment: 'synthetic-docker-qa', generatedAt: new Date().toISOString(), databaseProbe: 'actual-memberDb-module-in-client-network-namespace', database,
  unauthenticated, cognitoConfigured: Boolean(env.COGNITO_USER_POOL_ID && env.COGNITO_CLIENT_ID), authenticatedBffVerified: false };
const destination = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'reportes/member-data-diagnostics-20261024.json');
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Aggregate-only report: ${destination}`);
