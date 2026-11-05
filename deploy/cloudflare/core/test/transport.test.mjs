import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedBody, fetchWithDeadline, coreOperationTimeoutMs, CORE_BODY_TIMEOUT_MS } from '../src/transport.mjs';
import { dispatchCore } from '../src/routing.mjs';

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const clock = t => t.mock.timers.enable({ apis: ['setTimeout'] });
const request = (path = '/api/member/profile', init) => new Request(`https://payments.core.internal${path}`, init);

test('operation deadlines preserve Go/provider processing windows and never configure scheduled jobs', () => {
  assert.equal(CORE_BODY_TIMEOUT_MS, 10_000);
  for (const [path, ms] of [['/api/auth/sign-in/email-otp', 45_000], ['/api/webhooks/nowpayments', 30_000],
    ['/api/payments/checkout', 65_000], ['/api/admin/finance', 65_000], ['/api/payments/nowpayments/status', 10_000]]) {
    assert.equal(coreOperationTimeoutMs(request(path)), ms);
  }
});

test('a fetch that ignores abort times out once and its late response is cancelled without retries', async t => {
  clock(t);
  let complete, signal, calls = 0, cancelled = 0;
  const result = fetchWithDeadline(request(), async input => {
    calls++; signal = input.signal;
    return new Promise(resolve => { complete = resolve; });
  }, 20);
  const rejected = assert.rejects(result, /^Error: upstream_unavailable$/);
  await flush(); t.mock.timers.tick(21); await rejected;
  assert.equal(signal.aborted, true);
  complete(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await flush();
  assert.equal(cancelled, 1); assert.equal(calls, 1);
});

test('the wall-clock deadline includes stalled response body EOF and never waits on broken cancellation', async t => {
  clock(t);
  let cancelled = 0, signal;
  const response = await fetchWithDeadline(request(), async input => {
    signal = input.signal;
    return new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }));
  }, 20);
  const rejected = assert.rejects(response.text(), /^Error: upstream_unavailable$/);
  await flush(); t.mock.timers.tick(21); await rejected;
  assert.equal(signal.aborted, true); assert.equal(cancelled, 1);
});

test('caller abort before dispatch prevents a fetch; abort after dispatch terminates it without exposing reasons', async t => {
  clock(t);
  for (const before of [true, false]) {
    const controller = new AbortController(); let calls = 0;
    if (before) controller.abort(new Error('private-token'));
    const result = fetchWithDeadline(request('/', { signal: controller.signal }), async () => { calls++; return new Promise(() => {}); }, 20);
    const rejected = assert.rejects(result, /^Error: upstream_unavailable$/);
    if (!before) { await flush(); controller.abort(new Error('private-token')); }
    await rejected; assert.equal(calls, before ? 0 : 1);
  }
});

test('successful streamed responses preserve bytes, status, cookies and clean up their deadline', async t => {
  clock(t);
  let signal;
  const response = await fetchWithDeadline(request(), async input => {
    signal = input.signal;
    return new Response('durably-persisted-ack', { status: 201, headers: [['set-cookie', 'one=1; Secure; HttpOnly'], ['set-cookie', 'two=2; Secure; HttpOnly']] });
  }, 20);
  assert.equal(response.status, 201);
  assert.equal(await response.text(), 'durably-persisted-ack');
  assert.deepEqual(response.headers.getSetCookie(), ['one=1; Secure; HttpOnly', 'two=2; Secure; HttpOnly']);
  t.mock.timers.tick(21); assert.equal(signal.aborted, false);
});

test('consumer cancellation aborts the upstream and is not held open by a noncompliant cancellation callback', async t => {
  clock(t);
  let signal, cancelled = 0;
  const response = await fetchWithDeadline(request(), async input => {
    signal = input.signal;
    return new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }));
  }, 20);
  await response.body.cancel();
  assert.equal(signal.aborted, true); assert.equal(cancelled, 1);
});

test('streaming uploads time out and cancel without awaiting an uncooperative stream', async t => {
  clock(t);
  let cancelled = 0;
  const input = request('/', { method: 'POST', duplex: 'half', body: new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }) });
  const rejected = assert.rejects(boundedBody(input, 10, 20), /^Error: upstream_unavailable$/);
  await flush(); t.mock.timers.tick(21); await rejected;
  assert.equal(cancelled, 1);
});

test('body byte limits, caller cancellation and declared sizes remain strict and preserve valid bytes', async t => {
  clock(t);
  assert.equal(new TextDecoder().decode(await boundedBody(request('/', { method: 'POST', body: 'abcd' }), 4, 20)), 'abcd');
  await assert.rejects(boundedBody(request('/', { method: 'POST', body: 'abcde' }), 4, 20), /^Error: body_limit$/);
  await assert.rejects(boundedBody(request('/', { method: 'POST', headers: { 'content-length': '5' }, body: 'a' }), 4, 20), /^Error: body_limit$/);
  const controller = new AbortController();
  const input = request('/', { method: 'POST', duplex: 'half', signal: controller.signal, body: new ReadableStream() });
  const rejected = assert.rejects(boundedBody(input, 4, 20), /^Error: upstream_unavailable$/);
  controller.abort(new Error('private-content'));
  await rejected;
});

test('a stalled upload fails before Container resolution, not as an invoice rejection or fabricated durable ACK', async t => {
  clock(t);
  let calls = 0;
  const env = { CORE_ENV: 'production', AUTH_SERVICES_ENABLED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_CUTOVER_VERIFIED: 'true' };
  const result = dispatchCore(new Request('https://auth.core.internal/api/auth/sign-in/email-otp', {
    method: 'POST', duplex: 'half', body: new ReadableStream(),
  }), env, () => { calls++; throw new Error('Container must not start'); });
  await flush(); t.mock.timers.tick(CORE_BODY_TIMEOUT_MS + 1);
  const response = await result;
  assert.equal(response.status, 503); assert.equal(calls, 0);
  assert.deepEqual(await response.json(), { error: 'upstream_unavailable' });
});
