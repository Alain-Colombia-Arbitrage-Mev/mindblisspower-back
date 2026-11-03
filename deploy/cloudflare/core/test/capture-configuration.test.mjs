import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captureConfiguration } from '../src/capture-configuration.mjs';

const enabled = { CORE_ENV: 'production', AUTH_SERVICES_ENABLED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true',
  AUTH_CUTOVER_VERIFIED: 'true', NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED: 'true',
  PAYMENTS_DATABASE_URL: 'postgres://reader.branch:private-password@db.example.invalid/app?sslmode=verify-full',
  PAYMENTS_SERVICE_TOKEN: 'private-service-token', CORE_SUPER_ADMIN_EMAILS: 'owner@example.invalid',
  PAYMENTS_ROOT_AFFILIATE_ID: '50793', AUTH_JWT_ISSUER: 'https://portal.example.invalid', AUTH_JWT_AUDIENCE: 'synthetic',
  NOWPAYMENTS_WEBHOOK_DATABASE_URL: 'postgres://capture.branch:private-password@db.example.invalid/app?sslmode=verify-full',
  NOWPAYMENTS_API_KEY: 'private-api-key', NOWPAYMENTS_IPN_SECRET: 'private-ipn-secret' };
const keys = ['requiredBindingsPresent', 'readWriteHostEqual', 'readWritePortEqual', 'readWriteDatabaseEqual',
  'readWriteUserDifferent', 'readTlsVerifyFull', 'writeTlsVerifyFull',
  'writerPresent', 'writerReaderHostEqual', 'writerReaderPortEqual', 'writerReaderDatabaseEqual',
  'writerReaderBranchSuffixSame', 'writerUsersDifferent', 'writerTlsVerifyFull',
  'branchSuffixSame', 'runtimeMappingValid', 'errorEnum', 'readerTarget'];
function safe(result) {
  assert.deepEqual(Object.keys(result), keys);
  assert.ok(Object.entries(result).every(([key, value]) => key === 'errorEnum' ? /^[A-Z_]+$/.test(value)
    : key === 'readerTarget' ? value === null || (typeof value === 'object' && Object.keys(value).join(',') === 'host,port,database') : typeof value === 'boolean'));
  assert.doesNotMatch(JSON.stringify(result), /postgres:|reader\.branch|capture\.branch|private-|example|50793/);
}

test('capture configuration RPC projection is gated and never reads secrets while disabled', () => {
  for (const key of ['NOWPAYMENTS_WEBHOOK_CAPTURE_ENABLED', 'AUTH_SERVICES_ENABLED', 'CORE_DATA_ACCESS_VERIFIED', 'AUTH_CUTOVER_VERIFIED']) {
    for (const flag of [undefined, 'false', 'TRUE', '1', true]) {
      const env = { ...enabled, [key]: flag };
      Object.defineProperty(env, 'NOWPAYMENTS_WEBHOOK_DATABASE_URL', { get() { assert.fail('disabled diagnostics read a credential'); } });
      const result = captureConfiguration(env); safe(result);
      assert.equal(result.errorEnum, 'DIAGNOSTICS_DISABLED'); assert.equal(result.runtimeMappingValid, false);
    }
  }
});

test('capture configuration RPC projects only comparison booleans and a static error enum without starting services', () => {
  const result = captureConfiguration(enabled); safe(result);
  assert.equal(result.errorEnum, 'NONE');
  assert.ok(Object.entries(result).filter(([key]) => !['errorEnum', 'readerTarget'].includes(key) && !key.startsWith('writer')).every(([, value]) => value === true));
  assert.deepEqual(result.readerTarget, { host: 'redacted', port: 5432, database: 'redacted' });
});

