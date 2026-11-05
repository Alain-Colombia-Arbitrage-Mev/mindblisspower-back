import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { handleOperationalStorage, signedObservationRequest, unknownOperationalSnapshot } from '../src/observability-store.mjs';
import { privateOperationalSnapshot, runOperationalMonitoring } from '../src/observability-monitor.mjs';
import { dispatchContainerOutbound, dispatchCore } from '../src/routing.mjs';

const now = Date.parse('2026-11-02T12:00:00.000Z');
const env = { CORE_ENV: 'production', CORE_OBSERVABILITY_ENABLED: 'true', API_BFF_SHARED_SECRET: 'synthetic-observation-secret-at-least-32-characters',
  AUTH_SERVICES_ENABLED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_CUTOVER_VERIFIED: 'true' };
const iso = time => new Date(time).toISOString();
function storage() {
  const data = new Map(); let lock = Promise.resolve();
  const make = map => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)); },
    delete: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key); },
    list: async ({ prefix, end, limit }) => new Map([...map].filter(([key]) => key.startsWith(prefix) && key < end).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
  });
  const store = { ...make(data), data, transaction: callback => {
    const task = lock.then(async () => {
      const copy = structuredClone(data); const result = await callback(make(copy));
      data.clear(); for (const entry of copy) data.set(...entry); return result;
    });
    lock = task.catch(() => {}); return task;
  } }; return store;
}
const event = (patch = {}) => ({ version: 1, id: randomUUID(), occurred_at: iso(now), provider: 'resend', outcome: 'accepted', http_status: 200, ...patch });
const sources = (patch = {}) => ({ observed_at: iso(now), email: [{ provider: 'resend', period: 'provider_month',
  window_start: null, window_end: iso(now + 86400_000), limit: 50_000, used: 40_000, coverage: 'provider', status: 'warn' }],
infrastructure: ['workers', 'planetscale'].map(service => ({ service, status: 'ok', observed_at: iso(now), metrics: [service === 'workers'
  ? { name: 'mindbliss-core-production.cpu_p99_ms', unit: 'milliseconds', value: 5, threshold: 40, source: 'provider' }
  : { name: 'cpu_percent', unit: 'percent', value: 5, threshold: 80, source: 'provider' }] })), ...patch });
const send = (store, path, value, time = now) => handleOperationalStorage(signedObservationRequest(env, path, value, time), store, env, time);
const read = async (store, time = now) => (await send(store, '/v1/snapshot', undefined, time)).json();

test('disabled monitor never touches durable storage or creates a Container', async () => {
  const disabled = { ...env, CORE_OBSERVABILITY_ENABLED: 'false' };
  assert.equal((await handleOperationalStorage(new Request('https://observability.core.internal/v1/snapshot'), null, disabled, now)).status, 503);
  await runOperationalMonitoring(disabled, () => assert.fail('container selected'));
  assert.deepEqual(await privateOperationalSnapshot(disabled, () => assert.fail('container selected'), now), unknownOperationalSnapshot(false, now));
});

test('terminal observations are idempotent across concurrent duplicate requests, provider choice and restarts', async () => {
  const store = storage(), value = event();
  const results = await Promise.all(Array.from({ length: 8 }, () => send(store, '/v1/email', value)));
  assert.ok(results.every(result => result.status === 200));
  // ID remains the idempotency key even if another signed caller changes fields.
  await send(store, '/v1/email', { ...value, provider: 'cloudflare', occurred_at: iso(now + 1000) });
  const snapshot = await read(store);
  assert.equal(snapshot.email.find(row => row.provider === 'resend').accepted, 1);
  assert.equal(snapshot.email.find(row => row.provider === 'cloudflare').accepted, 0);
  assert.equal(snapshot.email[0].delivered, null); assert.equal(snapshot.email[0].used, null);
  assert.equal(snapshot.email[0].limit, 50_000); assert.equal(snapshot.email[0].limit_source, 'administrator');
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-observation-secret/);
});

test('recipient, OTP, content, forged timestamps and malformed observations never enter storage', async () => {
  const store = storage();
  for (const value of [event({ email: 'owner@example.test' }), event({ otp: '123456' }), event({ provider: 'unknown' }),
    event({ outcome: 'delivered' }), event({ id: 'invalid' }), event({ http_status: 999 }), event({ occurred_at: iso(now - 601_000) })]) {
    assert.equal((await send(store, '/v1/email', value)).status, 400);
  }
  assert.equal(store.data.size, 0);
});

