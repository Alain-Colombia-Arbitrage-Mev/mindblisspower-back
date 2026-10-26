import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type AuthEnvironment = Record<string, string | undefined>;
export type EmailMessage = { to: string; subject: string; text: string; html?: string };
export type AuthDelivery = { email: (message: EmailMessage) => Promise<void>; phone: (phone: string, code: string) => Promise<void> };
export const validPhone = (phone: string) => /^\+[1-9][0-9]{7,14}$/.test(phone);
const uuid = z.uuid();
const unavailable = () => new Error('authentication_delivery_unavailable');
export const cloudflareEmailConfigured = (env: AuthEnvironment) => Boolean(env.CLOUDFLARE_EMAIL_API_TOKEN?.trim()
  && !/\s/.test(env.CLOUDFLARE_EMAIL_API_TOKEN) && /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')
  && z.email().safeParse(env.AUTH_EMAIL_FROM).success);
export const smsDeliveryConfigured = (env: AuthEnvironment) => Boolean(env.SENTDM_API_KEY?.trim()
  && !/\s/.test(env.SENTDM_API_KEY) && uuid.safeParse(env.SENTDM_OTP_TEMPLATE_ID).success
  && env.SENTDM_OTP_CHANNEL === 'sms' && (!env.SENTDM_PROFILE_ID || uuid.safeParse(env.SENTDM_PROFILE_ID).success)
  && /^[a-zA-Z0-9_]{1,64}$/.test(env.SENTDM_OTP_PARAMETER || 'code'));
const emailResult = z.object({ success: z.literal(true), errors: z.array(z.unknown()).length(0), result: z.object({
  delivered: z.array(z.email()), queued: z.array(z.email()), permanent_bounces: z.array(z.email()).length(0),
  suppressed_recipients: z.array(z.email()).length(0).optional(),
}) });

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
      if (!cloudflareEmailConfigured(env) || !z.email().safeParse(message.to).success) throw unavailable();
      const response = await post(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`,
        { authorization: `Bearer ${env.CLOUDFLARE_EMAIL_API_TOKEN}` },
        { from: env.AUTH_EMAIL_FROM, to: [message.to], subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) });
      const result = emailResult.safeParse(response);
      if (!result.success) throw unavailable();
      const accepted = [...result.data.result.delivered, ...result.data.result.queued];
      if (accepted.length !== 1 || accepted[0]!.toLowerCase() !== message.to.toLowerCase()) throw unavailable();
      // Queued/SMTP acceptance is not inbox delivery or identity proof. There
      // is no undocumented idempotency header or automatic resend/fallback.
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
      const accepted = z.object({ success: z.literal(true), error: z.null().optional(), data: z.object({ status: z.literal('QUEUED'),
        template_id: uuid, recipients: z.array(z.object({ message_id: z.string().min(1).max(200),
          to: z.string().refine(validPhone), channel: z.enum(['sms', 'whatsapp']) })).length(1) }) }).safeParse(result);
      if (!accepted.success || accepted.data.data.template_id !== env.SENTDM_OTP_TEMPLATE_ID
        || accepted.data.data.recipients[0]!.to !== phone || accepted.data.data.recipients[0]!.channel !== env.SENTDM_OTP_CHANNEL) throw unavailable();
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