test('operator routing metadata exposes only a PlanetScale host, port and the exact approved database name', () => {
  const env = { ...enabled, PAYMENTS_DATABASE_URL: 'postgres://reader.branch:private-password@region-1.psdb.cloud:6432/mindbliss_curated_20261025?sslmode=verify-full',
    NOWPAYMENTS_WEBHOOK_DATABASE_URL: 'postgres://capture.branch:private-password@region-1.psdb.cloud:5432/mindbliss_curated_20261025?sslmode=verify-full' };
  const result = captureConfiguration(env); safe(result);
  assert.deepEqual(result.readerTarget, { host: 'region-1.psdb.cloud', port: 6432, database: 'mindbliss_curated_20261025' });
  assert.equal(result.readWritePortEqual, false); assert.equal(result.errorEnum, 'DATABASE_ISOLATION_INVALID');
  const hidden = captureConfiguration({ ...env, PAYMENTS_DATABASE_URL: 'postgres://reader.branch:private-password@psdb.cloud.evil.invalid:5432/private-database?sslmode=verify-full' });
  assert.deepEqual(hidden.readerTarget, { host: 'redacted', port: 5432, database: 'redacted' });
  assert.doesNotMatch(JSON.stringify(hidden), /evil|private-database|reader\.branch|private-password/);
});

test('capture configuration separates host, port, database, role, routing suffix and TLS mismatches', () => {
  for (const [url, key, error] of [
    ['postgres://capture.branch:private-password@other.invalid/app?sslmode=verify-full', 'readWriteHostEqual', 'DATABASE_ISOLATION_INVALID'],
    ['postgres://capture.branch:private-password@db.example.invalid:6432/app?sslmode=verify-full', 'readWritePortEqual', 'DATABASE_ISOLATION_INVALID'],
    ['postgres://capture.branch:private-password@db.example.invalid/other?sslmode=verify-full', 'readWriteDatabaseEqual', 'DATABASE_ISOLATION_INVALID'],
    [enabled.PAYMENTS_DATABASE_URL, 'readWriteUserDifferent', 'DATABASE_ISOLATION_INVALID'],
    ['postgres://capture:private-password@db.example.invalid/app?sslmode=verify-full', 'branchSuffixSame', 'NONE'],
    ['postgres://capture.other:private-password@db.example.invalid/app?sslmode=verify-full', 'branchSuffixSame', 'NONE'],
    ['postgres://capture.branch:private-password@db.example.invalid/app?sslmode=disable', 'writeTlsVerifyFull', 'INVALID_DATABASE_CONFIGURATION'],
  ]) {
    const result = captureConfiguration({ ...enabled, NOWPAYMENTS_WEBHOOK_DATABASE_URL: url }); safe(result);
    assert.equal(result[key], false); assert.equal(result.errorEnum, error);
  }
});

test('missing, malformed or unexpected configuration never leaks credential values or exception details', () => {
  for (const [change, error] of [
    [{ NOWPAYMENTS_API_KEY: '' }, 'CAPTURE_CONFIGURATION_INCOMPLETE'],
    [{ PAYMENTS_SERVICE_TOKEN: '' }, 'INCOMPLETE_BINDINGS'],
    [{ NOWPAYMENTS_WEBHOOK_DATABASE_URL: 'private-api-key' }, 'INVALID_DATABASE_CONFIGURATION'],
  ]) {
    const result = captureConfiguration({ ...enabled, ...change }); safe(result); assert.equal(result.errorEnum, error);
  }
  for (const message of ['private-api-key', '__proto__', 'constructor']) {
    const env = { ...enabled };
    Object.defineProperty(env, 'NOWPAYMENTS_API_KEY', { get() { throw new Error(message); } });
    const result = captureConfiguration(env); safe(result); assert.equal(result.errorEnum, 'UNEXPECTED_CONFIGURATION_ERROR');
  }
});

