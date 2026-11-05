import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchCore, dispatchContainerOutbound } from '../src/routing.mjs';

const env = { CORE_ENV: 'production', CORE_AUTH_TRACE_ENABLED: 'true', CORE_OBSERVABILITY_ENABLED: 'false', CORE_REPORTS_ENABLED: 'true',
  CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_SERVICES_ENABLED: 'true', AUTH_CUTOVER_VERIFIED: 'true' };
const path = '/api/admin/auth/otp-diagnostic';
const headers = { 'content-type': 'application/json', origin: 'https://admin.example.test', cookie: 'synthetic-native-cookie',
  'x-vp-auth-client-ip': '192.0.2.25', 'x-vp-auth-timestamp': '1793793600', 'x-vp-auth-signature': 'a'.repeat(64) };
const request = (url = `https://auth.core.internal${path}`, init = {}) => new Request(url, {
  method: 'POST', headers, body: '{"email":"fixture@example.test"}', ...init,
});

test('exact signed native-session admin diagnostic is independently report/auth gated and forwarded once unchanged', async () => {
  let calls = 0;
  const response = await dispatchCore(request(), env, (service, singleton) => ({ async fetch(forwarded) {
    calls++; assert.equal(service, 'api'); assert.equal(singleton, 'singleton');
    assert.equal(forwarded.url, `https://auth.core.internal${path}`);
    assert.equal(forwarded.headers.get('x-vp-auth-signature'), headers['x-vp-auth-signature']);
    assert.equal(forwarded.headers.get('cookie'), headers.cookie);
    assert.equal(await forwarded.text(), '{"email":"fixture@example.test"}');
    return Response.json({ diagnosis: 'ready' });
  } }));
  assert.equal(response.status, 200); assert.equal(calls, 1);
});

test('aliases, verbs, selectors, missing proof, impersonation and oversized diagnostic bodies never dispatch', async () => {
  const deny = () => assert.fail('forbidden diagnostic resolution');
  for (const url of [`https://auth.core.internal${path}/`, `https://auth.core.internal${path}/extra`, `https://auth.core.internal${path}?email=x`,
    `https://auth.core.internal/api/admin/auth/%6ftp-diagnostic`, `https://payments.core.internal${path}`, `http://auth.core.internal${path}`]) {
    assert.ok((await dispatchCore(request(url), env, deny)).status >= 400, url);
  }
  for (const key of ['cookie', 'origin', 'x-vp-auth-signature', 'x-vp-auth-timestamp', 'x-vp-auth-client-ip']) {
    const changed = { ...headers }; delete changed[key];
    assert.ok((await dispatchCore(request(undefined, { headers: changed }), env, deny)).status >= 400, key);
  }
  assert.ok((await dispatchCore(request(undefined, { method: 'GET', body: undefined }), env, deny)).status >= 400);
  assert.ok((await dispatchCore(request(undefined, { headers: { ...headers, 'x-vp-act-as': 'fixture@example.test' } }), env, deny)).status >= 400);
  assert.equal((await dispatchCore(request(undefined, { body: JSON.stringify({ email: 'x'.repeat(3000) }) }), env, deny)).status, 413);
  for (const flag of ['CORE_REPORTS_ENABLED', 'CORE_DATA_ACCESS_VERIFIED', 'AUTH_SERVICES_ENABLED', 'AUTH_CUTOVER_VERIFIED']) {
    assert.ok((await dispatchCore(request(), { ...env, [flag]: 'false', CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' }, deny)).status >= 400, flag);
  }
});

test('only API egress can write exact trace/probe; delivery/read/prune and private readiness never enter a generic gateway', async () => {
  let calls = 0;
  const resolve = () => ({ fetch: async () => { calls++; return Response.json({ recorded: true }); } });
  for (const name of ['trace', 'probe']) assert.equal((await dispatchContainerOutbound('api', new Request(`https://observability.core.internal/v1/${name}`, { method: 'POST' }), env, resolve)).status, 200);
  assert.equal(calls, 2);
  for (const name of ['delivery', 'trace-read', 'prune-traces', 'refresh', 'snapshot']) {
    assert.equal((await dispatchContainerOutbound('api', new Request(`https://observability.core.internal/v1/${name}`, { method: 'POST' }), env, () => assert.fail('unavailable capability'))).status, 404);
  }
  assert.equal((await dispatchContainerOutbound('payments', new Request('https://observability.core.internal/v1/trace', { method: 'POST' }), env, resolve)).status, 404);
  assert.ok((await dispatchCore(request('https://auth.core.internal/internal/otp-trace-readiness'), env, () => assert.fail('private-only readiness'))).status >= 400);
});
