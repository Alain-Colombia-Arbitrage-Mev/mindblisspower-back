import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AUTH_OTP_LENGTH, AUTH_OTP_RESEND_ALIASES, type AuthOtpHostedTemplate } from './email-templates';
import { createEmailObserver } from './email-observation';
import { recordOtpTraceDelivery } from './otp-trace';

export type AuthEnvironment = Record<string, string | undefined>;
export type EmailMessage = { to: string; subject: string; text: string; html?: string; template?: AuthOtpHostedTemplate };
export type AuthDelivery = { email: (message: EmailMessage) => Promise<void>; phone: (phone: string, code: string) => Promise<void> };
export type EmailDeliveryDiagnostic = { event: 'auth_email_delivery'; outcome: 'configuration' | 'rejected' | 'transport' | 'invalid_response' | 'recipient_rejected' | 'accepted'; httpStatus?: number; providerCode?: number; queued?: boolean };
export type AuthEmailProvider = 'cloudflare' | 'resend';
type EmailDeliveryReporter = (diagnostic: EmailDeliveryDiagnostic) => void;
export class AuthEmailDeliveryError extends Error {
  constructor(readonly confirmedRejected: boolean) { super('authentication_delivery_unavailable'); this.name = 'AuthEmailDeliveryError'; }
}
export const validPhone = (phone: string) => /^\+[1-9][0-9]{7,14}$/.test(phone);
const uuid = z.uuid();
const unavailable = () => new Error('authentication_delivery_unavailable');
const secretConfigured = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/\s/.test(value);
export const authEmailProvider = (env: AuthEnvironment): AuthEmailProvider | null => env.AUTH_EMAIL_PROVIDER === undefined ? 'cloudflare'
  : env.AUTH_EMAIL_PROVIDER === 'cloudflare' || env.AUTH_EMAIL_PROVIDER === 'resend' ? env.AUTH_EMAIL_PROVIDER : null;
export const cloudflareEmailConfigured = (env: AuthEnvironment) => Boolean(secretConfigured(env.CLOUDFLARE_EMAIL_API_TOKEN)
  && /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')
  && z.email().safeParse(env.AUTH_EMAIL_FROM).success);
export const resendEmailConfigured = (env: AuthEnvironment) => Boolean(secretConfigured(env.RESEND_API_KEY)
  && z.email().safeParse(env.AUTH_EMAIL_FROM).success);
/** Only the explicitly selected provider may read its credential configuration. */
export const authEmailConfigured = (env: AuthEnvironment) => {
  const provider = authEmailProvider(env);
  return provider === 'cloudflare' ? cloudflareEmailConfigured(env) : provider === 'resend' ? resendEmailConfigured(env) : false;
};
export const smsDeliveryConfigured = (env: AuthEnvironment) => Boolean(env.SENTDM_API_KEY?.trim()
  && !/\s/.test(env.SENTDM_API_KEY) && uuid.safeParse(env.SENTDM_OTP_TEMPLATE_ID).success
  && env.SENTDM_OTP_CHANNEL === 'sms' && (!env.SENTDM_PROFILE_ID || uuid.safeParse(env.SENTDM_PROFILE_ID).success)
  && /^[a-zA-Z0-9_]{1,64}$/.test(env.SENTDM_OTP_PARAMETER || 'code'));
const emailResult = z.object({ success: z.literal(true), errors: z.array(z.unknown()).length(0), result: z.object({
  delivered: z.array(z.email()), queued: z.array(z.email()), permanent_bounces: z.array(z.email()).length(0),
  suppressed_recipients: z.array(z.email()).length(0).optional(),
}) });
const resendResult = z.strictObject({ id: z.uuid() });
const resendOtpTemplate = z.strictObject({
  id: z.enum(AUTH_OTP_RESEND_ALIASES),
  variables: z.strictObject({ OTP: z.string().length(AUTH_OTP_LENGTH).regex(/^[0-9]+$/) }),
});
// 409 may mean another idempotent request is still in progress; 408/5xx and
// transport/ACK failures can follow acceptance. Never call a second provider.
const resendConfirmedRejection = (status: number) => [400, 401, 403, 404, 405, 422, 429].includes(status);

