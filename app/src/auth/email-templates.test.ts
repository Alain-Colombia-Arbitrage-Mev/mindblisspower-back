import { expect, test } from 'bun:test';
import { AUTH_OTP_EXPIRES_IN_SECONDS, AUTH_OTP_LENGTH, AUTH_OTP_PURPOSES, AUTH_OTP_RESEND_ALIASES, AUTH_OTP_TEMPLATES,
  authOtpMessage, resendAuthTemplate } from './email-templates';

const recipient = 'synthetic-template-member@example.test';
const code = '012345';

test('OTP template catalog exposes only the three existing native purposes and shared policy constants', () => {
  expect(AUTH_OTP_LENGTH).toBe(6);
  expect(AUTH_OTP_EXPIRES_IN_SECONDS).toBe(300);
  expect(AUTH_OTP_PURPOSES).toEqual(['sign-in', 'email-verification', 'forget-password']);
  expect(Object.keys(AUTH_OTP_TEMPLATES)).toEqual([...AUTH_OTP_PURPOSES]);
  expect(Object.isFrozen(AUTH_OTP_PURPOSES)).toBe(true);
  expect(Object.isFrozen(AUTH_OTP_TEMPLATES)).toBe(true);
  expect(Object.isFrozen(AUTH_OTP_RESEND_ALIASES)).toBe(true);
  expect(AUTH_OTP_RESEND_ALIASES).toEqual({ 'sign-in': 'login-verification-code',
    'email-verification': 'account-verification', 'forget-password': 'password-reset' });
  expect(new Set(AUTH_OTP_PURPOSES.map(type => AUTH_OTP_TEMPLATES[type].subject)).size).toBe(3);
});

for (const purpose of AUTH_OTP_PURPOSES) {
  test(`${purpose} has matching plain text and branded HTML with one leading-zero code`, () => {
    const metadata = AUTH_OTP_TEMPLATES[purpose];
    const message = authOtpMessage(recipient, code, purpose);
    expect(message.to).toBe(recipient);
    expect(message.subject).toBe(metadata.subject);
    expect(message.subject).toContain('Mindbliss Power');
    expect(message.subject).not.toContain(code);
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(metadata.id).toBe(purpose);
    expect(message.template).toEqual({ id: AUTH_OTP_RESEND_ALIASES[purpose], variables: { OTP: code } });
    for (const body of [message.text, message.html!]) {
      for (const text of [metadata.title, metadata.intro, metadata.instruction, code, '5 minutos',
        'sólo puede usarse una vez', 'Nunca compartas este código', 'nunca te lo pedirá',
        'Si no solicitaste este código, ignora este mensaje']) expect(body).toContain(text);
      expect(body.replace(/<[^>]*>/g, '').match(/[0-9]{6}/g)).toEqual([code]);
      expect(body).not.toContain(recipient);
      expect(body).not.toMatch(/correo (?:ya )?(?:ha sido |está )?verificado|cuenta (?:ya )?(?:ha sido |está )?verificada/i);
      expect(body).not.toMatch(/\b(?:ROI|inversi[oó]n|rendimiento|comisiones|retir[oa]s?)\b/i);
    }
    expect(message.html).toContain('lang="es"');
    expect(message.html).toContain('role="presentation"');
    expect(message.html).toContain('width:100%;max-width:560px');
    expect(message.html).toContain('background-color:#ffffff');
    expect(message.html).toContain('background-color:#0b0b0c');
    expect(message.html).toContain('color:#ffc700');
    expect(message.html).toContain('color:#131315');
    expect(message.html).toContain('font-family:Arial,Helvetica,sans-serif');
    expect(message.html).not.toMatch(/<(?:script|img|link|iframe|form)\b|(?:src|href)\s*=|@import|url\s*\(/i);
    expect(message.html).not.toMatch(/https?:\/\/|data:|javascript:|\u200b|\u200c|\u200d/i);
    expect(message.html?.match(/<title>([^<]+)<\/title>/)?.[1]).not.toContain(code);
  });

  test(`${purpose} Resend export uses the exact runtime renderer and only its required OTP variable`, () => {
    const exported = resendAuthTemplate(purpose);
    const message = authOtpMessage(recipient, code, purpose);
    expect(exported.name).toBe(AUTH_OTP_TEMPLATES[purpose].name);
    expect(message.subject).toBe(exported.subject);
    expect(exported.variables).toEqual([{ key: 'OTP', type: 'string' }]);
    expect(Object.keys(exported)).toEqual(['name', 'subject', 'html', 'variables']);
    expect(exported.html.match(/\{\{\{OTP\}\}\}/g)).toEqual(['{{{OTP}}}']);
    expect(exported.html.replace('{{{OTP}}}', code)).toBe(message.html!);
    expect(exported.html).not.toContain(code);
    expect(exported).not.toHaveProperty('fallbackValue');
    expect(exported.variables[0]).not.toHaveProperty('fallbackValue');
  });
}

test('password recovery keeps its recognizable lowercase restablecer subject', () => {
  expect(authOtpMessage(recipient, code, 'forget-password').subject).toContain('restablecer');
});

test('runtime OTP renderer rejects injection, whitespace, non-ASCII digits, incorrect lengths and non-string codes', () => {
  const invalid = ['', '12345', '1234567', '123456\n', '12345\n', ' 123456', '123456 ',
    '<script>alert(1)</script>', '123<script>', '12&345', '１２３４５６', '١٢٣٤٥٦',
    '12\u200b345', '{{{OTP}}}', undefined, null, 123456, 12345, {}, ['123456'],
    { toString: () => '123456' }];
  for (const value of invalid) {
    expect(() => authOtpMessage(recipient, value as string, 'sign-in')).toThrow('authentication_email_message_invalid');
  }
  expect(authOtpMessage(recipient, '000000', 'sign-in').text).toContain('000000');
});

test('runtime and export renderer fail closed on unsupported, inherited or non-string purposes', () => {
  for (const value of ['change-email', '', 'Sign-in', 'sign-in ', '<script>', '__proto__', 'constructor',
    'toString', undefined, null, {}, ['sign-in'], { toString: () => 'sign-in' }]) {
    expect(() => authOtpMessage(recipient, code, value as string)).toThrow('authentication_email_message_invalid');
    expect(() => resendAuthTemplate(value as string)).toThrow('authentication_email_message_invalid');
  }
});

test('recipient metadata is validated but never reflected into the email body or errors', () => {
  for (const value of ['invalid', 'member@example.test\r\nBcc: other@example.test', '<script>@example.test',
    undefined, null, {}, ['member@example.test']]) {
    let error: unknown;
    try { authOtpMessage(value as string, code, 'email-verification'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('authentication_email_message_invalid');
  }
  const changedRecipient = 'another-synthetic-member+otp@example.test';
  const first = authOtpMessage(recipient, code, 'sign-in');
  const second = authOtpMessage(changedRecipient, code, 'sign-in');
  expect(first.text).toBe(second.text);
  expect(first.html).toBe(second.html);
  expect(first.subject).toBe(second.subject);
  expect(second.to).toBe(changedRecipient);
});
