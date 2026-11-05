import { expect, spyOn, test } from 'bun:test';
import { AuthEmailDeliveryError, authEmailConfigured, authEmailProvider, cloudflareEmailConfigured, createAuthDelivery,
  resendEmailConfigured, type AuthEnvironment, type EmailDeliveryDiagnostic, type EmailMessage } from './delivery';
import { createAuthOptions } from './options';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { AUTH_OTP_PURPOSES, AUTH_OTP_RESEND_ALIASES, authOtpMessage } from './email-templates';

// Synthetic provider transport only; this fetch never opens a socket.
const env: AuthEnvironment = { AUTH_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_synthetic_not_real', AUTH_EMAIL_FROM: 'auth@example.test' };
const message = { to: 'resend-member@example.test', subject: 'Synthetic recovery', text: 'Synthetic code 123456', html: '<p>Synthetic code 123456</p>' };
const accepted = { id: '00000000-0000-4000-8000-000000000071' };
const noReport = () => {};
async function failure(response: Response | (() => never), outgoing: EmailMessage = message) {
  let calls = 0;
  const events: EmailDeliveryDiagnostic[] = [];
  const delivery = createAuthDelivery(env, (async url => {
    calls++;
    expect(url).toBe('https://api.resend.com/emails');
    return typeof response === 'function' ? response() : response;
  }) as typeof fetch, event => events.push(event));
  let error: unknown;
  try { await delivery.email(outgoing); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AuthEmailDeliveryError);
  expect((error as Error).message).toBe('authentication_delivery_unavailable');
  expect(calls).toBe(1);
  return { error: error as AuthEmailDeliveryError, events };
}

test('Resend uses a single fixed REST send with the reviewed payload and eight-second abortable transport', async () => {
  let calls = 0;
  const events: EmailDeliveryDiagnostic[] = [];
  const signal = new AbortController().signal;
  const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
  const delivery = createAuthDelivery(env, (async (url, request) => {
    calls++;
    expect(url).toBe('https://api.resend.com/emails');
    expect(request?.method).toBe('POST');
    expect(request?.redirect).toBe('error');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.signal).toBe(signal);
    expect(request?.signal?.aborted).toBe(false);
    expect(request?.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` });
    expect(JSON.parse(request?.body as string)).toEqual({ ...message, from: env.AUTH_EMAIL_FROM, to: [message.to] });
    return Response.json(accepted);
  }) as typeof fetch, event => events.push(event));
  try {
    await delivery.email(message);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(8000);
    expect(calls).toBe(1);
    expect(events).toEqual([{ event: 'auth_email_delivery', outcome: 'accepted', httpStatus: 200, queued: true }]);
    expect(JSON.stringify(events)).not.toContain(accepted.id);
  } finally {
    timeout.mockRestore();
  }
});

test('Resend native OTP uses only its reviewed hosted alias and variables, never local HTML or text', async () => {
  for (const purpose of AUTH_OTP_PURPOSES) {
    const outgoing = authOtpMessage(message.to, '012345', purpose);
    for (const key of ['html', 'text']) Object.defineProperty(outgoing, key, {
      get() { throw new Error('Hosted OTP tried to read an alternate message body'); },
    });
    let calls = 0;
    const events: EmailDeliveryDiagnostic[] = [];
    await createAuthDelivery(env, (async (url, request) => {
      calls++;
      expect(url).toBe('https://api.resend.com/emails');
      const body = JSON.parse(request?.body as string);
      expect(body).toEqual({ from: env.AUTH_EMAIL_FROM, to: [message.to], subject: outgoing.subject,
        template: { id: AUTH_OTP_RESEND_ALIASES[purpose], variables: { OTP: '012345' } } });
      for (const key of ['html', 'text', 'react', 'headers', 'tags']) expect(body).not.toHaveProperty(key);
      return Response.json(accepted);
    }) as typeof fetch, event => events.push(event)).email(outgoing);
    expect(calls).toBe(1);
    expect(events).toEqual([{ event: 'auth_email_delivery', outcome: 'accepted', httpStatus: 200, queued: true }]);
    for (const value of ['012345', message.to, AUTH_OTP_RESEND_ALIASES[purpose]]) expect(JSON.stringify(events)).not.toContain(value);
  }
});

test('Resend rejects arbitrary hosted aliases, unexpected fields and invalid OTP variables before any provider request', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return Response.json(accepted); }) as unknown as typeof fetch;
  const approved = { id: 'login-verification-code', variables: { OTP: '012345' } };
  for (const template of [null, '', [], {}, { id: 'unapproved-template', variables: { OTP: '012345' } },
    { id: 'https://attacker.example.test', variables: { OTP: '012345' } }, { ...approved, id: 'Login-verification-code' },
    { ...approved, id: 'login-verification-code ' }, { ...approved, id: accepted.id },
    { ...approved, html: '<p>injected</p>' }, { ...approved, variables: {} },
    { ...approved, variables: { OTP: '012345', EMAIL: message.to } },
    ...[null, 123456, '12345', '1234567', '123456\n', '12345\n', '１２３４５６', '١٢٣٤٥٦', '{{{OTP}}}', '<script>',
      { toString: () => '012345' }].map(OTP => ({ ...approved, variables: { OTP } })),
  ]) {
    const events: EmailDeliveryDiagnostic[] = [];
    let caught: unknown;
    try { await createAuthDelivery(env, fetchImpl, event => events.push(event)).email({ ...message,
      template: template as unknown as EmailMessage['template'] }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AuthEmailDeliveryError);
    expect((caught as AuthEmailDeliveryError).confirmedRejected).toBe(true);
    expect((caught as Error).message).toBe('authentication_delivery_unavailable');
    expect(events).toEqual([{ event: 'auth_email_delivery', outcome: 'configuration' }]);
  }
  const throwing = { ...message };
  Object.defineProperty(throwing, 'template', { get() { throw new Error('private code 012345'); } });
  await expect(createAuthDelivery(env, fetchImpl, noReport).email(throwing)).rejects.toThrow('authentication_delivery_unavailable');
  expect(calls).toBe(0);
});

test('Resend rejects unknown, incomplete or malformed configuration before sending and never selects another provider', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return Response.json(accepted); }) as unknown as typeof fetch;
  expect(resendEmailConfigured(env)).toBe(true);
  expect(authEmailConfigured(env)).toBe(true);
  for (const configuration of [
    { ...env, AUTH_EMAIL_PROVIDER: '' }, { ...env, AUTH_EMAIL_PROVIDER: 'Resend' }, { ...env, AUTH_EMAIL_PROVIDER: 'resend ' },
    { ...env, AUTH_EMAIL_PROVIDER: 'brevo' }, { ...env, AUTH_EMAIL_PROVIDER: 'https://attacker.example.test' },
    { ...env, AUTH_EMAIL_PROVIDER: {} as unknown as string }, { ...env, AUTH_EMAIL_PROVIDER: null as unknown as string },
    { ...env, RESEND_API_KEY: undefined }, { ...env, RESEND_API_KEY: '' }, { ...env, RESEND_API_KEY: ' ' },
    { ...env, RESEND_API_KEY: 're_synthetic\r\ninjected' }, { ...env, RESEND_API_KEY: 'x'.repeat(4097) },
    { ...env, RESEND_API_KEY: {} as unknown as string }, { ...env, AUTH_EMAIL_FROM: 'invalid' },
  ]) {
    expect(authEmailConfigured(configuration)).toBe(false);
    await expect(createAuthDelivery(configuration, fetchImpl, noReport).email(message)).rejects.toThrow('authentication_delivery_unavailable');
  }
  await expect(createAuthDelivery(env, fetchImpl, noReport).email({ ...message, to: 'invalid' })).rejects.toThrow('authentication_delivery_unavailable');
  expect(calls).toBe(0);
});

test('only undefined defaults to Cloudflare; configured Resend never reads dormant Cloudflare, Brevo or SMS secrets', async () => {
  const resend: AuthEnvironment = { ...env };
  for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN', 'BREVO_API_KEY', 'SENTDM_API_KEY']) {
    Object.defineProperty(resend, key, { get() { throw new Error('Inactive provider credential accessed'); } });
  }
  expect(authEmailProvider({})).toBe('cloudflare');
  expect(authEmailProvider({ AUTH_EMAIL_PROVIDER: 'cloudflare' })).toBe('cloudflare');
  expect(authEmailConfigured(resend)).toBe(true);
  await createAuthDelivery(resend, (async () => Response.json(accepted)) as unknown as typeof fetch, noReport).email(message);
  for (const provider of [undefined, 'cloudflare']) {
    const cloudflare: AuthEnvironment = { AUTH_EMAIL_PROVIDER: provider, AUTH_EMAIL_FROM: 'auth@example.test',
      CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-cloudflare' };
    for (const key of ['RESEND_API_KEY', 'BREVO_API_KEY', 'SENTDM_API_KEY']) {
      Object.defineProperty(cloudflare, key, { get() { throw new Error('Inactive provider credential accessed'); } });
    }
    expect(cloudflareEmailConfigured(cloudflare)).toBe(true);
    expect(authEmailConfigured(cloudflare)).toBe(true);
    await createAuthDelivery(cloudflare, (async url => {
      expect(String(url)).toContain('https://api.cloudflare.com/client/v4/accounts/');
      return Response.json({ success: true, errors: [], result: { delivered: [], queued: [message.to], permanent_bounces: [] } });
    }) as typeof fetch, noReport).email(message);
  }
});

test('Resend requires exactly the documented UUID JSON acknowledgement at HTTP200', async () => {
  for (const body of [{}, { id: '' }, { id: 'not-an-email-id' }, { id: 71 }, null, [],
    { ...accepted, success: false }, { ...accepted, error: 'private' }, { data: accepted },
    { success: true, result: { delivered: [message.to] } }]) {
    const result = await failure(Response.json(body));
    expect(result.error.confirmedRejected).toBe(false);
    expect(result.events).toEqual([{ event: 'auth_email_delivery', outcome: 'invalid_response', httpStatus: 200 }]);
  }
  for (const status of [201, 202, 206]) expect((await failure(Response.json(accepted, { status }))).error.confirmedRejected).toBe(false);
  expect((await failure(new Response(JSON.stringify(accepted), { headers: { 'content-type': 'text/plain' } }))).error.confirmedRejected).toBe(false);
  expect((await failure(new Response('malformed acknowledgement'))).error.confirmedRejected).toBe(false);
  expect((await failure(Response.json({ ...accepted, error: 'private' }), authOtpMessage(message.to, '012345', 'sign-in'))).error.confirmedRejected).toBe(false);
});

test('Resend documented rejection statuses invalidate their challenge but ambiguous failures never imply safe retry', async () => {
  for (const status of [400, 401, 403, 404, 405, 422, 429]) {
    for (const response of [Response.json({ name: 'private_error', message: 'private destination code 123456' }, { status }),
      new Response('private malformed rejection', { status })]) {
      const result = await failure(response);
      expect(result.error.confirmedRejected).toBe(true);
      expect(result.events).toEqual([{ event: 'auth_email_delivery', outcome: 'rejected', httpStatus: status }]);
    }
  }
  for (const status of [408, 409, 500, 502, 503]) expect((await failure(Response.json({ message: 'private' }, { status }))).error.confirmedRejected).toBe(false);
  for (const error of [new Error('private provider token destination code 123456'), new DOMException('private timeout', 'AbortError')]) {
    const result = await failure(() => { throw error; });
    expect(result.error.confirmedRejected).toBe(false);
    expect(result.events).toEqual([{ event: 'auth_email_delivery', outcome: 'transport' }]);
  }
});

test('Resend diagnostics never expose provider payloads, IDs, recipients, credentials or OTPs', async () => {
  const events: EmailDeliveryDiagnostic[] = [];
  const privateText = `${message.to} ${message.text} ${env.RESEND_API_KEY} ${accepted.id}`;
  const delivery = createAuthDelivery(env, (async () => Response.json({ name: privateText, message: privateText, statusCode: 403 }, { status: 403 })) as unknown as typeof fetch,
    event => events.push(event));
  await expect(delivery.email(message)).rejects.toThrow('authentication_delivery_unavailable');
  const logged = JSON.stringify(events);
  for (const value of [message.to, '123456', env.RESEND_API_KEY!, accepted.id, 'private']) expect(logged).not.toContain(value);
  await createAuthDelivery(env, (async () => Response.json(accepted)) as unknown as typeof fetch,
    () => { throw new Error('Synthetic diagnostics sink unavailable'); }).email(message);
});

test('auth startup validates the selected email provider only and disabled email never reads provider credentials', () => {
  const base: AuthEnvironment = { BETTER_AUTH_SECRET: 'synthetic-provider-startup-secret-at-least-32-characters',
    BETTER_AUTH_URL: 'https://auth.example.test', BETTER_AUTH_TRUSTED_ORIGINS: 'https://portal.example.test',
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'true', BETTER_AUTH_PHONE_OTP_ENABLED: 'false', BETTER_AUTH_JWT_ENABLED: 'false' };
  const database = memoryAdapter({ user: [], account: [], session: [], verification: [], rateLimit: [] });
  const identity = { provision: async () => ({ status: 'claim_required' }), binding: async () => ({ status: 'claim_required' }) };
  const resend = { ...base, ...env };
  Object.defineProperty(resend, 'CLOUDFLARE_EMAIL_API_TOKEN', { get() { throw new Error('Inactive Cloudflare key accessed'); } });
  expect(() => createAuthOptions(resend, database, identity)).not.toThrow();
  for (const configuration of [{ ...base }, { ...base, ...env, RESEND_API_KEY: '' }, { ...base, ...env, AUTH_EMAIL_PROVIDER: 'other' }]) {
    expect(() => createAuthOptions(configuration, database, identity)).toThrow('Email authentication delivery is not configured');
  }
  const disabled: AuthEnvironment = { ...base, BETTER_AUTH_EMAIL_OTP_ENABLED: 'false' };
  for (const key of ['AUTH_EMAIL_PROVIDER', 'RESEND_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN', 'AUTH_EMAIL_FROM']) {
    Object.defineProperty(disabled, key, { get() { throw new Error('Disabled provider configuration accessed'); } });
  }
  expect(() => createAuthOptions(disabled, database, identity)).not.toThrow();
});
