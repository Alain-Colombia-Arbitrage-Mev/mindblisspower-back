import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { restoreTarget, approvedToc, validateBaseline, pathStorageSql, restoreFailureCode } from './import-verified-candidate.mjs';
import { compareIntegrity, integritySql } from './post-import-integrity.mjs';

function env() {
  const app = new URL('postgresql://fixture_app@fixture.pg.psdb.cloud:6432/postgres?sslmode=verify-full');
  const restore = new URL(app);
  app.password = 'synthetic-only';
  restore.username = 'fixture_restore';
  restore.password = 'synthetic-only';
  return { DATABASE_URL: app.href, RESTORE_DATABASE_URL: restore.href };
}
function baseline() {
  return { versionNum: 180006, replica: false, canCreateSchema: true, canCreatePublic: true,
    appObjects: 0, customRoutines: 0, schemas: ['public', 'pscale_extensions'],
    extensions: ['btree_gist', 'citext', 'ltree', 'pgcrypto', 'unaccent', 'uuid-ossp'].map(name => ({ name, version: '1.0' })) };
}
const candidate = { summary: { extensions: baseline().extensions } };

test('restoration uses direct TLS and a separate role, with no secret argv', () => {
  const result = restoreTarget(env());
  assert.equal(result.pg.PGPORT, '5432');
  assert.equal(result.pg.PGSSLMODE, 'verify-full');
  assert.equal(result.pg.PGSSLROOTCERT, 'system');
  assert.match(result.pg.PGOPTIONS, /default_toast_compression=pglz/);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

for (const [name, change] of [
  ['missing restoration URL', e => { delete e.RESTORE_DATABASE_URL; }],
  ['different database', e => { e.RESTORE_DATABASE_URL = e.RESTORE_DATABASE_URL.replace('/postgres?', '/other?'); }],
  ['different host', e => { e.RESTORE_DATABASE_URL = e.RESTORE_DATABASE_URL.replace('fixture.pg', 'other.pg'); }],
  ['weak TLS', e => { e.RESTORE_DATABASE_URL = e.RESTORE_DATABASE_URL.replace('verify-full', 'require'); }],
  ['application role', e => { e.RESTORE_DATABASE_URL = e.DATABASE_URL; }],
  ['unreviewed option', e => { e.RESTORE_DATABASE_URL += '&options=unreviewed'; }],
]) test(`blocks ${name} without echoing credentials`, () => {
  const values = env(); change(values);
  assert.throws(() => restoreTarget(values), error => /^[A-Z_]+$/.test(error.message));
});

test('accepts only an empty compatible destination', () => {
  assert.doesNotThrow(() => validateBaseline(baseline(), candidate));
  for (const change of [
    { appObjects: 1 }, { customRoutines: 1 }, { canCreateSchema: false }, { canCreatePublic: false },
    { replica: true }, { versionNum: 170011 }, { schemas: ['public', 'mlm'] }, { extensions: [] },
  ]) assert.throws(() => validateBaseline({ ...baseline(), ...change }, candidate));
  const different = baseline(); different.extensions[0].version = '2.0';
  assert.throws(() => validateBaseline(different, candidate));
});

function toc() {
  const schemas = ['audit', 'auth', 'mlm', 'payments', 'staging', 'support'];
  const lines = ['1; 0 0 EXTENSION - pg_stat_statements -', '2; 0 0 COMMENT - EXTENSION pg_stat_statements -'];
  for (let i = 0; i < 61; i++) {
    lines.push(`${i + 10}; 0 0 TABLE ${schemas[i % schemas.length]} fixture_${i} fixture`);
    lines.push(`${i + 100}; 0 0 TABLE DATA ${schemas[i % schemas.length]} fixture_${i} fixture`);
  }
  return lines.join('\n');
}

test('defers only monitoring metadata while retaining every business data section', () => {
  const approved = approvedToc(toc());
  assert.deepEqual(approved.excluded, ['1', '2']);
  assert.equal(approved.tables, 61);
  assert.equal(approved.tableData, 61);
  assert.equal(approved.text.split('\n').length, 122);
});

test('blocks unexpected TOC changes and executable external objects', () => {
  for (const text of [toc().replace('TABLE mlm ', 'TABLE other '),
    toc() + '\n900; 0 0 FOREIGN SERVER unreviewed fixture',
    toc().replace('COMMENT - EXTENSION pg_stat_statements', 'COMMENT - EXTENSION other')]) {
    assert.throws(() => approvedToc(text));
  }
});

test('content verification checks all three datasets and every sequence without writes', () => {
  const source = { peopleHash: 'a'.repeat(32), packagesHash: 'b'.repeat(32), walletsHash: 'c'.repeat(32),
    sequences: Array.from({ length: 37 }, (_, i) => ({ name: `fixture_${i}`, lastValue: String(i) })) };
  assert.equal(compareIntegrity(source, structuredClone(source)).sequencesPreserved, 37);
  for (const key of ['peopleHash', 'packagesHash', 'walletsHash']) {
    assert.throws(() => compareIntegrity(source, { ...source, [key]: 'd'.repeat(32) }));
  }
  const changed = structuredClone(source); changed.sequences[0].lastValue = '999';
  assert.throws(() => compareIntegrity(source, changed));
  assert.match(integritySql, /^BEGIN READ ONLY;/);
  assert.match(integritySql, /ROLLBACK;$/);
  assert.doesNotMatch(integritySql, /\b(?:nextval|setval|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
});

test('the deep-path compatibility change alters storage, never position values', () => {
  assert.match(pathStorageSql, /^ALTER TABLE mlm\.affiliate ALTER COLUMN path SET COMPRESSION pglz;/);
  assert.doesNotMatch(pathStorageSql, /\b(?:UPDATE|DELETE|INSERT|DROP)\b/);
});

test('storage and provider errors expose only actionable constant codes', () => {
  assert.equal(restoreFailureCode('ERROR: could not write temporary file: No space left on device'), 'TARGET_STORAGE_EXHAUSTED_REVIEW_CAPACITY');
  assert.equal(restoreFailureCode('ERROR: disk quota exceeded'), 'TARGET_STORAGE_EXHAUSTED_REVIEW_CAPACITY');
  assert.equal(restoreFailureCode('ERROR: pg_readonly: invalid statement because cluster is read-only'), 'TARGET_READ_ONLY_REVIEW_PROVIDER');
  assert.equal(restoreFailureCode('ERROR: synthetic personal details must stay private'), 'DOCKER_COMMAND_FAILED_SEE_PRIVATE_LOG');
});

test('real-data entrypoints refuse CI and keep native restore atomic', () => {
  const importer = readFileSync(new URL('./import-verified-candidate.mjs', import.meta.url), 'utf8');
  const local = readFileSync(new URL('./restore-local-candidate.mjs', import.meta.url), 'utf8');
  assert.match(importer, /require\(!process\.env\.CI, 'REAL_DATA_IMPORT_FORBIDDEN_IN_CI'\)/);
  assert.match(local, /if \(process\.env\.CI\) throw new Error\('REAL_DATA_RESTORE_FORBIDDEN_IN_CI'\)/);
  assert.match(importer, /--single-transaction --exit-on-error --use-list/);
  assert.doesNotMatch(importer, /--clean|--disable-triggers/);
});
