import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

assert.ok(process.argv.includes('--qa-docker'), 'Requires --qa-docker; never targets an external database');
const target = 'mindbliss-qa-postgres-1';
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.error?.message || 'QA database command failed');
  return result.stdout.trim();
}
const container = JSON.parse(docker(['inspect', target]))[0];
assert.equal(container.Config.Labels['com.docker.compose.project'], 'mindbliss-qa');
assert.ok(container.Config.Env.includes('POSTGRES_DB=mindbliss_qa'));
assert.ok(container.Config.Env.includes('POSTGRES_PASSWORD=synthetic-qa-only'));
const sql = readFileSync(new URL('./member-read.sql', import.meta.url), 'utf8');
docker(['exec', '-i', target, 'psql', '-X', '-q', '-U', 'postgres', '-d', 'mindbliss_qa', '-v', 'ON_ERROR_STOP=1'], sql);
const result = JSON.parse(docker(['exec', target, 'psql', '-X', '-q', '-U', 'qa_member_read', '-d', 'mindbliss_qa', '-At', '-v', 'ON_ERROR_STOP=1', '-c', `SELECT json_build_object(
  'readOnly',current_setting('transaction_read_only'),
  'canRead',has_table_privilege(current_user,'mlm.affiliate','SELECT'),
  'canWrite',has_table_privilege(current_user,'mlm.affiliate','INSERT,UPDATE,DELETE'),
  'canReadAuth',has_schema_privilege(current_user,'auth','USAGE'),
  'persons',(SELECT count(*) FROM mlm.person));`]));
assert.equal(result.readOnly, 'on');
assert.equal(result.canRead, true);
assert.equal(result.canWrite, false);
assert.equal(result.canReadAuth, false);
console.log('PASS: synthetic member role is read-only, can query the tree and has no auth-schema access. No containers recreated.');
