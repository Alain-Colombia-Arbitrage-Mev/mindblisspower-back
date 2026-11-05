import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { recordAuthTelemetry, readAuthTrace, localDeliveryCounts, validAuthTrace, validDeliveryTrace,
  AUTH_TRACE_RETENTION_MS, emptyAuthTrace } from '../src/auth-trace-store.mjs';
import { handleOperationalStorage, signedObservationRequest } from '../src/observability-store.mjs';
import { privateOperationalSnapshot, runOperationalMonitoring } from '../src/observability-monitor.mjs';
import { recordDeliveryTelemetry, privateAuthTrace, authTraceTransportReadiness, authTraceReadinessDiagnostics } from '../src/email-telemetry.mjs';

const now = Date.parse('2026-11-04T12:00:00.000Z');
const iso = value => new Date(value).toISOString();
const ref = value => createHash('sha256').update(value).digest('hex');
const recipient = ref('synthetic-recipient');
const message = ref('synthetic-message');
const env = { CORE_ENV: 'production', CORE_AUTH_TRACE_ENABLED: 'true', CORE_OBSERVABILITY_ENABLED: 'false',
  API_BFF_SHARED_SECRET: 'synthetic-auth-trace-signing-secret-at-least-32-characters' };
const trace = (patch = {}) => ({ version: 1, id: randomUUID(), request_id: randomUUID(), occurred_at: iso(now),
  recipient_ref: recipient, purpose: 'sign-in', stage: 'requested', ...patch });
const delivery = (patch = {}) => ({ version: 1, id: ref(randomUUID()), occurred_at: iso(now),
  event_type: 'email.delivered', message_ref: message, ...patch });

function storage() {
  const data = new Map(); let lock = Promise.resolve();
  const operations = map => ({
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)); },
    delete: async values => { for (const key of Array.isArray(values) ? values : [values]) map.delete(key); },
    list: async ({ prefix, end = `${prefix}\uffff`, limit }) => new Map([...map].filter(([key]) => key.startsWith(prefix) && key < end)
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
  });
  return { ...operations(data), data, transaction(callback) {
    const task = lock.then(async () => {
      const copy = structuredClone(data); const result = await callback(operations(copy));
      data.clear(); for (const entry of copy) data.set(...entry); return result;
    }); lock = task.catch(() => {}); return task;
  } };
}
const send = (store, path, value, time = now, configuration = env) => handleOperationalStorage(
  signedObservationRequest(configuration, path, value, time), store, configuration, time);

test('trace contracts accept only pseudonymous fixed enums, canonical times and bounded statuses', () => {
  assert.equal(validAuthTrace(trace(), now), true);
  for (const patch of [{ email: 'must-not-store@example.test' }, { otp: '001234' }, { provider_id: 'raw-provider-id' },
    { stage: 'arbitrary text' }, { purpose: 'change-email' }, { id: 'invalid' }, { request_id: 'invalid' },
    { recipient_ref: 'raw@example.test' }, { recipient_ref: [recipient] }, { id: [randomUUID()] }, { message_ref: [message] },
    { http_status: 600 }, { occurred_at: iso(now - 601_000) }]) {
    assert.equal(validAuthTrace(trace(patch), now), false);
  }
  assert.equal(validDeliveryTrace(delivery(), now), true);
  for (const patch of [{ to: ['must-not-store@example.test'] }, { id: [ref('id')] }, { message_ref: [message] },
    { message_ref: 'raw-provider-id' }, { event_type: 'email.clicked' },
    { occurred_at: iso(now + 61_000) }, { occurred_at: iso(now - AUTH_TRACE_RETENTION_MS) }]) assert.equal(validDeliveryTrace(delivery(patch), now), false);
});

test('trace flag operates independently of provider monitoring, and the transport probe never touches storage', async () => {
  const store = storage();
  assert.deepEqual(await (await send(null, '/v1/probe', {})).json(), { recorded: true });
  assert.equal((await send(store, '/v1/probe', { unexpected: true })).status, 400);
  assert.equal(store.data.size, 0);
  assert.equal((await send(store, '/v1/trace', trace())).status, 200);
  assert.equal((await send(store, '/v1/email', {})).status, 503);
  const disabled = { ...env, CORE_AUTH_TRACE_ENABLED: 'false', CORE_OBSERVABILITY_ENABLED: 'true' };
  assert.equal((await send(null, '/v1/trace', trace(), now, disabled)).status, 503);
  assert.deepEqual(await privateAuthTrace(disabled, () => assert.fail('disabled storage resolution'), { recipient_ref: recipient }, now), emptyAuthTrace(false));
});