test('HMAC method/path/body binding rejects mutations, stale envelope and browser cookies', async () => {
  const store = storage(), signed = signedObservationRequest(env, '/v1/email', event(), now);
  const headers = new Headers(signed.headers);
  assert.equal((await handleOperationalStorage(new Request(signed.url, { method: 'POST', headers, body: '{}' }), store, env, now)).status, 401);
  headers.set('cookie', 'session=must-not-reach-storage');
  assert.equal((await handleOperationalStorage(new Request(signed.url, { method: 'POST', headers, body: '{}' }), store, env, now)).status, 404);
  assert.equal((await handleOperationalStorage(signedObservationRequest(env, '/v1/email', event(), now - 61_000), store, env, now)).status, 401);
  assert.equal(store.data.size, 0);
});

test('storage ingress accepts the app emitter exact independent HMAC contract', async () => {
  const store = storage(), raw = JSON.stringify(event()); const timestamp = String(now / 1000);
  const signature = createHmac('sha256', env.API_BFF_SHARED_SECRET).update(['POST', '/v1/email', timestamp,
    createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
  const result = await handleOperationalStorage(new Request('https://observability.core.internal/v1/email', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vp-observation-timestamp': timestamp, 'x-vp-observation-signature': signature }, body: raw }), store, env, now);
  assert.deepEqual(await result.json(), { recorded: true });
});

test('quota snapshots distinguish true provider use from partial counters and unknown Cloudflare use', async () => {
  const store = storage(); await send(store, '/v1/refresh', sources());
  await send(store, '/v1/email', event());
  const snapshot = await read(store); const row = snapshot.email.find(row => row.provider === 'resend');
  assert.equal(row.used, 40_000); assert.equal(row.accepted, 1); assert.equal(row.coverage, 'provider');
  assert.equal(row.period, 'provider_month'); assert.equal(row.local_period, 'calendar_month');
  const cloudflare = snapshot.email.find(row => row.provider === 'cloudflare');
  assert.equal(cloudflare.used, null); assert.equal(cloudflare.limit, 200); assert.equal(cloudflare.period, 'day');
  assert.equal(cloudflare.status, 'unknown'); assert.equal(snapshot.overall, 'warn');
  assert.ok(snapshot.alerts.some(row => row.key === 'resend:quota'));
});

test('daily local counters use UTC and do not inherit a monthly count', async () => {
  const store = storage(); await send(store, '/v1/email', event());
  const later = now + 86400_000;
  await send(store, '/v1/email', event({ occurred_at: iso(later) }), later);
  const fresh = sources({ observed_at: iso(later), email: sources().email.concat({ ...sources().email[0], period: 'day', limit: null, used: 2, window_end: iso(later + 86400_000) }),
    infrastructure: sources().infrastructure.map(row => ({ ...row, observed_at: iso(later) })) });
  await send(store, '/v1/refresh', fresh, later);
  const snapshot = await read(store, later);
  assert.equal(snapshot.email.find(row => row.provider === 'resend' && row.period === 'provider_month').accepted, 2);
  assert.equal(snapshot.email.find(row => row.provider === 'resend' && row.period === 'day').accepted, 1);
});

test('429 remains visible after a later success in the same bucket', async () => {
  const store = storage(); await send(store, '/v1/email', event({ outcome: 'rejected', http_status: 429 }));
  await send(store, '/v1/email', event());
  const snapshot = await read(store);
  assert.equal(snapshot.alerts.find(row => row.key === 'email:delivery_failure').severity, 'critical');
});

test('local Cloudflare volume warns at160/190 without asserting actual provider usage or delivery', async () => {
  const store = storage();
  for (let index = 0; index < 160; index++) await send(store, '/v1/email', event({ provider: 'cloudflare' }));
  let snapshot = await read(store);
  assert.equal(snapshot.alerts.find(row => row.key === 'cloudflare:quota').severity, 'warn');
  assert.equal(snapshot.email.find(row => row.provider === 'cloudflare').used, null);
  for (let index = 0; index < 30; index++) await send(store, '/v1/email', event({ provider: 'cloudflare' }));
  snapshot = await read(store);
  assert.equal(snapshot.alerts.find(row => row.key === 'cloudflare:quota').severity, 'critical');
  assert.equal(snapshot.email.find(row => row.provider === 'cloudflare').delivered, null);
});

test('empty metrics can never certify a healthy infrastructure source', async () => {
  const store = storage();
  await send(store, '/v1/refresh', sources({ infrastructure: sources().infrastructure.map(row => ({ ...row, metrics: [] })) }));
  assert.ok((await read(store)).infrastructure.every(row => row.status === 'unknown'));
});

test('source outage never resolves a previous capacity incident; fresh healthy metrics can resolve it', async () => {
  const store = storage();
  const previous = sources({ infrastructure: sources().infrastructure.map(row => ({ ...row, status: row.service === 'planetscale' ? 'critical' : 'ok' })) });
  await send(store, '/v1/refresh', previous);
  const first = (await read(store)).alerts.find(row => row.key === 'planetscale:capacity');
  const outage = sources({ infrastructure: sources().infrastructure.map(row => ({ ...row, status: 'unknown' })) });
  await send(store, '/v1/refresh', outage, now + 1000);
  const retained = (await read(store, now + 1000)).alerts.find(row => row.key === 'planetscale:capacity');
  assert.equal(retained.severity, 'critical'); assert.equal(retained.first_seen_at, first.first_seen_at);
  assert.equal(retained.last_seen_at, first.last_seen_at);
  await send(store, '/v1/refresh', sources(), now + 2000);
  assert.equal((await read(store, now + 2000)).alerts.some(row => row.key === 'planetscale:capacity'), false);
});

test('stale snapshots never remain healthy and do not falsely resolve provider quotas', async () => {
  const store = storage(); await send(store, '/v1/refresh', sources());
  const snapshot = await read(store, now + 16 * 60_000);
  assert.equal(snapshot.infrastructure.find(row => row.service === 'workers').status, 'stale');
  assert.ok(snapshot.alerts.some(row => row.key === 'monitor:stale'));
  assert.ok(snapshot.alerts.some(row => row.key === 'resend:quota'));
});

test('source projection rejects unbounded/unrecognized metrics and strips free text/provider secrets', async () => {
  const store = storage();
  const invalid = sources({ infrastructure: sources().infrastructure.map(row => ({ ...row, metrics: [{ name: 'raw_secret', unit: 'percent', value: 99, threshold: 80, source: 'provider' }] })) });
  assert.equal((await send(store, '/v1/refresh', invalid)).status, 400);
  const valid = sources(); valid.raw_secret = 'must-not-leak'; valid.email[0].detail = 'must-not-leak';
  assert.equal((await send(store, '/v1/refresh', valid)).status, 200);
  assert.doesNotMatch(JSON.stringify([...store.data]), /must-not-leak/);
});

test('container egress cannot read snapshots, refresh providers, select another service or expose public ingress', async () => {
  const resolve = (service, instance) => { assert.equal(service, 'api'); assert.equal(instance, 'singleton'); return { fetch: async () => Response.json({ recorded: true }) }; };
  const target = 'https://observability.core.internal';
  assert.equal((await dispatchContainerOutbound('api', signedObservationRequest(env, '/v1/email', event()), env, resolve)).status, 200);
  for (const path of ['/v1/snapshot', '/v1/refresh', '/api/auth/token']) {
    assert.equal((await dispatchContainerOutbound('api', new Request(`${target}${path}`), env, () => assert.fail('unauthorized resolution'))).status, 404);
  }
  assert.equal((await dispatchContainerOutbound('payments', signedObservationRequest(env, '/v1/email', event()), env, () => assert.fail('wrong source'))).status, 404);
  assert.equal((await dispatchCore(signedObservationRequest(env, '/v1/email', event()), env, () => assert.fail('public ingestion'))).status, 404);
});

test('scheduled collection only reads official provider APIs and writes the existing API DO storage route', async () => {
  let calls = 0;
  const resolve = (service, instance) => {
    assert.equal(service, 'api'); assert.equal(instance, 'singleton');
    return { fetch: async request => { calls++; assert.equal(request.url, 'https://observability.core.internal/v1/refresh'); return Response.json({ recorded: true }); } };
  };
  await runOperationalMonitoring(env, resolve, { now, fetchImpl: () => assert.fail('no monitor credentials must mean no API call') });
  assert.equal(calls, 1);
  const worker = readFileSync(new URL('../src/worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /operationalSnapshot\(\)/);
  assert.match(worker, /if \(observationRequest\(request\)\) return handleOperationalStorage/);
  assert.match(worker.split('export class CoreApi')[1].split('export class CoreEngine')[0], /this\.interceptHttps = operationalMonitoringEnabled\(env\)/);
  const runtime = readFileSync(new URL('../src/runtime-env.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /values\.NODE_EXTRA_CA_CERTS = '\/etc\/cloudflare\/certs\/cloudflare-containers-ca\.crt'/);
  assert.doesNotMatch(worker.split('operationalSnapshot()')[1].split('nowpaymentsDiagnostics()')[0], /privateReadiness|startAndWaitForPorts/);
});

test('oversized and stalled observation bodies have bounded lifetime and never mutate durable storage', async () => {
  const store = storage();
  assert.equal((await send(store, '/v1/email', { ...event(), extra: 'x'.repeat(2048) })).status, 400);
  let cancelled = false;
  const signed = signedObservationRequest(env, '/v1/email', event(), now);
  const request = new Request(signed.url, { method: 'POST', headers: signed.headers, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } }) });
  assert.equal((await handleOperationalStorage(request, store, env, now)).status, 400);
  assert.equal(cancelled, true); assert.equal(store.data.size, 0);
});