// Fixed HTTPS destinations: never accept an upstream URL or retry a send from
// request input. Provider bodies/errors may contain OTPs and must not escape.
export function createAuthDelivery(env: AuthEnvironment, fetchImpl: typeof fetch = globalThis.fetch,
  report: EmailDeliveryReporter = diagnostic => { if (diagnostic.outcome !== 'accepted') console.warn(JSON.stringify(diagnostic)); }): AuthDelivery {
  const observe = createEmailObserver(env, fetchImpl);
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
      let terminal: Omit<EmailDeliveryDiagnostic, 'event'> | undefined;
      let failure: unknown;
      let acceptedMessageId: string | undefined;
      // Log only this fixed allowlist of classifications and numeric statuses.
      // Better Auth suppresses sender errors; without independent diagnostics
      // provider rejection used to be indistinguishable from an inbox delay.
      // No address, token, OTP, action URL or provider error text may be logged.
      const diagnostic = (value: Omit<EmailDeliveryDiagnostic, 'event'>) => {
        terminal = value;
        try { report({ event: 'auth_email_delivery', ...value }); } catch { /* A log sink must not change delivery. */ }
      };
      try {
      if (!authEmailConfigured(env) || !z.email().safeParse(message.to).success) {
        diagnostic({ outcome: 'configuration' }); throw new AuthEmailDeliveryError(true);
      }
      if (authEmailProvider(env) === 'resend') {
        let template: AuthOtpHostedTemplate | undefined;
        try {
          if (message.template !== undefined) {
            const parsed = resendOtpTemplate.safeParse(message.template);
            if (!parsed.success) throw unavailable();
            template = parsed.data;
          }
        } catch { diagnostic({ outcome: 'configuration' }); throw new AuthEmailDeliveryError(true); }
        let response: Response;
        try {
          response = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
            // Published template aliases are server-owned native OTP metadata.
            // Resend forbids html/text alongside template; never fall back to
            // those bodies if the selected template is rejected or unavailable.
            body: JSON.stringify({ from: env.AUTH_EMAIL_FROM, to: [message.to], subject: message.subject,
              ...(template ? { template } : { text: message.text, ...(message.html ? { html: message.html } : {}) }) }),
            signal: AbortSignal.timeout(8000),
          });
        } catch { diagnostic({ outcome: 'transport' }); throw new AuthEmailDeliveryError(false); }
        let data: unknown;
        try { data = await response.json(); }
        catch { diagnostic({ outcome: response.ok ? 'invalid_response' : 'rejected', httpStatus: response.status });
          throw new AuthEmailDeliveryError(resendConfirmedRejection(response.status)); }
        if (!response.ok) {
          diagnostic({ outcome: 'rejected', httpStatus: response.status });
          throw new AuthEmailDeliveryError(resendConfirmedRejection(response.status));
        }
        // REST ACK is exactly {id:UUID}; it means accepted, never inbox delivery.
        // Do not reflect/log provider bodies, IDs, messages or arbitrary fields.
        const acknowledgement = resendResult.safeParse(data);
        if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')
          || !acknowledgement.success) {
          diagnostic({ outcome: 'invalid_response', httpStatus: response.status }); throw new AuthEmailDeliveryError(false);
        }
        acceptedMessageId = acknowledgement.data.id.toLowerCase();
        diagnostic({ outcome: 'accepted', httpStatus: response.status, queued: true });
        return;
      }
      let response: Response;
      try {
        response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending/send`, {
          method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CLOUDFLARE_EMAIL_API_TOKEN}` },
          body: JSON.stringify({ from: env.AUTH_EMAIL_FROM, to: [message.to], subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) }),
          signal: AbortSignal.timeout(8000),
        });
      } catch { diagnostic({ outcome: 'transport' }); throw new AuthEmailDeliveryError(false); }
      let data: unknown;
      try { data = await response.json(); }
      catch { diagnostic({ outcome: response.ok ? 'invalid_response' : 'rejected', httpStatus: response.status });
        throw new AuthEmailDeliveryError([400, 401, 403, 404, 429].includes(response.status)); }
      if (!response.ok) {
        // Only documented numeric Cloudflare codes are diagnostic. Never log
        // arbitrary response properties/messages even when the API is broken.
        const code = z.object({ errors: z.array(z.object({ code: z.number().int().min(10000).max(10999) })) }).safeParse(data);
        diagnostic({ outcome: 'rejected', httpStatus: response.status,
          ...(code.success && code.data.errors[0] ? { providerCode: code.data.errors[0].code } : {}) });
        throw new AuthEmailDeliveryError([400, 401, 403, 404, 429].includes(response.status));
      }
      const rejection = z.object({ success: z.literal(true), errors: z.array(z.unknown()).length(0), result: z.object({
        delivered: z.array(z.email()), queued: z.array(z.email()), permanent_bounces: z.array(z.email()),
        suppressed_recipients: z.array(z.email()).optional(),
      }) }).safeParse(data);
      if (rejection.success && [...rejection.data.result.permanent_bounces, ...(rejection.data.result.suppressed_recipients || [])]
        .some(value => value.toLowerCase() === message.to.toLowerCase())
        && ![...rejection.data.result.delivered, ...rejection.data.result.queued].some(value => value.toLowerCase() === message.to.toLowerCase())) {
        diagnostic({ outcome: 'recipient_rejected', httpStatus: response.status }); throw new AuthEmailDeliveryError(true);
      }
      const result = emailResult.safeParse(data);
      if (!result.success) { diagnostic({ outcome: 'invalid_response', httpStatus: response.status }); throw new AuthEmailDeliveryError(false); }
      const accepted = [...result.data.result.delivered, ...result.data.result.queued];
      if (accepted.length !== 1 || accepted[0]!.toLowerCase() !== message.to.toLowerCase()) {
        diagnostic({ outcome: 'recipient_rejected', httpStatus: response.status }); throw new AuthEmailDeliveryError(false);
      }
      diagnostic({ outcome: 'accepted', httpStatus: response.status, queued: result.data.result.queued.length === 1 });
      // Queued/SMTP acceptance is not inbox delivery or identity proof. There
      // is no undocumented idempotency header or automatic resend/fallback.
      } catch (error) { failure = error; throw error; }
      finally {
        recordOtpTraceDelivery(message.to, terminal?.outcome === 'accepted' ? 'send_accepted'
          : failure instanceof AuthEmailDeliveryError && failure.confirmedRejected ? 'send_rejected' : 'send_unknown',
          terminal?.httpStatus, acceptedMessageId);
        // Monitoring is independent of delivery/identity. A bounded, failed
        // observation cannot revoke a valid code, resend or select a fallback.
        await observe({ provider: authEmailProvider(env),
          outcome: terminal?.outcome === 'configuration' ? 'configuration'
            : terminal?.outcome === 'accepted' ? 'accepted'
            : failure instanceof AuthEmailDeliveryError && failure.confirmedRejected ? 'rejected' : 'unknown',
          ...(terminal?.httpStatus !== undefined ? { http_status: terminal.httpStatus } : {}),
          ...(terminal?.providerCode !== undefined ? { provider_code: terminal.providerCode } : {}) });
      }
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