test('signed ingestion deduplicates concurrent IDs and projects twenty newest events without any references', async () => {
  const store = storage(); const value = trace();
  assert.ok((await Promise.all(Array.from({ length: 8 }, () => send(store, '/v1/trace', value)))).every(result => result.status === 200));
  for (let index = 1; index <= 24; index++) await send(store, '/v1/trace', trace({ occurred_at: iso(now + index) }), now + index);
  const result = await readAuthTrace(store, { recipient_ref: recipient }, now + 30);
  assert.equal(result.events.length, 20);
  assert.equal(result.events[0].occurred_at, iso(now + 24));
  assert.equal(result.events.at(-1).occurred_at, iso(now + 5));
  assert.equal(result.coverage.retention_days, 14);
  assert.equal(result.coverage.limited, false);
  assert.doesNotMatch(JSON.stringify(result), /recipient_ref|request_id|message_ref|synthetic-|email_id/);
  assert.deepEqual((await readAuthTrace(store, { recipient_ref: ref('other') }, now + 30)).events, []);
});

test('webhooks arriving before or after send acceptance associate without double-counting message states', async () => {
  for (const before of [true, false]) {
    const store = storage();
    const accepted = trace({ stage: 'send_accepted', message_ref: message });
    const value = delivery();
    if (before) await recordAuthTelemetry(store, 'delivery', value, now);
    await recordAuthTelemetry(store, 'auth', accepted, now);
    if (!before) await recordAuthTelemetry(store, 'delivery', value, now);
    await Promise.all(Array.from({ length: 5 }, () => recordAuthTelemetry(store, 'delivery', value, now)));
    await recordAuthTelemetry(store, 'delivery', delivery(), now); // different Svix ID, same message/state
    await recordAuthTelemetry(store, 'delivery', delivery({ event_type: 'email.delivery_delayed', occurred_at: iso(now - 1000) }), now);
    const result = await readAuthTrace(store, { recipient_ref: recipient }, now);
    assert.equal(result.events.filter(event => event.kind === 'delivery').length, 3);
    const count = await localDeliveryCounts(store, 'calendar_month', now);
    assert.equal(count.delivered, 1); assert.equal(count.delayed, 1); assert.equal(count.bounced, 0);
    assert.equal(count.delivery_coverage_limited, false);
  }
});

test('a provider message cannot be rebound to a different recipient or request', async () => {
  const store = storage(); const requestId = randomUUID();
  await recordAuthTelemetry(store, 'auth', trace({ request_id: requestId, message_ref: message }), now);
  const before = JSON.stringify([...store.data]);
  await assert.rejects(recordAuthTelemetry(store, 'auth', trace({ recipient_ref: ref('other'), message_ref: message }), now), /mapping_collision/);
  assert.equal(JSON.stringify([...store.data]), before);
});

test('fourteen-day expiry never appears in a read and bounded pruning removes its indexes', async () => {
  const store = storage();
  await recordAuthTelemetry(store, 'auth', trace({ message_ref: message }), now);
  await recordAuthTelemetry(store, 'delivery', delivery(), now);
  const after = now + AUTH_TRACE_RETENTION_MS + 1;
  assert.deepEqual((await readAuthTrace(store, { recipient_ref: recipient }, after)).events, []);
  assert.equal([...store.data.keys()].filter(key => /event:|recipient:|mapping:|seen:|message-events:|delivery-state:/.test(key)).length, 0);
});

test('the global capacity is bounded and eviction explicitly invalidates delivery coverage', async () => {
  const store = storage();
  await recordAuthTelemetry(store, 'delivery', delivery(), now, 2);
  await recordAuthTelemetry(store, 'auth', trace({ message_ref: message }), now, 2);
  await recordAuthTelemetry(store, 'auth', trace({ occurred_at: iso(now + 1) }), now + 1, 2);
  assert.equal([...store.data.keys()].filter(key => key.startsWith('auth-trace:v1:event:')).length, 2);
  assert.equal((await readAuthTrace(store, { recipient_ref: recipient }, now + 1)).coverage.limited, true);
  const count = await localDeliveryCounts(store, 'calendar_month', now + 1);
  assert.equal(count.delivered, null); assert.equal(count.bounced, null); assert.equal(count.delivery_coverage_limited, true);
});