test('configuration diagnosis is a zero-argument private entrypoint RPC, never public HTTP or an arbitrary service probe', () => {
  const worker = readFileSync(new URL('../src/worker.mjs', import.meta.url), 'utf8');
  const probe = worker.split('export class PrivateCoreProbe extends WorkerEntrypoint {')[1].split('\nfor (const')[0];
  assert.match(probe, /captureConfiguration\(\)/); assert.match(probe, /arguments\.length !== 0/);
  assert.match(probe, /return captureConfiguration\(this\.env\)/);
  assert.doesNotMatch(probe, /fetch\(|request\.url|request\.headers|target/);
  const source = readFileSync(new URL('../src/capture-configuration.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fetch\(|console\.|getContainer|resolveFor|\.length/);
});

test('operational writer projection distinguishes port, branch, users and TLS without exposing any credential', () => {
  const operational = { ...enabled, NOWPAYMENTS_OPERATIONAL_ENABLED: 'true', NOWPAYMENTS_MEMBERSHIPS_ENABLED: 'true', NOWPAYMENTS_ENGINE_ENABLED: 'true',
    PAYMENTS_DATABASE_URL: 'postgres://reader.branch:private-password@region-1.psdb.cloud/app?sslmode=verify-full',
    NOWPAYMENTS_WEBHOOK_DATABASE_URL: 'postgres://capture.branch:private-password@region-1.psdb.cloud/app?sslmode=verify-full',
    NOWPAYMENTS_OPERATIONAL_DATABASE_URL: 'postgres://operations.branch:private-password@region-1.psdb.cloud/app?sslmode=verify-full' };
  const valid = captureConfiguration(operational); safe(valid);
  assert.equal(valid.runtimeMappingValid, true);
  for (const key of keys.filter(key => key.startsWith('writer'))) assert.equal(valid[key], true);
  for (const [url, key, expected] of [
    ['postgres://operations.branch:private-password@region-1.psdb.cloud:6432/app?sslmode=verify-full', 'writerReaderPortEqual', 'OPERATIONAL_DATABASE_ISOLATION_INVALID'],
    ['postgres://operations.other:private-password@region-1.psdb.cloud/app?sslmode=verify-full', 'writerReaderBranchSuffixSame', 'OPERATIONAL_DATABASE_ISOLATION_INVALID'],
    [operational.NOWPAYMENTS_WEBHOOK_DATABASE_URL, 'writerUsersDifferent', 'OPERATIONAL_DATABASE_ISOLATION_INVALID'],
    ['postgres://operations.branch:private-password@region-1.psdb.cloud/app?sslmode=disable', 'writerTlsVerifyFull', 'INVALID_DATABASE_CONFIGURATION'],
    ['', 'writerPresent', 'OPERATIONAL_CONFIGURATION_INCOMPLETE'],
  ]) {
    const result = captureConfiguration({ ...operational, NOWPAYMENTS_OPERATIONAL_DATABASE_URL: url }); safe(result);
    assert.equal(result[key], false); assert.equal(result.errorEnum, expected); assert.equal(result.runtimeMappingValid, false);
    assert.doesNotMatch(JSON.stringify(result), /operations\.|private-password|sslmode|\/app/);
  }
  const portOnly = captureConfiguration({ ...operational, NOWPAYMENTS_OPERATIONAL_DATABASE_URL: operational.NOWPAYMENTS_OPERATIONAL_DATABASE_URL.replace('/app?', ':6432/app?') });
  assert.equal(portOnly.writerReaderBranchSuffixSame, true); assert.equal(portOnly.writerReaderPortEqual, false);
  const multipart = { ...operational,
    PAYMENTS_DATABASE_URL: operational.PAYMENTS_DATABASE_URL.replace('reader.branch:', 'reader.region.branch:'),
    NOWPAYMENTS_WEBHOOK_DATABASE_URL: operational.NOWPAYMENTS_WEBHOOK_DATABASE_URL.replace('capture.branch:', 'capture.region.branch:'),
    NOWPAYMENTS_OPERATIONAL_DATABASE_URL: operational.NOWPAYMENTS_OPERATIONAL_DATABASE_URL.replace('operations.branch:', 'operations.other.branch:') };
  const mismatch = captureConfiguration(multipart); safe(mismatch);
  assert.equal(mismatch.branchSuffixSame, true); assert.equal(mismatch.writerReaderBranchSuffixSame, false);
  assert.equal(mismatch.errorEnum, 'OPERATIONAL_DATABASE_ISOLATION_INVALID');
  const matching = captureConfiguration({ ...multipart, NOWPAYMENTS_OPERATIONAL_DATABASE_URL: multipart.NOWPAYMENTS_OPERATIONAL_DATABASE_URL.replace('operations.other.branch:', 'operations.region.branch:') });
  assert.equal(matching.writerReaderBranchSuffixSame, true); assert.equal(matching.runtimeMappingValid, true);
});

test('capture-only diagnosis does not read a dormant operational credential', () => {
  const env = { ...enabled, NOWPAYMENTS_OPERATIONAL_ENABLED: 'false' };
  Object.defineProperty(env, 'NOWPAYMENTS_OPERATIONAL_DATABASE_URL', { get() { assert.fail('inactive writer read'); } });
  const result = captureConfiguration(env); safe(result);
  assert.equal(result.writerPresent, false); assert.equal(result.errorEnum, 'NONE');
});
