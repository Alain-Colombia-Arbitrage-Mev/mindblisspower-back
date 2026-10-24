import test from 'node:test';
import assert from 'node:assert/strict';
import { appSpec } from './app-spec.mjs';

test('staging and production are separate apps with immutable runtime images', () => {
  const stage = appSpec('staging');
  const prod = appSpec('production');
  assert.notEqual(stage.name, prod.name);
  for (const spec of [stage, prod]) {
    for (const service of spec.services) {
      assert.match(service.image.digest, /^sha256:[a-f0-9]{64}$/);
      assert.equal(service.image.tag, undefined);
      assert.equal(service.volumes, undefined);
      assert.ok(service.envs.every(e => e.scope === 'RUN_TIME'));
      if (!['client', 'admin'].includes(service.name)) assert.equal(service.envs.find(e => e.key === 'DATABASE_URL').type, 'SECRET');
    }
  }
  assert.throws(() => appSpec('prod'), /staging or production/);
});
test('only client, admin, API and exact signed webhook have hostname-bound public ingress', () => {
  const spec = appSpec('production');
  const engine = spec.services.find(s => s.name === 'engine');
  const withdrawals = spec.services.find(s => s.name === 'withdrawals');
  assert.equal(engine.http_port, undefined);
  assert.equal(withdrawals.http_port, undefined);
  assert.deepEqual(engine.internal_ports, [9090, 50051]);
  assert.equal(engine.instance_count, 1);
  assert.ok(!spec.ingress.rules.some(r => ['engine', 'withdrawals'].includes(r.component.name)));
  assert.deepEqual(spec.ingress.rules.find(r => r.component.name === 'payments').match.path, { exact: '/api/webhooks/stripe' });
  assert.equal(spec.services.length, 6);
  assert.ok(spec.ingress.rules.every(rule => rule.match.authority.exact));
  assert.equal(spec.services.find(s => s.name === 'client').envs.find(e => e.key === 'MEMBER_DB_SSL').value, 'verify-full');
  assert.throws(() => appSpec('staging', undefined, { hosts: { client: 'same.example.com', admin: 'same.example.com', api: 'api.example.com' } }));
});
test('financial schedules and automatic messages remain off; identities remain verified', () => {
  const spec = appSpec('production');
  const env = name => Object.fromEntries(spec.services.find(s => s.name === name).envs.map(e => [e.key, e.value]));
  assert.equal(env('engine').BONUS_ENGINE_SCHEDULER_ENABLED, 'false');
  assert.equal(env('engine').GRPC_TLS_REQUIRE_CLIENT_CERT, 'true');
  assert.equal(env('payments').REQUIRE_VERIFIED_IDENTITY, 'true');
  assert.equal(env('payments').PAYMENTS_RECONCILE_INTERVAL_MIN, '0');
  assert.equal(env('withdrawals').WITHDRAWALS_REQUIRE_VERIFIED_IDENTITY, 'true');
  assert.equal(env('withdrawals').WITHDRAWALS_REQUIRE_BMP, 'true');
});