test('HMAC envelopes bind trace/delivery/read method, path and raw bytes, with no browser credentials', async () => {
  const store = storage();
  const original = signedObservationRequest(env, '/v1/trace', trace(), now);
  const changed = new Request(original.url, { method: 'POST', headers: original.headers, body: '{}' });
  assert.equal((await handleOperationalStorage(changed, store, env, now)).status, 401);
  const cookie = signedObservationRequest(env, '/v1/trace', trace(), now); cookie.headers.set('cookie', 'must-not-store');
  assert.equal((await handleOperationalStorage(cookie, store, env, now)).status, 404);
  assert.equal((await send(store, '/v1/trace-read', { recipient_ref: recipient, email: 'must-not-store@example.test' })).status, 400);
  assert.equal(store.data.size, 0);
});

test('portal delivery capability acknowledges only committed strict storage ACKs and exposes no read method', async () => {
  const store = storage(); let calls = 0;
  const resolve = (service, singleton) => ({ fetch: request => {
    assert.equal(service, 'api'); assert.equal(singleton, 'singleton'); calls++;
    assert.equal(new URL(request.url).pathname, '/v1/delivery');
    return handleOperationalStorage(request, store, env, now);
  } });
  assert.deepEqual(await recordDeliveryTelemetry(env, resolve, delivery(), now), { recorded: true });
  assert.equal(calls, 1);
  for (const body of [{ recorded: false }, { recorded: true, extra: 'must-not-leak' }, {}]) {
    await assert.rejects(recordDeliveryTelemetry(env, () => ({ fetch: async () => Response.json(body) }), delivery(), now), /unavailable/);
  }
  await assert.rejects(recordDeliveryTelemetry(env, () => assert.fail('invalid event dispatch'), delivery({ email: 'must-not-store@example.test' }), now));
  const worker = readFileSync(new URL('../src/worker.mjs', import.meta.url), 'utf8');
  const capability = worker.split('export class PrivateEmailTelemetry')[1].split(/\r?\n}\r?\n/)[0];
  assert.match(capability, /recordDelivery\(event\)/);
  assert.doesNotMatch(capability, /authTrace\(|fetch\(|readiness\(|provider/i);
});

test('transport readiness uses exactly one fixed signed Bun path and no cookie, client target, message or storage write', async () => {
  let calls = 0;
  const resolve = (service, singleton) => ({ async fetch(request) {
    calls++; assert.equal(service, 'api'); assert.equal(singleton, 'singleton');
    assert.equal(request.url, 'https://auth.core.internal/internal/otp-trace-readiness');
    assert.equal(request.method, 'POST'); assert.equal(request.headers.has('cookie'), false);
    assert.equal(request.headers.has('authorization'), false);
    const raw = await request.text(); assert.equal(raw, '{}');
    const expected = createHmac('sha256', env.API_BFF_SHARED_SECRET).update(['POST', '/internal/otp-trace-readiness', String(now / 1000), '127.0.0.1',
      createHash('sha256').update('').digest('hex'), createHash('sha256').update('{}').digest('hex')].join('\n')).digest('hex');
    assert.equal(request.headers.get('x-vp-auth-signature'), expected);
    return Response.json({ ready: true });
  } });
  assert.deepEqual(await authTraceTransportReadiness(env, resolve, now), { ready: true }); assert.equal(calls, 1);
  assert.deepEqual(await authTraceTransportReadiness({ ...env, CORE_AUTH_TRACE_ENABLED: 'false' }, () => assert.fail('disabled probe'), now), { ready: false });
  assert.deepEqual(await authTraceTransportReadiness(env, () => ({ fetch: async () => Response.json({ ready: true, extra: true }) }), now), { ready: false });
});

test('trace-only monitoring exposes local incidents while provider quotas/capacity stay unknown and no provider is contacted', async () => {
  const store = storage();
  for (let index = 0; index < 3; index++) {
    const requestId = randomUUID();
    await send(store, '/v1/trace', trace({ request_id: requestId, stage: 'send_rejected', http_status: 503 }));
    await send(store, '/v1/trace', trace({ request_id: requestId, stage: 'request_failed', http_status: 503 }));
  }
  const resolve = () => ({ fetch: request => handleOperationalStorage(request, store, env, now) });
  const snapshot = await privateOperationalSnapshot(env, resolve, now);
  assert.equal(snapshot.monitor.enabled, false);
  assert.ok(snapshot.email.every(row => row.used === null && row.status === 'unknown'));
  assert.ok(snapshot.infrastructure.every(row => row.status === 'unknown'));
  assert.equal(snapshot.alerts.find(row => row.key === 'email:delivery_failure')?.severity, 'warn');
  assert.ok(snapshot.alerts.every(row => row.notification_status === 'in_app'));
  await runOperationalMonitoring(env, () => assert.fail('provider monitoring must remain disabled'), { fetchImpl: () => assert.fail('no provider API') });
  const result = await send(store, '/v1/prune-traces', {});
  assert.equal(result.status, 200);
  assert.ok(store.data.has('ops:v1:alerts'));
  const failed = await privateOperationalSnapshot(env, () => ({ fetch: async () => { throw new Error('unavailable'); } }), now);
  assert.equal(failed.monitor.enabled, false);
  assert.equal(failed.overall, 'unknown');
});

test('one request with several failure classifications is not three failed requests, while any429 remains critical', async () => {
  const store = storage(); const requestId = randomUUID();
  for (const stage of ['send_rejected', 'request_failed', 'send_unknown']) await send(store, '/v1/trace', trace({ request_id: requestId, stage }));
  let snapshot = await (await send(store, '/v1/snapshot', undefined)).json();
  assert.equal(snapshot.alerts.some(row => row.key === 'email:delivery_failure'), false);
  await send(store, '/v1/trace', trace({ request_id: requestId, stage: 'throttled', http_status: 429 }));
  snapshot = await (await send(store, '/v1/snapshot', undefined)).json();
  assert.equal(snapshot.alerts.find(row => row.key === 'email:delivery_failure')?.severity, 'critical');
});

test('delivery failures alert locally, counts remain separate from usage, and cap truncation never pretends recovery', async () => {
  const store = storage();
  await send(store, '/v1/delivery', delivery({ event_type: 'email.bounced' }));
  let snapshot = await (await send(store, '/v1/snapshot', undefined)).json();
  const resend = snapshot.email.find(row => row.provider === 'resend');
  assert.equal(resend.bounced, 1); assert.equal(resend.delivered, 0); assert.equal(resend.used, null);
  assert.equal(snapshot.alerts.find(row => row.key === 'email:delivery_failure')?.severity, 'critical');
  await send(store, '/v1/prune-traces', {}); // persist the incident before truncation
  await recordAuthTelemetry(store, 'auth', trace(), now, 1);
  snapshot = await (await send(store, '/v1/snapshot', undefined)).json();
  assert.equal(snapshot.email.find(row => row.provider === 'resend').bounced, null);
  assert.equal(snapshot.alerts.find(row => row.key === 'email:delivery_failure')?.data_status, 'unknown');
});

test('readiness diagnostics distinguish gate/storage/authentication/API phases with fixed enum projections only', async () => {
  let calls = 0;
  const resolve = callback => (service, singleton) => ({ fetch: request => {
    assert.equal(service, 'api'); assert.equal(singleton, 'singleton'); calls++; return callback(request);
  } });
  const closed = await authTraceReadinessDiagnostics(env, resolve(() => Response.json({ error: 'observability_disabled' }, { status: 503 })), now);
  assert.deepEqual(closed, { phase: 'storage', ready: false, storage_status: 503, classification: 'gate_closed' });
  assert.equal(calls, 1);
  for (const [error, classification] of [['unauthorized', 'unauthorized'], ['invalid_request', 'invalid_request'],
    ['observability_unavailable', 'unavailable'], ['private-provider-error-must-not-leak', 'unknown']]) {
    const result = await authTraceReadinessDiagnostics(env, resolve(() => Response.json({ error }, { status: 401 })), now);
    assert.equal(result.classification, classification);
    assert.doesNotMatch(JSON.stringify(result), /private-provider|synthetic|recipient_ref/);
  }
  calls = 0;
  const apiFailure = await authTraceReadinessDiagnostics(env, resolve(request => new URL(request.url).hostname === 'observability.core.internal'
    ? Response.json({ recorded: true }) : Response.json({ error: 'otp_trace_unavailable' }, { status: 503 })), now);
  assert.deepEqual(apiFailure, { phase: 'api', ready: false, storage_status: 200, api_status: 503, classification: 'unavailable' });
  assert.equal(calls, 2);
  calls = 0;
  const complete = await authTraceReadinessDiagnostics(env, resolve(request => {
    assert.equal(request.headers.has('cookie'), false);
    const url = new URL(request.url);
    assert.ok(['https://observability.core.internal/v1/probe', 'https://auth.core.internal/internal/otp-trace-readiness'].includes(url.href));
    return Response.json(url.hostname === 'observability.core.internal' ? { recorded: true } : { ready: true });
  }), now);
  assert.deepEqual(complete, { phase: 'complete', ready: true, storage_status: 200, api_status: 200 }); assert.equal(calls, 2);
  assert.deepEqual(await authTraceReadinessDiagnostics({ ...env, CORE_AUTH_TRACE_ENABLED: 'false' }, () => assert.fail('disabled fetch'), now),
    { phase: 'unavailable', ready: false, classification: 'gate_closed' });
});

test('readiness diagnostics fail closed on malformed/overlong ACKs, transport exceptions and deadline without retries', async context => {
  for (const response of [Response.json({ recorded: true, extra: 'private' }), Response.json({ secret: 'private' }),
    new Response('x'.repeat(1000), { headers: { 'content-type': 'application/json' } })]) {
    const result = await authTraceReadinessDiagnostics(env, () => ({ fetch: async () => response }), now);
    assert.equal(result.phase, 'storage'); assert.equal(result.ready, false); assert.equal(result.classification, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /private|secret|extra/);
  }
  assert.deepEqual(await authTraceReadinessDiagnostics(env, () => ({ fetch: () => { throw new Error('private-transport'); } }), now),
    { phase: 'storage', ready: false, classification: 'unavailable' });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const pending = authTraceReadinessDiagnostics(env, () => ({ fetch: async () => { calls++; return new Promise(() => {}); } }), now);
  await Promise.resolve(); context.mock.timers.tick(3000);
  assert.deepEqual(await pending, { phase: 'storage', ready: false, classification: 'unavailable' }); assert.equal(calls, 1);
});

// Flush the finite response-body/Promise.race chain before advancing the mock
// clock. Assert settlement before awaiting results so regressions cannot hang.
const flushReadinessMicrotasks = async () => { for (let index = 0; index < 32; index++) await Promise.resolve(); };

for (const diagnostics of [false, true]) {
  const label = diagnostics ? 'readiness diagnostics' : 'transport readiness';
  test(`${label} permits a four-second cold API without lengthening the three-second storage deadline`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let apiCalls = 0, storageCalls = 0, settled = false;
    const resolve = () => ({ fetch: request => {
      if (new URL(request.url).hostname === 'observability.core.internal') {
        storageCalls++; return Response.json({ recorded: true });
      }
      apiCalls++;
      return new Promise(resolve => setTimeout(() => resolve(Response.json({ ready: true })), 4000));
    } });
    const pending = (diagnostics ? authTraceReadinessDiagnostics : authTraceTransportReadiness)(env, resolve, now)
      .then(result => { settled = true; return result; });
    await flushReadinessMicrotasks();
    assert.equal(apiCalls, 1); assert.equal(storageCalls, diagnostics ? 1 : 0);
    context.mock.timers.tick(3000); await flushReadinessMicrotasks(); assert.equal(settled, false);
    context.mock.timers.tick(999); await flushReadinessMicrotasks(); assert.equal(settled, false);
    context.mock.timers.tick(1); await flushReadinessMicrotasks(); assert.equal(settled, true);
    assert.deepEqual(await pending, diagnostics
      ? { phase: 'complete', ready: true, storage_status: 200, api_status: 200 } : { ready: true });
    context.mock.timers.tick(60000); await flushReadinessMicrotasks();
    assert.equal(apiCalls, 1); assert.equal(storageCalls, diagnostics ? 1 : 0);
  });

  test(`${label} gives up at fifteen seconds on a stalled API without retrying`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let apiCalls = 0, storageCalls = 0, settled = false;
    const resolve = () => ({ fetch: request => {
      if (new URL(request.url).hostname === 'observability.core.internal') {
        storageCalls++; return Response.json({ recorded: true });
      }
      apiCalls++; return new Promise(() => {});
    } });
    const pending = (diagnostics ? authTraceReadinessDiagnostics : authTraceTransportReadiness)(env, resolve, now)
      .then(result => { settled = true; return result; });
    await flushReadinessMicrotasks();
    assert.equal(apiCalls, 1); assert.equal(storageCalls, diagnostics ? 1 : 0);
    context.mock.timers.tick(14999); await flushReadinessMicrotasks(); assert.equal(settled, false);
    context.mock.timers.tick(1); await flushReadinessMicrotasks(); assert.equal(settled, true);
    assert.deepEqual(await pending, diagnostics
      ? { phase: 'api', ready: false, storage_status: 200, classification: 'unavailable' } : { ready: false });
    context.mock.timers.tick(60000); await flushReadinessMicrotasks();
    assert.equal(apiCalls, 1); assert.equal(storageCalls, diagnostics ? 1 : 0);
  });
}
