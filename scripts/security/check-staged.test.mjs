import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPublicationFile } from './check-staged.mjs';

test('excludes private runtime, database exports and local agent state', () => {
  for (const file of ['.env.local', 'app/.env.production', 'runtime/app.env', 'backups/result.json', 'keys/recovery.agekey', 'dump.dump.age', 'ruvector.db', 'agentdb.rvf', 'users.csv', 'sales.jsonl', '.claude-flow/state.json', '$OUT']) {
    assert.ok(inspectPublicationFile(file, Buffer.from('fixture')).includes('private_or_generated_file'), file);
  }
  assert.deepEqual(inspectPublicationFile('.env.example', Buffer.from('API_TOKEN=REPLACE_ME')), []);
  assert.deepEqual(inspectPublicationFile('src/model.ts', Buffer.from('export const version = 1;')), []);
});

test('identifies credential categories without returning secret values', () => {
  const samples = [
    ['stripe_key', 'sk_' + 'live_' + 'x'.repeat(30)],
    ['aws_access_key', 'AK' + 'IA' + 'A'.repeat(16)],
    ['github_token', 'gh' + 'p_' + 'a'.repeat(40)],
    ['provider_key', 'sk-' + 'proj-' + 'a'.repeat(30)],
    ['database_credential_url', 'postgres://app:' + 'unpublished-value' + '@cluster.pg.psdb.cloud/postgres'],
  ];
  for (const [category, value] of samples) {
    assert.deepEqual(inspectPublicationFile('src/fixture.js', Buffer.from(value)), [category]);
  }
  assert.deepEqual(inspectPublicationFile('fixture.test.js', Buffer.from('postgres://app:synthetic@db.example.invalid/test')), []);
});

test('requires explicit review of binary or unusually large files', () => {
  assert.ok(inspectPublicationFile('archive.data', Buffer.from([0, 1, 2])).includes('binary_file_requires_review'));
  assert.ok(inspectPublicationFile('large.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 'a')).includes('oversized_file_requires_review'));
});
