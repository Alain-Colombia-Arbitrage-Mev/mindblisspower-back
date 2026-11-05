import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { captureOtpTraceRequest, otpTraceHandler, postTraceObservation, recordOtpTraceDelivery, recordOtpTraceError,
  traceMessageRef, traceRecipientRef, type OtpTraceEvent, type OtpTraceLost } from './otp-trace';
import { createAuthDelivery } from './delivery';

const secret = 'synthetic-trace-secret-more-than-32-characters';
const env = { AUTH_OTP_TRACE_ENABLED: 'true', AUTH_BFF_SHARED_SECRET: secret };
const email = 'synthetic-owner@example.test', id = 'ABCDEF12-0000-4000-8000-000000000071';
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const request = (path: string, value: unknown = { email, type: 'sign-in' }) => new Request(`https://auth.example.test/api/auth${path}`,
  { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'private-session-cookie' }, body: JSON.stringify(value) });
const collector = (events: OtpTraceEvent[]) => (async (_url, init) => {
  const raw = init!.body as string, headers = new Headers(init!.headers);
  const signature = createHmac('sha256', secret).update(['POST', '/v1/trace', headers.get('x-vp-observation-timestamp'),
    createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
  expect(headers.get('x-vp-observation-signature')).toBe(signature);
  expect([...headers.keys()].sort()).toEqual(['content-type', 'x-vp-observation-signature', 'x-vp-observation-timestamp']);
  expect(init!.credentials).toBe('omit'); expect(init!.redirect).toBe('error');
  for (const value of [email, id, '654321', 'private-session-cookie', secret]) expect(raw).not.toContain(value);
  events.push(JSON.parse(raw)); return Response.json({ recorded: true });
}) as typeof fetch;

test('trace is opt-in and never touches disabled credentials or changes the native Response', async () => {
  const response = new Response('native-secret-response', { status: 429, headers: { 'set-cookie': 'native-cookie' } });
  for (const flag of [undefined, 'false', '', 'TRUE', 'true ']) {
    const configuration = { AUTH_OTP_TRACE_ENABLED: flag };
    Object.defineProperty(configuration, 'AUTH_BFF_SHARED_SECRET', { get() { throw Error('Disabled secret accessed'); } });
    expect(await otpTraceHandler(() => response, configuration, (() => { throw Error('Must not fetch'); }) as unknown as typeof fetch)(request('/sign-in/email-otp'))).toBe(response);
  }
  expect(response.bodyUsed).toBe(false);
});

test('send ACK correlates safe refs without reading or changing native response/cookies', async () => {
  const events: OtpTraceEvent[] = [];
  const response = new Response('private-response-654321', { headers: { 'set-cookie': 'native-cookie' } });
  const handler = otpTraceHandler(async () => {
    captureOtpTraceRequest('/email-otp/send-verification-otp', email, 'sign-in');
    recordOtpTraceDelivery(email, 'send_accepted', 200, id);
    return response;
  }, env, collector(events));
  expect(await handler(request('/email-otp/send-verification-otp'))).toBe(response);
  expect(response.bodyUsed).toBe(false); expect(response.headers.get('set-cookie')).toBe('native-cookie');
  await tick(); expect(events.map(value => value.stage)).toEqual(['requested', 'send_accepted']);
  expect(new Set(events.map(value => value.request_id)).size).toBe(1);
  expect(events[1]!.message_ref).toBe(traceMessageRef(secret, id.toLowerCase()));
  for (const event of events) {
    expect(event.recipient_ref).toBe(traceRecipientRef(secret, email));
    expect(event.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4/);
    expect(event.occurred_at).toBe(new Date(event.occurred_at).toISOString());
  }
});

test('real delivery adapter adds only Resend accepted UUID correlation; no retry or fallback', async () => {
  const events: OtpTraceEvent[] = []; let sends = 0;
  const delivery = createAuthDelivery({ ...env, AUTH_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_synthetic', AUTH_EMAIL_FROM: 'otp@example.test' },
    (async url => { expect(url).toBe('https://api.resend.com/emails'); sends++; return Response.json({ id }); }) as typeof fetch, () => {});
  await otpTraceHandler(async () => { captureOtpTraceRequest('/email-otp/send-verification-otp', email, 'sign-in');
    await delivery.email({ to: email, subject: 'private-subject', text: '654321' }); return Response.json({ success: true });
  }, env, collector(events))(request('/email-otp/send-verification-otp'));
  await tick(); expect(sends).toBe(1);
  expect(events.find(value => value.stage === 'send_accepted')?.message_ref).toBe(traceMessageRef(secret, id));
});

test('request-local concurrent owners never share a recipient or browser-controlled request id', async () => {
  const events: OtpTraceEvent[] = [];
  const handler = otpTraceHandler(async req => {
    const body = await req.json() as { email: string };
    captureOtpTraceRequest('/sign-in/email-otp', body.email);
    await new Promise(resolve => setTimeout(resolve, body.email === email ? 15 : 1));
    return Response.json({ private: 'native' });
  }, env, collector(events));
  await Promise.all([handler(request('/sign-in/email-otp', { email, otp: '654321', request_id: 'untrusted' })),
    handler(request('/sign-in/email-otp', { email: 'another@example.test', otp: '654321' }))]);
  await tick(); expect(new Set(events.map(value => value.request_id)).size).toBe(2);
  for (const ref of [traceRecipientRef(secret, email), traceRecipientRef(secret, 'another@example.test')]) {
    expect(events.filter(value => value.recipient_ref === ref).map(value => value.stage)).toEqual(['requested', 'validation_succeeded']);
  }
});

test('known hook codes distinguish registration, blocking and throttling without parsing private responses', async () => {
  for (const [status, code, stage] of [[400, 'REGISTRATION_REQUIRED', 'registration_required'], [403, 'NO_ACCESS', 'blocked'],
    [429, 'TOO_FAST', 'throttled'], [503, 'UNAVAILABLE', 'request_failed']] as const) {
    const events: OtpTraceEvent[] = [];
    const handler = otpTraceHandler(() => {
      captureOtpTraceRequest('/email-otp/send-verification-otp', email, 'sign-in');
      recordOtpTraceError({ statusCode: status, body: { code, message: 'private-error-654321' } });
      return new Response('must-not-be-read', { status });
    }, env, collector(events));
    const response = await handler(request('/email-otp/send-verification-otp'));
    expect(response.bodyUsed).toBe(false); await tick(); expect(events.at(-1)!.stage).toBe(stage);
  }
});

test('native early HTTP429 is correlated by bounded request metadata even without hooks', async () => {
  const events: OtpTraceEvent[] = [];
  const response = await otpTraceHandler(() => Response.json({ error: 'native' }, { status: 429 }), env, collector(events))(
    request('/email-otp/send-verification-otp'));
  expect(response.status).toBe(429); await tick(); expect(events.map(value => value.stage)).toEqual(['requested', 'throttled']);
});

test('background transport timeout cannot delay auth; hard deadline aborts a stalled sink without retries', async () => {
  let calls = 0; const signals: AbortSignal[] = [], lost: OtpTraceLost[] = [];
  const sink = (async (_url, init) => { calls++; signals.push(init!.signal!); return new Promise<Response>(() => {}); }) as typeof fetch;
  const native = Response.json({ native: true }); const started = performance.now();
  const response = await otpTraceHandler(() => { captureOtpTraceRequest('/sign-in/email-otp', email); return native; }, env, sink, event => lost.push(event))(request('/sign-in/email-otp'));
  expect(response).toBe(native); expect(performance.now() - started).toBeLessThan(200);
  await new Promise(resolve => setTimeout(resolve, 550));
  expect(calls).toBe(2); expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(lost).toEqual([{ event: 'auth_otp_trace_lost', reason: 'transport' }]);
});

test('malformed or stalled sink body aborts once without reading auth responses or repeating auth', async () => {
  for (const stalled of [false, true]) {
    let calls = 0, authCalls = 0; const lost: OtpTraceLost[] = []; const signals: AbortSignal[] = [];
    const sink = (async (_url, init) => {
      calls++; signals.push(init!.signal!);
      return stalled ? new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })
        : new Response('private-malformed-654321', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const response = new Response('native-not-read', { status: 400 });
    expect(await otpTraceHandler(() => { authCalls++; captureOtpTraceRequest('/sign-in/email-otp', email); return response; }, env, sink,
      event => lost.push(event))(request('/sign-in/email-otp'))).toBe(response);
    await new Promise(resolve => setTimeout(resolve, stalled ? 550 : 20));
    expect(authCalls).toBe(1); expect(response.bodyUsed).toBe(false); expect(calls).toBe(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(lost).toEqual([{ event: 'auth_otp_trace_lost', reason: 'transport' }]);
  }
});

test('transport reconstructs event allowlist and requires exact ACK; malformed metadata is not transmitted', async () => {
  const event: OtpTraceEvent = { version: 1, id: '00000000-0000-4000-8000-000000000071', request_id: '00000000-0000-4000-8000-000000000072',
    occurred_at: new Date().toISOString(), recipient_ref: traceRecipientRef(secret, email), purpose: 'sign-in', stage: 'requested' };
  const events: OtpTraceEvent[] = [];
  expect(await postTraceObservation(env, '/v1/trace', { ...event, email, otp: '654321' } as never, collector(events))).toBe(true);
  expect(Object.keys(events[0]!)).toEqual(Object.keys(event));
  for (const ack of [Response.json({ recorded: false }), Response.json({ recorded: true, extra: email }), Response.json({ recorded: true }, { status: 202 }),
    new Response('{"recorded":true}', { headers: { 'content-type': 'text/plain' } })]) {
    expect(await postTraceObservation(env, '/v1/trace', event, (async () => ack) as unknown as typeof fetch)).toBe(false);
  }
  let calls = 0;
  expect(await postTraceObservation(env, '/v1/trace', { ...event, id: email }, (async () => { calls++; return Response.json({ recorded: true }); }) as unknown as typeof fetch)).toBe(false);
  expect(calls).toBe(0);
});

test('thrown native errors retain identity and never cause a second auth attempt', async () => {
  const events: OtpTraceEvent[] = []; const error = new APIError('INTERNAL_SERVER_ERROR', { message: 'private-error' });
  const handler = otpTraceHandler(() => { captureOtpTraceRequest('/sign-in/email-otp', email); throw error; }, env, collector(events));
  try { await handler(request('/sign-in/email-otp')); throw Error('Expected original error'); }
  catch (caught) { expect(caught).toBe(error); }
  await tick(); expect(events.at(-1)!.stage).toBe('validation_failed');
});
