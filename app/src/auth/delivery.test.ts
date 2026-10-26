import { expect, test } from 'bun:test';
import { cloudflareEmailConfigured, createAuthDelivery } from './delivery';

const configuration = { SENTDM_API_KEY: 'synthetic-key', SENTDM_OTP_TEMPLATE_ID: '00000000-0000-4000-8000-000000000001', SENTDM_OTP_CHANNEL: 'whatsapp' };
const emailConfiguration = { CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000001',
  CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-cloudflare-token', AUTH_EMAIL_FROM: 'auth@example.test' };
const emailMessage = { to: 'member@example.test', subject: 'Synthetic sign-in', text: 'Synthetic code 123456', html: '<p>Synthetic code 123456</p>' };
const acceptedEmail = { success: true, errors: [], result: { delivered: [], queued: [emailMessage.to], permanent_bounces: [] } };

test('Cloudflare email transport uses the account-scoped fixed REST API and checks delivered or queued recipient', async () => {
  let calls = 0;
  for (const status of ['delivered', 'queued']) {
    const delivery = createAuthDelivery(emailConfiguration, (async (url, request) => {
      calls++;
      expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${emailConfiguration.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`);
      expect(request?.method).toBe('POST');
      expect(request?.redirect).toBe('error');
      expect(request?.signal).toBeInstanceOf(AbortSignal);
      expect(request?.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer synthetic-cloudflare-token' });
      expect(JSON.parse(request?.body as string)).toEqual({ ...emailMessage, to: [emailMessage.to], from: emailConfiguration.AUTH_EMAIL_FROM });
      return Response.json({ success: true, errors: [], messages: [], result: {
        delivered: status === 'delivered' ? [emailMessage.to] : [], queued: status === 'queued' ? [emailMessage.to] : [], permanent_bounces: [],
        ...(status === 'delivered' ? { message_id: 'synthetic-message-id', suppressed_recipients: [] } : {}),
      } }); // Accept both documented shapes, with or without a message_id.
    }) as typeof fetch);
    await delivery.email(emailMessage);
  }
  expect(calls).toBe(2);
});

test('Cloudflare configuration fails closed before transport and never falls back to a Resend credential', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return Response.json(acceptedEmail); }) as unknown as typeof fetch;
  expect(cloudflareEmailConfigured(emailConfiguration)).toBe(true);
  for (const env of [{}, { RESEND_API_KEY: 'synthetic-old-provider', AUTH_EMAIL_FROM: 'auth@example.test' },
    { ...emailConfiguration, CLOUDFLARE_ACCOUNT_ID: '../other-account' },
    { ...emailConfiguration, CLOUDFLARE_EMAIL_API_TOKEN: ' ' }, { ...emailConfiguration, CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic\r\ninjected' },
    { ...emailConfiguration, AUTH_EMAIL_FROM: 'invalid' }]) {
    expect(cloudflareEmailConfigured(env)).toBe(false);
    await expect(createAuthDelivery(env, fetchImpl).email(emailMessage)).rejects.toThrow('authentication_delivery_unavailable');
  }
  await expect(createAuthDelivery(emailConfiguration, fetchImpl).email({ ...emailMessage, to: 'invalid' })).rejects.toThrow('authentication_delivery_unavailable');
  expect(calls).toBe(0);
});

test('Cloudflare HTTP success is not enough: reject malformed, bounced, suppressed or mismatched email results', async () => {
  const result = acceptedEmail.result;
  const invalid = [
    { id: 'old-provider-response' }, { ...acceptedEmail, success: false }, { ...acceptedEmail, errors: [{ message: 'private 123456' }] },
    { ...acceptedEmail, result: null }, { ...acceptedEmail, result: { ...result, queued: [] } },
    { ...acceptedEmail, result: { ...result, queued: ['other@example.test'] } },
    { ...acceptedEmail, result: { ...result, delivered: [emailMessage.to] } },
    { ...acceptedEmail, result: { ...result, permanent_bounces: [emailMessage.to] } },
    { ...acceptedEmail, result: { ...result, suppressed_recipients: [emailMessage.to] } },
  ];
  let calls = 0;
  for (const response of invalid) {
    const delivery = createAuthDelivery(emailConfiguration, (async () => { calls++; return Response.json(response); }) as unknown as typeof fetch);
    await expect(delivery.email(emailMessage)).rejects.toThrow('authentication_delivery_unavailable');
  }
  expect(calls).toBe(invalid.length);
});

test('Cloudflare errors, throttling, malformed JSON and timeouts stay generic with no automatic retry', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const delivery = createAuthDelivery(emailConfiguration, (async () => { calls++; return Response.json({ error: 'private 123456' }, { status }); }) as unknown as typeof fetch);
    await expect(delivery.email(emailMessage)).rejects.toThrow('authentication_delivery_unavailable');
    expect(calls).toBe(1);
  }
  await expect(createAuthDelivery(emailConfiguration, (async () => new Response('private 123456')) as unknown as typeof fetch).email(emailMessage)).rejects.toThrow('authentication_delivery_unavailable');
  await expect(createAuthDelivery(emailConfiguration, (async () => { throw new Error('private destination and token'); }) as unknown as typeof fetch).email(emailMessage)).rejects.toThrow('authentication_delivery_unavailable');
  await expect(createAuthDelivery(emailConfiguration, (async () => { throw new DOMException('private timeout response', 'AbortError'); }) as unknown as typeof fetch).email(emailMessage)).rejects.toThrow('authentication_delivery_unavailable');
});
test('Sent v3 transport pins an approved channel/template and never uses email or broadcast', async () => {
  let calls = 0;
  const delivery = createAuthDelivery(configuration, (async (url, request) => {
    calls++;
    expect(url).toBe('https://api.sent.dm/v3/messages');
    expect(request?.redirect).toBe('error');
    const headers = request?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('synthetic-key');
    const body = JSON.parse(request?.body as string);
    expect(body.channel).toEqual(['whatsapp']);
    expect(body.template.parameters.code).toBe('123456');
    return Response.json({ success: true, data: { status: 'QUEUED', recipients: [{ message_id: 'synthetic-id' }] } }, { status: 202 });
  }) as typeof fetch);
  await delivery.phone('+12025550123', '123456');
  expect(calls).toBe(1);
});

test('missing credentials and malformed provider success fail closed with no sensitive error details', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return Response.json({ error: 'private recipient +12025550123 and 123456' }); }) as unknown as typeof fetch;
  await expect(createAuthDelivery({}, fetchImpl).phone('+12025550123', '123456')).rejects.toThrow('authentication_delivery_unavailable');
  expect(calls).toBe(0);
  await expect(createAuthDelivery(configuration, fetchImpl).phone('+12025550123', '123456')).rejects.toThrow('authentication_delivery_unavailable');
  await expect(createAuthDelivery(configuration, (async () => { throw new Error('private 123456'); }) as unknown as typeof fetch).phone('+12025550123', '123456')).rejects.toThrow('authentication_delivery_unavailable');
});
