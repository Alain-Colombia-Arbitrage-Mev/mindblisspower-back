import { createHash, createHmac } from 'node:crypto';
import { expect, test } from 'bun:test';
import { AuthEmailDeliveryError, createAuthDelivery, type AuthEnvironment } from './delivery';
import { createEmailObserver, EMAIL_OBSERVATION_TIMEOUT_MS, EMAIL_OBSERVATION_URL,
  type EmailObservation, type EmailObservationLost } from './email-observation';

const secret = 'synthetic-observation-secret-at-least-32-characters';
const enabled = { AUTH_OBSERVABILITY_ENABLED: 'true', AUTH_BFF_SHARED_SECRET: secret };
const accepted = { id: '00000000-0000-4000-8000-000000000071' };
const message = { to: 'private-recipient@example.test', subject: 'private subject', text: 'private OTP 012345' };
const resend: AuthEnvironment = { ...enabled, AUTH_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_private_synthetic_key',
  AUTH_EMAIL_FROM: 'private-sender@example.test' };
const cloudflare: AuthEnvironment = { ...enabled, AUTH_EMAIL_PROVIDER: 'cloudflare',
  CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'private_synthetic_cf_key', AUTH_EMAIL_FROM: 'private-sender@example.test' };

test('observation is opt-in; disabled capture reads no monitoring secret and makes no transport call', async () => {
  for (const flag of [undefined, '', 'false', 'TRUE', ' true ']) {
    const env: AuthEnvironment = { AUTH_OBSERVABILITY_ENABLED: flag };
    Object.defineProperty(env, 'AUTH_BFF_SHARED_SECRET', { get() { throw new Error('Inactive secret accessed'); } });
    await createEmailObserver(env, (async () => { throw new Error('Disabled transport called'); }) as unknown as typeof fetch,
      () => { throw new Error('Disabled diagnostic called'); })({ provider: 'resend', outcome: 'accepted' });
  }
});

