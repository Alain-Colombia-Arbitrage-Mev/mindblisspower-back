import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privateReadiness, readinessProbeEnabled } from '../src/private-probe.mjs';

const enabled = { CORE_ENV: 'production', CORE_READINESS_PROBE_ENABLED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_CUTOVER_VERIFIED: 'true', CORE_NETWORK_VERIFIED: 'false', CORE_SERVICES_ENABLED: 'false' };

test('private readiness never instantiates a Container without its explicit probe/data/auth prerequisites', async () => {
  for (const key of ['CORE_READINESS_PROBE_ENABLED', 'CORE_DATA_ACCESS_VERIFIED', 'AUTH_CUTOVER_VERIFIED']) {
    for (const value of [undefined, 'false', 'TRUE', '1', true]) {
      const env = { ...enabled, [key]: value };
      assert.equal(readinessProbeEnabled(env), false);
      assert.deepEqual(await privateReadiness(env, () => assert.fail('container started')), { status: 503, ok: false, financialCertified: false, checks: {} });
    }
  }
  assert.equal(readinessProbeEnabled({ ...enabled, CORE_ENV: 'development' }), false);
});

test('private readiness checks only five fixed health targets on four singleton services, with no payload or header disclosure', async () => {
  const calls = [];
  const result = await privateReadiness({ ...enabled, PROBE_TARGET: 'https://attacker.invalid/financial-write' }, (service, instance) => ({ fetch: async request => {
    assert.equal(instance, 'singleton'); assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'manual');
    assert.equal(request.body, null); assert.equal([...request.headers].length, 0);
    calls.push([service, request.url]);
    return new Response('private-secret-health-payload', { headers: { 'x-private': 'private-secret-health-header' } });
  } }));
  assert.deepEqual(calls.sort(), [
    ['api', 'https://auth.core.internal/health'], ['engine', 'http://engine.core.internal/health'],
    ['engine', 'http://engine.core.internal/ready'], ['payments', 'https://payments.core.internal/health'],
    ['withdrawals', 'https://withdrawals.core.internal/health'],
  ].sort());
  assert.equal(result.status, 200); assert.equal(result.ok, true); assert.equal(result.financialCertified, false);
  assert.equal(Object.keys(result.checks).length, 5);
  assert.ok(Object.values(result.checks).every(value => value.status === 200 && value.ok));
  assert.doesNotMatch(JSON.stringify(result), /private-secret|attacker|financial-write/);
});

test('unavailable service, exception or redirect fails readiness without replay or error/body reflection', async () => {
  for (const behavior of [
    () => { throw new Error('provider-secret-database-uri'); },
    () => new Response('provider-secret-database-uri', { status: 500 }),
    () => new Response(null, { status: 302, headers: { location: 'https://attacker.invalid' } }),
  ]) {
    let paymentCalls = 0;
    const result = await privateReadiness(enabled, service => ({ fetch: async () => {
      if (service === 'payments') { paymentCalls++; return behavior(); }
      return new Response('ok');
    } }));
    assert.equal(paymentCalls, 1); assert.equal(result.status, 503); assert.equal(result.ok, false);
    assert.equal(result.financialCertified, false); assert.equal(result.checks.paymentsHealth.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /provider-secret|attacker/);
  }
});

test('probe has a fixed hard timeout even if a DO fetch ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  const pending = privateReadiness(enabled, () => ({ fetch: request => { signals.push(request.signal); return new Promise(() => {}); } }));
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  const result = await pending;
  assert.equal(result.status, 503); assert.equal(result.ok, false);
  assert.ok(signals.every(signal => signal.aborted));
  assert.ok(Object.values(result.checks).every(value => value.status === 503 && !value.ok));
});

test('named probe exposes only zero-argument readiness RPC, not an HTTP handler or caller-selected target', () => {
  const source = readFileSync(new URL('../src/worker.mjs', import.meta.url), 'utf8');
  const probe = source.split('export class PrivateCoreProbe extends WorkerEntrypoint {')[1].split('\nfor (const')[0];
  assert.match(probe, /readiness\(\)/); assert.match(probe, /arguments\.length !== 0/);
  assert.doesNotMatch(probe, /fetch\(|request\.url|request\.headers|target/);
});
