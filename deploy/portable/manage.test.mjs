import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { composeArgs, imageKeys, initialize, validateConfig } from './manage.mjs';

function fixture(environment = 'staging') {
  const services = {};
  for (const name of Object.keys(imageKeys)) services[name] = {
    image: `example/${name}@sha256:${'a'.repeat(64)}`, read_only: true, cap_drop: ['ALL'], environment: {},
  };
  const env = name => services[name].environment;
  const token = 'test-token-not-real-'.repeat(3);
  env('postgres').POSTGRES_USER = 'postgres';
  env('postgres').POSTGRES_DB = `mindbliss_${environment}`;
  env('postgres').POSTGRES_PASSWORD = 'test-db-password-not-real-'.repeat(2);
  services.postgres.volumes = [{ type: 'volume', source: 'pg', target: '/var/lib/postgresql/data' }];
  env('redis').REDIS_PASSWORD = 'test-cache-password-not-real-'.repeat(2);
  env('payments').REDIS_PASSWORD = env('redis').REDIS_PASSWORD;
  for (const name of ['client', 'admin', 'payments']) {
    Object.assign(env(name), { PAYMENTS_SERVICE_TOKEN: token, COGNITO_USER_POOL_ID: 'us-east-1_test', COGNITO_CLIENT_ID: 'test-client' });
  }
  for (const name of ['client', 'admin']) env(name).DEMO_LOGIN_ENABLED = '0';
  env('withdrawals').SERVICE_TOKEN = token;
  env('withdrawals').WITHDRAWALS_REQUIRE_BMP = 'true';
  env('payments').REQUIRE_VERIFIED_IDENTITY = 'true';
  env('payments').STRIPE_SECRET_KEY = environment === 'staging' ? 'sk_test_fake' : 'sk_live_fake';
  env('payments').STRIPE_WEBHOOK_SECRET = 'whsec_fake';
  env('engine').GRPC_TLS_REQUIRE_CLIENT_CERT = 'true';
  env('engine').BONUS_ENGINE_BINARY_CYCLE_ENABLED = 'false';
  env('api').ENGINE_MTLS_REQUIRED = 'true';
  env('api').BETTER_AUTH_SECRET = 'test-better-auth-secret-not-real-'.repeat(2);
  for (const name of ['api', 'engine', 'payments', 'withdrawals', 'client', 'backup']) {
    env(name)[name === 'client' ? 'MEMBER_DATABASE_URL' : 'DATABASE_URL'] = `postgres://${name}:test-db-password-not-real@postgres:5432/mindbliss_${environment}`;
  }
  for (const name of ['engine', 'payments', 'withdrawals']) env(name).ENV = environment;
  env('payments').PAYMENTS_COMPANY_ROOT_AFFILIATE_ID = '101';
  env('engine').BONUS_ENGINE_COMPANY_ROOT_AFFILIATE_ID = '101';
  env('payments').AWS_REGION = 'us-east-1';
  env('withdrawals').COGNITO_ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test';
  env('withdrawals').COGNITO_CLIENT_ID = 'test-client';
  env('withdrawals').BMP_BASE_URL = 'https://bmp.example.invalid';
  env('backup').BACKUP_AGE_RECIPIENT = 'fake-public-recipient';
  env('backup').BACKUP_S3_URI = 's3://example-bucket';
  return { name: `mindbliss-${environment}`, services };
}
test('staging and production fixtures pass policy', () => {
  for (const environment of ['staging', 'production']) assert.deepEqual(validateConfig(fixture(environment), environment), []);
});
const mutations = [
  ['published database', c => { c.services.postgres.ports = [{ published: '5432' }]; }],
  ['ephemeral database', c => { c.services.postgres.tmpfs = ['/var/lib/postgresql/data']; }],
  ['wrong project', c => { c.name = 'mindbliss-staging'; }],
  ['demo login', c => { c.services.admin.environment.DEMO_LOGIN_ENABLED = '1'; }],
  ['weak identity', c => { c.services.payments.environment.REQUIRE_VERIFIED_IDENTITY = 'false'; }],
  ['unprotected withdrawals', c => { c.services.withdrawals.environment.WITHDRAWALS_REQUIRE_BMP = 'false'; }],
  ['mutable image', c => { c.services.client.image = 'example/client:r1'; }],
  ['unresolved secrets', c => { c.services.payments.environment.STRIPE_SECRET_KEY = 'REPLACE_SECRET'; }],
  ['wrong Stripe environment', c => { c.services.payments.environment.STRIPE_SECRET_KEY = 'sk_test_fake'; }],
  ['missing external backup', c => { c.services.backup.environment.BACKUP_S3_URI = ''; }],
  ['mismatched token', c => { c.services.admin.environment.PAYMENTS_SERVICE_TOKEN = 'wrong'; }],
  ['cross-environment database', c => { c.services.engine.environment.DATABASE_URL = 'postgres://writer:fake@postgres/mindbliss_staging'; }],
  ['database superuser', c => { c.services.client.environment.MEMBER_DATABASE_URL = 'postgres://postgres:fake@postgres/mindbliss_production'; }],
  ['shared writer role', c => { c.services.client.environment.MEMBER_DATABASE_URL = c.services.payments.environment.DATABASE_URL; }],
  ['duplicate scheduler', c => { c.services.engine.environment.BONUS_ENGINE_BINARY_CYCLE_ENABLED = 'true'; }],
  ['host networking', c => { c.services.api.network_mode = 'host'; }],
  ['wrong root', c => { c.services.engine.environment.BONUS_ENGINE_COMPANY_ROOT_AFFILIATE_ID = '999'; }],
  ['wrong withdrawal identity', c => { c.services.withdrawals.environment.COGNITO_CLIENT_ID = 'other'; }],
  ['BMP path instead of origin', c => { c.services.withdrawals.environment.BMP_BASE_URL = 'https://bmp.example.invalid/api/v1/'; }],
  ['weak runtime password', c => { c.services.payments.environment.DATABASE_URL = 'postgres://payments:weak@postgres/mindbliss_production'; }],
];
for (const [name, mutate] of mutations) test(`rejects ${name}`, () => {
  const config = fixture('production'); mutate(config);
  assert.ok(validateConfig(config, 'production').length > 0);
});
test('initialization never overwrites an existing secret', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'mindbliss-infra-init-'));
  await initialize('staging', target);
  await writeFile(path.join(target, 'admin.env'), 'secret-preserved=yes\n');
  await assert.rejects(initialize('staging', target), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(target, 'admin.env'), 'utf8'), 'secret-preserved=yes\n');
});
test('actual Compose files resolve to different projects and volumes, with no public DB', async () => {
  const names = [];
  for (const environment of ['staging', 'production']) {
    const target = await mkdtemp(path.join(tmpdir(), `mindbliss-compose-${environment}-`));
    await initialize(environment, target);
    const result = spawnSync('docker', [...composeArgs(environment, path.join(target, 'project.env')), '--profile', 'edge', '--profile', 'ops', 'config', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    names.push(config.volumes['postgres-data'].name);
    assert.equal(config.name, `mindbliss-${environment}`);
    for (const name of ['postgres', 'redis', 'engine', 'api', 'payments', 'withdrawals']) assert.equal(config.services[name].ports, undefined);
    assert.equal(config.services.client.environment.DEMO_LOGIN_ENABLED, '0');
    assert.equal(config.services.payments.environment.REQUIRE_VERIFIED_IDENTITY, 'true');
    assert.ok(validateConfig(config, environment).length > 0, 'unfilled templates must not pass preflight');
  }
  assert.notEqual(names[0], names[1]);
});
