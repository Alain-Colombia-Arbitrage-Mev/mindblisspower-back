import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_MELD_RECONCILIATION_PATH, runAppMeldScheduled } from '../src/app-meld-scheduled.mjs';
import { dispatchCore } from '../src/routing.mjs';

const env = { CORE_ENV: 'production', APP_MELD_PRODUCTION_ENABLED: 'true', API_BFF_SHARED_SECRET: 'synthetic-core-api-secret-32-characters' };
const now = 1_794_000_000_000;

test('the production cron uses a signed fixed API singleton call without member credentials', async () => {
  const disabled = () => assert.fail('closed job started a container');
  assert.deepEqual(await runAppMeldScheduled({ ...env, CORE_ENV: 'staging' }, disabled), { enabled: false });
  assert.deepEqual(await runAppMeldScheduled({ ...env, APP_MELD_PRODUCTION_ENABLED: true }, disabled), { enabled: false });
  await assert.rejects(runAppMeldScheduled({ ...env, API_BFF_SHARED_SECRET: '' }, disabled), /unavailable/);
  let calls = 0;
  const result = await runAppMeldScheduled(env, (service, instance) => {
    calls++;
    assert.equal(service, 'api');
    assert.equal(instance, 'singleton');
    return { fetch: async request => {
      const hash = value => createHash('sha256').update(value).digest('hex');
      assert.equal(request.url, `https://auth.core.internal${APP_MELD_RECONCILIATION_PATH}`);
      assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'manual');
      assert.equal(request.headers.has('cookie'), false);
      assert.equal(request.headers.has('authorization'), false);
      assert.equal(request.headers.has('origin'), false);
      const raw = await request.text();
      assert.equal(raw, '{}');
      assert.equal(request.headers.get('x-vp-auth-client-ip'), '127.0.0.1');
      assert.equal(request.headers.get('x-vp-auth-timestamp'), String(now / 1000));
      assert.equal(request.headers.get('x-vp-auth-signature'), createHmac('sha256', env.API_BFF_SHARED_SECRET)
        .update(['POST', APP_MELD_RECONCILIATION_PATH, String(now / 1000), '127.0.0.1', hash(''), hash(raw)].join('\n')).digest('hex'));
      return Response.json({ processed: 2 });
    } };
  }, now);
  assert.deepEqual(result, { enabled: true, processed: 2 });
  assert.equal(calls, 1);
});

test('a bad cron response is bounded and sanitized with no retries', async () => {
  for (const response of [new Response(null, { status: 302 }), new Response('sensitive error', { status: 503 }),
    Response.json({ processed: 0, subject: 'internal identifier' }), Response.json({ processed: 6 }),
    Response.json({ processed: '0' }), new Response(' '.repeat(256), { headers: { 'content-type': 'application/json' } })]) {
    let calls = 0;
    await assert.rejects(runAppMeldScheduled(env, () => ({ fetch: async () => { calls++; return response; } }), now), /unavailable/);
    assert.equal(calls, 1);
  }
});

test('the direct cron path and decoded aliases never reach a container through the gateway', async () => {
  const ready = { ...env, CORE_NETWORK_VERIFIED: 'true', CORE_SERVICES_ENABLED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true',
    AUTH_SERVICES_ENABLED: 'true', AUTH_CUTOVER_VERIFIED: 'true', CORE_REPORTS_ENABLED: 'true' };
  for (const path of [APP_MELD_RECONCILIATION_PATH, '/internal/app-meld-reconcile/', '/%2569nternal%252Fapp-meld-reconcile',
    '/internal//app-meld-reconcile/exec', '/internal/%61pp-meld-reconcile?attempt=external',
    '/other/%2e%2e%2finternal%5capp-meld-reconcile']) {
    for (const host of ['core.internal', 'auth.core.internal']) {
      for (const method of ['POST', 'GET']) {
        const response = await dispatchCore(new Request(`https://${host}${path}`, { method }), ready,
          () => assert.fail('gateway dispatched the reconciliation route'));
        assert.equal(response.status, 404);
      }
    }
  }
});
