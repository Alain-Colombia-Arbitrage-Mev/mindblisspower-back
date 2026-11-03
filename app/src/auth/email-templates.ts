import { z } from 'zod';
import type { EmailMessage } from './delivery';

export const AUTH_OTP_LENGTH = 6;
export const AUTH_OTP_EXPIRES_IN_SECONDS = 300;
export const AUTH_OTP_PURPOSES = Object.freeze(['sign-in', 'email-verification', 'forget-password'] as const);
export type AuthOtpPurpose = typeof AUTH_OTP_PURPOSES[number];
export const AUTH_OTP_RESEND_ALIASES = Object.freeze({
  'sign-in': 'login-verification-code',
  'email-verification': 'account-verification',
  'forget-password': 'password-reset',
} as const);
export type AuthOtpHostedTemplate = {
  id: typeof AUTH_OTP_RESEND_ALIASES[AuthOtpPurpose];
  variables: { OTP: string };
};

export const AUTH_OTP_TEMPLATES = Object.freeze({
  'sign-in': Object.freeze({
    id: 'sign-in',
    name: AUTH_OTP_RESEND_ALIASES['sign-in'],
    subject: 'Tu código de acceso | Mindbliss Power',
    title: 'Tu código de acceso',
    intro: 'Recibimos una solicitud para iniciar sesión en Mindbliss Power.',
    instruction: 'Regresa a la pantalla donde solicitaste el código e introdúcelo para iniciar sesión.',
  }),
  'email-verification': Object.freeze({
    id: 'email-verification',
    name: AUTH_OTP_RESEND_ALIASES['email-verification'],
    subject: 'Verifica tu correo | Mindbliss Power',
    title: 'Verifica tu correo',
    intro: 'Recibimos una solicitud para verificar tu correo en Mindbliss Power.',
    instruction: 'Regresa a la pantalla donde solicitaste el código e introdúcelo para completar la verificación.',
  }),
  'forget-password': Object.freeze({
    id: 'forget-password',
    name: AUTH_OTP_RESEND_ALIASES['forget-password'],
    subject: 'Código para restablecer tu contraseña | Mindbliss Power',
    title: 'Crea una nueva contraseña',
    intro: 'Recibimos una solicitud para crear o restablecer tu contraseña de Mindbliss Power.',
    instruction: 'Regresa a la pantalla donde solicitaste el código e introdúcelo para continuar con tu nueva contraseña.',
  }),
} as const);

type AuthOtpTemplate = typeof AUTH_OTP_TEMPLATES[AuthOtpPurpose];
const resendOtpVariable = '{{{OTP}}}';
const expiry = `Este código vence en ${AUTH_OTP_EXPIRES_IN_SECONDS / 60} minutos y sólo puede usarse una vez.`;
const security = 'Nunca compartas este código. El equipo de Mindbliss Power nunca te lo pedirá.';
const unsolicited = 'Si no solicitaste este código, ignora este mensaje. No necesitas realizar ninguna acción.';
const invalidMessage = () => new TypeError('authentication_email_message_invalid');

function templateFor(type: string): AuthOtpTemplate {
  if (typeof type !== 'string' || !Object.hasOwn(AUTH_OTP_TEMPLATES, type)) throw invalidMessage();
  return AUTH_OTP_TEMPLATES[type as AuthOtpPurpose];
}

// Only reviewed catalog text and either validated ASCII digits or the fixed
// provider variable reach this renderer. No account data is interpolated.
function render(template: AuthOtpTemplate, otp: string) {
  const text = [
    'Mindbliss Power', '', template.title, '', template.intro, '',
    `Tu código de un solo uso: ${otp}`, '', expiry, '', template.instruction, '', security, '', unsolicited,
  ].join('\n');
  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${template.title}</title></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;color:#131315;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f3f4f6;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:16px;">
        <tr><td style="padding:26px 28px;background-color:#0b0b0c;border-top:4px solid #ffc700;border-radius:16px 16px 0 0;">
          <p style="margin:0;color:#ffffff;font-size:25px;font-weight:700;line-height:1.3;">Mindbliss <span style="color:#ffc700;">Power</span></p>
          <p style="margin:8px 0 0;color:#d1d5db;font-size:11px;font-weight:700;line-height:1.5;letter-spacing:1.5px;">SEGURIDAD DE TU CUENTA</p>
        </td></tr>
        <tr><td style="padding:30px 24px 24px;">
          <h1 style="margin:0 0 16px;color:#131315;font-size:25px;font-weight:700;line-height:1.3;">${template.title}</h1>
          <p style="margin:0 0 24px;color:#374151;font-size:16px;line-height:1.6;">${template.intro}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#fffbea;border:1px solid #ffc700;border-radius:12px;">
            <tr><td align="center" style="padding:22px 12px;">
              <p style="margin:0 0 12px;color:#4b5563;font-size:11px;font-weight:700;line-height:1.5;letter-spacing:1px;">TU CÓDIGO DE UN SOLO USO</p>
              <p dir="ltr" style="margin:0;color:#131315;font-family:Arial,Helvetica,sans-serif;font-size:32px;font-weight:700;line-height:1.4;letter-spacing:6px;white-space:nowrap;">${otp}</p>
            </td></tr>
          </table>
          <p style="margin:16px 0 22px;color:#374151;font-size:14px;line-height:1.6;">${expiry}</p>
          <p style="margin:0;color:#374151;font-size:15px;line-height:1.6;">${template.instruction}</p>
        </td></tr>
        <tr><td style="padding:0 24px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-top:1px solid #e5e7eb;">
            <tr><td style="padding-top:22px;">
              <p style="margin:0 0 12px;color:#131315;font-size:13px;font-weight:700;line-height:1.6;">${security}</p>
              <p style="margin:0;color:#4b5563;font-size:13px;line-height:1.6;">${unsolicited}</p>
            </td></tr>
          </table>
        </td></tr>
      </table>
      <p style="margin:18px 0 0;color:#6b7280;font-size:12px;line-height:1.6;">Mindbliss Power · Mensaje automático de seguridad</p>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject: template.subject, text, html };
}

/** Build an OTP email without treating receipt as proof of verification. */
export function authOtpMessage(email: string, otp: string, type: string): EmailMessage {
  const template = templateFor(type);
  if (!z.email().safeParse(email).success || typeof otp !== 'string'
    || otp.length !== AUTH_OTP_LENGTH || !/^[0-9]+$/.test(otp)) throw invalidMessage();
  return { to: email, ...render(template, otp), template: { id: template.name, variables: { OTP: otp } } };
}

/** Export-only provider variable; it is never accepted as a runtime OTP. */
export function resendAuthTemplate(type: string) {
  const template = templateFor(type);
  const { subject, html } = render(template, resendOtpVariable);
  return { name: template.name, subject, html, variables: [{ key: 'OTP', type: 'string' }] as const };
}
