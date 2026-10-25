import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type AuthEnvironment = Record<string, string | undefined>;
export type EmailMessage = { to: string; subject: string; text: string; html?: string };
export type AuthDelivery = { email: (message: EmailMessage) => Promise<void>; phone: (phone: string, code: string) => Promise<void> };
export const validPhone = (phone: string) => /^\+[1-9][0-9]{7,14}$/.test(phone);
const uuid = z.uuid();
const unavailable = () => new Error('authentication_delivery_unavailable');

// Fixed HTTPS destinations: never accept an upstream URL or retry a send from
// request input. Provider bodies/errors may contain OTPs and must not escape.
export function createAuthDelivery(env: AuthEnvironment, fetchImpl: typeof fetch = globalThis.fetch): AuthDelivery {
  async function post(url: string, headers: Record<string, string>, body: unknown) {
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw unavailable();
      const data = await response.json();
      return data;
    } catch { throw unavailable(); }
  }
  return {
    async email(message) {
      if (!env.RESEND_API_KEY || !z.email().safeParse(env.AUTH_EMAIL_FROM).success || !z.email().safeParse(message.to).success) throw unavailable();
      const result = await post('https://api.resend.com/emails', { authorization: `Bearer ${env.RESEND_API_KEY}`, 'Idempotency-Key': randomUUID() },
        { from: env.AUTH_EMAIL_FROM, to: [message.to], subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) });
      if (!z.object({ id: z.string().min(1) }).safeParse(result).success) throw unavailable();
    },
    async phone(phone, code) {
      if (!env.SENTDM_API_KEY || !uuid.safeParse(env.SENTDM_OTP_TEMPLATE_ID).success || !validPhone(phone)
        || !/^\d{6}$/.test(code) || !['sms', 'whatsapp'].includes(env.SENTDM_OTP_CHANNEL || '')
        || (env.SENTDM_PROFILE_ID && !uuid.safeParse(env.SENTDM_PROFILE_ID).success)) throw unavailable();
      const parameter = env.SENTDM_OTP_PARAMETER || 'code';
      if (!/^[a-zA-Z0-9_]{1,64}$/.test(parameter)) throw unavailable();
      const result = await post('https://api.sent.dm/v3/messages', { 'x-api-key': env.SENTDM_API_KEY,
        'Idempotency-Key': randomUUID(), ...(env.SENTDM_PROFILE_ID ? { 'x-profile-id': env.SENTDM_PROFILE_ID } : {}) },
      { to: [phone], channel: [env.SENTDM_OTP_CHANNEL], template: { id: env.SENTDM_OTP_TEMPLATE_ID, parameters: { [parameter]: code } } });
      if (!z.object({ success: z.literal(true), data: z.object({ status: z.literal('QUEUED'),
        recipients: z.array(z.object({ message_id: z.string().min(1) })).length(1) }) }).safeParse(result).success) throw unavailable();
      // QUEUED means accepted, never verified/delivered. Only redeeming the OTP
      // can prove possession; blocked asynchronous messages cannot create auth.
    },
  };
}

export function authActionMessage(env: AuthEnvironment, email: string, url: string, reset: boolean): EmailMessage {
  let link: URL;
  try { link = new URL(url); } catch { throw unavailable(); }
  const origins = [env.BETTER_AUTH_URL, ...(env.BETTER_AUTH_TRUSTED_ORIGINS || '').split(',')]
    .filter(Boolean).map(value => new URL(value!.trim()).origin);
  if (!origins.includes(link.origin) || !['https:', 'http:'].includes(link.protocol) || link.username || link.password
    || (link.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(link.hostname))) throw unavailable();
  return { to: email, subject: reset ? 'Restablece tu contraseña de Mindbliss Power' : 'Verifica tu correo de Mindbliss Power',
    text: `${reset ? 'Restablece tu contraseña' : 'Verifica tu correo'} usando este enlace: ${link.href}` };
}