test('fixed private request signs only an allowlisted terminal observation, never provider content or credentials', async () => {
  let calls = 0;
  const lost: EmailObservationLost[] = [];
  await createEmailObserver(enabled, (async (url, request) => {
    calls++;
    expect(url).toBe(EMAIL_OBSERVATION_URL);
    expect(request?.method).toBe('POST');
    expect(request?.redirect).toBe('error');
    expect(request?.credentials).toBe('omit');
    expect(request?.cache).toBe('no-store');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(request?.headers);
    expect([...headers.keys()].sort()).toEqual(['content-type', 'x-vp-observation-signature', 'x-vp-observation-timestamp']);
    expect(headers.get('content-type')).toBe('application/json');
    const timestamp = headers.get('x-vp-observation-timestamp')!;
    expect(timestamp).toMatch(/^[0-9]+$/);
    expect(Math.abs(Date.now() / 1000 - Number(timestamp))).toBeLessThan(3);
    const raw = request?.body as string;
    const event = JSON.parse(raw);
    expect(Object.keys(event).sort()).toEqual(['http_status', 'id', 'occurred_at', 'outcome', 'provider', 'provider_code', 'version']);
    expect(event).toMatchObject({ version: 1, provider: 'cloudflare', outcome: 'rejected', http_status: 403, provider_code: 10102 });
    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Date(event.occurred_at).toISOString()).toBe(event.occurred_at);
    const expected = createHmac('sha256', secret).update(['POST', '/v1/email', timestamp,
      createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
    expect(headers.get('x-vp-observation-signature')).toBe(expected);
    for (const value of [secret, message.to, message.subject, message.text, 'private_cookie', accepted.id]) expect(raw).not.toContain(value);
    return Response.json({ recorded: true });
  }) as typeof fetch, event => lost.push(event))({ provider: 'cloudflare', outcome: 'rejected', http_status: 403, provider_code: 10102,
    email: message.to, otp: message.text, cookie: 'private_cookie', provider_id: accepted.id } as never);
  expect(calls).toBe(1);
  expect(lost).toEqual([]);
});

test('invalid or missing capture configuration never guesses a provider, fetches or exposes a secret', async () => {
  const lost: EmailObservationLost[] = []; let calls = 0;
  const transport = (async () => { calls++; throw new Error('Must not fetch'); }) as unknown as typeof fetch;
  for (const value of [undefined, '', 'short', 'x'.repeat(4097), `${secret}\r\nprivate`]) {
    await createEmailObserver({ ...enabled, AUTH_BFF_SHARED_SECRET: value }, transport,
      event => lost.push(event))({ provider: 'resend', outcome: 'unknown' });
  }
  await createEmailObserver(enabled, transport, event => lost.push(event))({ provider: null, outcome: 'configuration' });
  expect(calls).toBe(0);
  expect(lost).toEqual([...Array.from({ length: 5 }, (): EmailObservationLost => ({ event: 'auth_email_observation_lost', reason: 'configuration' })),
    { event: 'auth_email_observation_lost', reason: 'invalid_provider' }]);
});

test('only a bounded, strict HTTP200 JSON acknowledgement counts as recorded; no retries on rejection', async () => {
  for (const response of [Response.json({ recorded: false }), Response.json({ recorded: true, private: message.to }),
    Response.json({ recorded: true }, { status: 202 }), Response.json({ recorded: true }, { status: 503 }),
    new Response('{"recorded":true}', { headers: { 'content-type': 'text/plain' } }),
    new Response('malformed private body', { headers: { 'content-type': 'application/json' } }),
    new Response(' '.repeat(129), { headers: { 'content-type': 'application/json' } }),
    new Response('{"recorded":true}', { headers: { 'content-type': 'application/json', 'content-length': '129' } }),
    new Response('{"recorded":true}', { headers: { 'content-type': 'application/json', 'content-length': 'invalid' } })]) {
    const lost: EmailObservationLost[] = []; let calls = 0;
    await createEmailObserver(enabled, (async () => { calls++; return response; }) as unknown as typeof fetch,
      event => lost.push(event))({ provider: 'resend', outcome: 'accepted' });
    expect(calls).toBe(1);
    expect(lost).toEqual([{ event: 'auth_email_observation_lost', reason: 'invalid_ack' }]);
  }
});

test('the 500ms deadline covers a stalled transport and a stalled acknowledgement body', async () => {
  for (const mode of ['transport', 'body']) {
    let signal: AbortSignal | undefined; let calls = 0;
    const lost: EmailObservationLost[] = [];
    const started = performance.now();
    await createEmailObserver(enabled, (async (_url, request) => {
      calls++; signal = request?.signal as AbortSignal;
      if (mode === 'transport') return await new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start() { /* Intentionally never close. */ } }),
        { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch, event => lost.push(event))({ provider: 'resend', outcome: 'unknown' });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(EMAIL_OBSERVATION_TIMEOUT_MS - 20);
    expect(elapsed).toBeLessThan(EMAIL_OBSERVATION_TIMEOUT_MS + 350);
    expect(signal?.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(lost).toEqual([{ event: 'auth_email_observation_lost', reason: 'transport' }]);
  }
});

test('a failing private sink or failing lost-log sink cannot reject a provider-accepted OTP or resend it', async () => {
  for (const behavior of ['transport', 'bad_ack']) {
    let sends = 0; let observations = 0;
    await createAuthDelivery(resend, (async url => {
      if (url === EMAIL_OBSERVATION_URL) {
        observations++;
        if (behavior === 'transport') throw new Error(`private ${secret} ${message.to}`);
        return Response.json({ recorded: false });
      }
      expect(url).toBe('https://api.resend.com/emails'); sends++;
      return Response.json(accepted);
    }) as typeof fetch, () => {}).email(message);
    expect(sends).toBe(1); expect(observations).toBe(1);
  }
  await createEmailObserver(enabled, (async () => { throw new Error('private'); }) as unknown as typeof fetch,
    () => { throw new Error('private log failure'); })({ provider: 'resend', outcome: 'accepted' });
});

test('each email has one terminal observation and ambiguous provider outcomes are unknown, not definite rejection', async () => {
  const cases: { env: AuthEnvironment; response?: () => Response; outcome: EmailObservation['outcome']; rejected?: boolean }[] = [
    { env: resend, response: () => Response.json(accepted), outcome: 'accepted' },
    { env: resend, response: () => Response.json({ error: 'private' }, { status: 429 }), outcome: 'rejected', rejected: true },
    { env: resend, response: () => new Response('private', { status: 409 }), outcome: 'unknown', rejected: false },
    { env: resend, response: () => new Response('private', { status: 503 }), outcome: 'unknown', rejected: false },
    { env: resend, response: () => Response.json({ id: 'invalid' }), outcome: 'unknown', rejected: false },
    { env: resend, response: () => { throw new Error(`private ${message.text}`); }, outcome: 'unknown', rejected: false },
    { env: { ...resend, RESEND_API_KEY: undefined }, outcome: 'configuration', rejected: true },
    { env: cloudflare, response: () => Response.json({ success: true, errors: [], result: {
      delivered: [], queued: [message.to], permanent_bounces: [] } }), outcome: 'accepted' },
    { env: cloudflare, response: () => Response.json({ success: false, errors: [{ code: 10102, message: 'private' }] }, { status: 403 }), outcome: 'rejected', rejected: true },
    { env: cloudflare, response: () => Response.json({ success: false }, { status: 500 }), outcome: 'unknown', rejected: false },
    { env: cloudflare, response: () => Response.json({ success: true, errors: [], result: {
      delivered: [], queued: [], permanent_bounces: [message.to] } }), outcome: 'rejected', rejected: true },
    { env: cloudflare, response: () => Response.json({ success: true, errors: [], result: {
      delivered: [], queued: ['other@example.test'], permanent_bounces: [] } }), outcome: 'unknown', rejected: false },
  ];
  const ids = new Set<string>();
  for (const item of cases) {
    const observations: EmailObservation[] = []; let sends = 0; let caught: unknown;
    try {
      await createAuthDelivery(item.env, (async (url, request) => {
        if (url === EMAIL_OBSERVATION_URL) {
          observations.push(JSON.parse(request?.body as string)); return Response.json({ recorded: true });
        }
        sends++;
        if (!item.response) throw new Error('Unexpected provider request');
        return item.response();
      }) as typeof fetch, () => {}).email(message);
    } catch (error) { caught = error; }
    expect(sends).toBe(item.response ? 1 : 0);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ provider: item.env.AUTH_EMAIL_PROVIDER, outcome: item.outcome });
    expect(ids.has(observations[0]!.id)).toBe(false); ids.add(observations[0]!.id);
    if (item.rejected === undefined) expect(caught).toBeUndefined();
    else { expect(caught).toBeInstanceOf(AuthEmailDeliveryError); expect((caught as AuthEmailDeliveryError).confirmedRejected).toBe(item.rejected); }
    for (const value of [message.to, message.subject, message.text, secret, accepted.id, 'private']) expect(JSON.stringify(observations)).not.toContain(value);
  }
});

test('SMS paths never contribute email quota observations', async () => {
  let calls = 0;
  await expect(createAuthDelivery({ ...enabled }, (async () => { calls++; return Response.json({ recorded: true }); }) as unknown as typeof fetch,
    () => {}).phone('+12025550123', '012345')).rejects.toThrow('authentication_delivery_unavailable');
  expect(calls).toBe(0);
});

test('concurrent provider replies retain separate terminal outcomes and fresh observation IDs', async () => {
  const observations: EmailObservation[] = [];
  const complete: ((response: Response) => void)[] = [];
  const delivery = createAuthDelivery(resend, (async (url, request) => {
    if (url === EMAIL_OBSERVATION_URL) {
      observations.push(JSON.parse(request?.body as string)); return Response.json({ recorded: true });
    }
    return await new Promise<Response>(resolve => complete.push(resolve));
  }) as typeof fetch, () => {});
  const first = delivery.email(message);
  const second = delivery.email(message).catch(error => error);
  complete[1]!(new Response('private', { status: 503 }));
  complete[0]!(Response.json(accepted));
  await first;
  expect(await second).toBeInstanceOf(AuthEmailDeliveryError);
  expect(observations.map(value => value.outcome).sort()).toEqual(['accepted', 'unknown']);
  expect(new Set(observations.map(value => value.id)).size).toBe(2);
});
