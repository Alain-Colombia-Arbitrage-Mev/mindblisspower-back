import { expect, test } from 'bun:test';
import { createAuthDelivery } from './delivery';

const configuration = { SENTDM_API_KEY: 'synthetic-key', SENTDM_OTP_TEMPLATE_ID: '00000000-0000-4000-8000-000000000001', SENTDM_OTP_CHANNEL: 'whatsapp' };
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
