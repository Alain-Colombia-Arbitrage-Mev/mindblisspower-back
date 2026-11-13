import { expect, test } from 'bun:test';
import { readAdministrativeRequestBody } from './administrative-request-body';

test('bounded administrative bodies preserve the original UTF8 text used by the native HMAC', async () => {
  const raw = ' {"message":"prueba-é"} \n';
  expect(await readAdministrativeRequestBody(new Request('https://wallet.example.invalid', { method: 'POST', body: raw }))).toBe(raw);
});
test('absent or false content-length cannot bypass the actual2048byte bound', async () => {
  const cases: Record<string, string>[] = [{}, { 'content-length': '1' }];
  for (const headers of cases) {
    await expect(readAdministrativeRequestBody(new Request('https://wallet.example.invalid', { method: 'POST', body: 'x'.repeat(2049), headers }))).rejects.toThrow('request_too_large');
  }
  await expect(readAdministrativeRequestBody(new Request('https://wallet.example.invalid', { method: 'POST', body: '{}', headers: { 'content-length': '9999999' } }))).rejects.toThrow('request_too_large');
});
test('an endless native stream is cancelled on its own deadline before the HMAC or business functions execute', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
  await expect(readAdministrativeRequestBody(new Request('https://wallet.example.invalid', { method: 'POST', body: stream }), 5)).rejects.toThrow('administrative_request_body_unavailable');
  expect(cancelled).toBe(true);
});
