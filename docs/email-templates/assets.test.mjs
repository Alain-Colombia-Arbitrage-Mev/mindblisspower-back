import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AUTH_OTP_PURPOSES, AUTH_OTP_EXPIRES_IN_SECONDS, authOtpMessage, resendAuthTemplate } from '../../app/src/auth/email-templates.ts';

const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));

test('exported catalog has exactly the three supported purposes and no OTP fallback', () => {
  assert.deepEqual(manifest.map(item => item.purpose), [...AUTH_OTP_PURPOSES]);
  for (const item of manifest) {
    const source = resendAuthTemplate(item.purpose);
    assert.equal(item.name, source.name);
    assert.equal(item.from, 'otp@mindblisspower.com');
    assert.equal(item.subject, source.subject);
    assert.equal(item.expiresInSeconds, AUTH_OTP_EXPIRES_IN_SECONDS);
    assert.deepEqual(item.variables, [{ key: 'OTP', type: 'string' }]);
  }
});

for (const item of manifest) test(`${item.name}: HTML and plain text exports match the runtime renderer`, async () => {
  assert.match(item.htmlFile, /^[a-z-]+\.html$/);
  assert.match(item.textFile, /^[a-z-]+\.txt$/);
  const html = (await readFile(new URL(item.htmlFile, import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trimEnd();
  const text = (await readFile(new URL(item.textFile, import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trimEnd();
  const template = resendAuthTemplate(item.purpose);
  const runtime = authOtpMessage('synthetic@example.test', '012345', item.purpose);
  assert.equal(html, template.html);
  assert.equal(text, runtime.text.replace('012345', '{{{OTP}}}'));
  assert.equal(html.replace('{{{OTP}}}', '012345'), runtime.html);
  assert.doesNotMatch(html, /<(?:script|img|link|iframe|form|style)\b|\b(?:href|src|onerror|onclick)\s*=|url\s*\(/i);
});

test('local preview has only sandboxed inline frames and a clearly fictional code', async () => {
  const html = await readFile(new URL('./preview.html', import.meta.url), 'utf8');
  assert.equal((html.match(/<iframe sandbox title=/g) || []).length, 3);
  assert.match(html, /código 012345 es ficticio/);
  assert.doesNotMatch(html, /<script\b|\bsrc\s*=|\bhref\s*=/i);
});
