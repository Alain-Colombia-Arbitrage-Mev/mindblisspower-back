import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readAcknowledgement } from './email-observation';

type Environment = Record<string, string | undefined>;
export const OTP_TRACE_URL = 'https://observability.core.internal/v1/trace';
export const OTP_TRACE_TIMEOUT_MS = 500;
export const OTP_TRACE_PURPOSES = ['sign-in', 'email-verification', 'password-reset'] as const;
export const OTP_TRACE_STAGES = ['requested', 'blocked', 'throttled', 'registration_required', 'send_accepted',
  'send_rejected', 'send_unknown', 'validation_succeeded', 'validation_failed', 'request_failed'] as const;
export type OtpTracePurpose = typeof OTP_TRACE_PURPOSES[number];
export type OtpTraceStage = typeof OTP_TRACE_STAGES[number];
export type OtpTraceEvent = { version: 1; id: string; request_id: string; occurred_at: string; recipient_ref: string;
  purpose: OtpTracePurpose; stage: OtpTraceStage; http_status?: number; message_ref?: string };
const emailInput = z.string().trim().toLowerCase().max(320).pipe(z.email());
const uuid4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hex = /^[a-f0-9]{64}$/;
const eventSchema = z.object({ version: z.literal(1), id: z.string().regex(uuid4), request_id: z.string().regex(uuid4),
  occurred_at: z.iso.datetime(), recipient_ref: z.string().regex(hex), purpose: z.enum(OTP_TRACE_PURPOSES),
  stage: z.enum(OTP_TRACE_STAGES), http_status: z.number().int().min(100).max(599).optional(),
  message_ref: z.string().regex(hex).optional() });
export function traceSecret(env: Environment) {
  const value = env.AUTH_BFF_SHARED_SECRET;
  if (typeof value !== 'string' || value.length < 32 || value.length > 4096 || /[\r\n]/.test(value)) throw new Error('trace_configuration_unavailable');
  return value;
}
export const traceRecipientRef = (secret: string, email: string) => createHmac('sha256', secret)
  .update(`otp-trace:recipient\0${email.trim().toLowerCase()}`).digest('hex');
export const traceMessageRef = (secret: string, id: string) => createHmac('sha256', secret)
  .update(`otp-trace:message\0${id.toLowerCase()}`).digest('hex');

/** Bounded, one-shot private transport. Never retries or changes native auth. */
export async function postTraceObservation(env: Environment, path: '/v1/trace' | '/v1/probe', payload: OtpTraceEvent | Record<string, never>,
  fetchImpl: typeof fetch = globalThis.fetch, timeoutMs = OTP_TRACE_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined, response: Response | undefined;
  const controller = new AbortController();
  try {
    // Reconstruct from the closed schema: caller extras must never reach storage.
    if (path !== '/v1/trace' && path !== '/v1/probe') return false;
    const data = path === '/v1/probe' ? z.strictObject({}).parse(payload) : eventSchema.parse(payload);
    const secret = traceSecret(env), body = JSON.stringify(data), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret).update(['POST', path, timestamp,
      createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
    const deadline = new Promise<boolean>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, timeoutMs); });
    const operation = (async () => {
      response = await fetchImpl(`https://observability.core.internal${path}`, { method: 'POST', credentials: 'omit',
        redirect: 'error', cache: 'no-store', headers: { 'content-type': 'application/json',
          'x-vp-observation-timestamp': timestamp, 'x-vp-observation-signature': signature }, body, signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); return false; }
      return readAcknowledgement(response, controller.signal);
    })();
    return await Promise.race([operation, deadline]);
  } catch { return false; }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    if (!response?.bodyUsed) void response?.body?.cancel().catch(() => {});
  }
}

type TraceState = { env: Environment; secret: string; requestId: string; recipientRef?: string; purpose?: OtpTracePurpose;
  mode?: 'send' | 'validation'; events: OtpTraceEvent[]; closed: boolean; fetchImpl: typeof fetch };
const traces = new AsyncLocalStorage<TraceState>();
function action(path: string, type: unknown): { purpose: OtpTracePurpose; mode: 'send' | 'validation' } | undefined {
  if (path === '/sign-up/email') return { purpose: 'email-verification', mode: 'send' };
  if (path === '/email-otp/request-password-reset') return { purpose: 'password-reset', mode: 'send' };
  if (path === '/email-otp/reset-password') return { purpose: 'password-reset', mode: 'validation' };
  if (path === '/sign-in/email-otp') return { purpose: 'sign-in', mode: 'validation' };
  if (path === '/email-otp/verify-email') return { purpose: 'email-verification', mode: 'validation' };
  if (path === '/email-otp/send-verification-otp') {
    const purpose = type === 'forget-password' ? 'password-reset' : type;
    if (OTP_TRACE_PURPOSES.includes(purpose as OtpTracePurpose)) return { purpose: purpose as OtpTracePurpose, mode: 'send' };
  }
}
function append(state: TraceState, stage: OtpTraceStage, httpStatus?: number, messageRef?: string) {
  if (state.closed || !state.recipientRef || !state.purpose || state.events.length >= 8 || !OTP_TRACE_STAGES.includes(stage)) return;
  if (!stage.startsWith('send_') && state.events.some(event => event.stage === stage)) return;
  state.events.push({ version: 1, id: randomUUID(), request_id: state.requestId, occurred_at: new Date().toISOString(),
    recipient_ref: state.recipientRef, purpose: state.purpose, stage,
    ...(Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? { http_status: httpStatus } : {}),
    ...(messageRef && hex.test(messageRef) ? { message_ref: messageRef } : {}) });
}
function capture(state: TraceState, path: string, email: unknown, type: unknown) {
  const parsed = emailInput.safeParse(email), current = action(path, type);
  if (!parsed.success || !current || state.closed) return;
  const recipientRef = traceRecipientRef(state.secret, parsed.data);
  if (state.recipientRef && state.recipientRef !== recipientRef) return; // Never merge two owners.
  state.recipientRef = recipientRef; state.purpose ??= current.purpose; state.mode ??= current.mode;
  append(state, 'requested');
}
/** Only these metadata fields are read from a hook; no OTP/password/session. */
export function captureOtpTraceRequest(path: string | null, email: unknown, type?: unknown) {
  try { const state = traces.getStore(); if (state && path) capture(state, path, email, type); } catch { /* Diagnostics cannot fail authentication. */ }
}
export function recordOtpTraceError(error: unknown) {
  try {
    const state = traces.getStore(); if (!state) return;
    const value = error as { statusCode?: number; body?: { code?: string } };
    if (value?.body?.code === 'REGISTRATION_REQUIRED') append(state, 'registration_required', value.statusCode);
    else if (value?.statusCode === 429) append(state, 'throttled', 429);
    else if (value?.statusCode === 403) append(state, 'blocked', 403);
  } catch { /* No raw exception, headers or body is logged. */ }
}
export function recordOtpTraceDelivery(email: string, stage: 'send_accepted' | 'send_rejected' | 'send_unknown', httpStatus?: number, resendId?: string) {
  try {
    const state = traces.getStore();
    if (!state || traceRecipientRef(state.secret, email) !== state.recipientRef) return;
    append(state, stage, httpStatus, resendId && z.uuid().safeParse(resendId).success ? traceMessageRef(state.secret, resendId) : undefined);
  } catch { /* Never reject/revoke a provider-accepted code. */ }
}

async function requestMetadata(request: Request, state: TraceState, path: string) {
  const reader = request.clone().body?.getReader(); if (!reader) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (async () => {
      const parts: Uint8Array[] = []; let total = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        total += chunk.value.byteLength; if (total > 32 * 1024) return;
        parts.push(chunk.value);
      }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (value && typeof value === 'object') capture(state, path, (value as { email?: unknown }).email, (value as { type?: unknown }).type);
    })();
    await Promise.race([read, new Promise<void>(resolve => { timer = setTimeout(resolve, 100); })]);
  } catch { /* Malformed input is handled only by native auth. */ }
  finally { if (timer !== undefined) clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
type AuthHandler = (request: Request) => Response | Promise<Response>;
export type OtpTraceLost = { event: 'auth_otp_trace_lost'; reason: 'transport' };
/** Per-request correlation, preserving the original Response/error and all
 * native cookies/status. No response body is read. Bun owns background tasks. */
export function otpTraceHandler(handler: AuthHandler, env: Environment, fetchImpl: typeof fetch = globalThis.fetch,
  reportLost: (event: OtpTraceLost) => void = event => console.warn(JSON.stringify(event))): AuthHandler {
  return request => {
    if (env.AUTH_OTP_TRACE_ENABLED !== 'true' || request.method !== 'POST') return handler(request);
    let secret: string;
    try { secret = traceSecret(env); } catch { return handler(request); }
    const path = new URL(request.url).pathname.replace(/^\/api\/auth/, '');
    if (!['/sign-up/email', '/email-otp/send-verification-otp', '/email-otp/request-password-reset', '/email-otp/reset-password',
      '/sign-in/email-otp', '/email-otp/verify-email'].includes(path)) return handler(request);
    const state: TraceState = { env, secret, requestId: randomUUID(), events: [], closed: false, fetchImpl };
    return traces.run(state, async () => {
      let reportedLost = false;
      const lost = () => {
        if (reportedLost) return; reportedLost = true;
        try { reportLost({ event: 'auth_otp_trace_lost', reason: 'transport' }); } catch { /* Never fail native auth. */ }
      };
      // Metadata parsing runs in parallel and is bounded; it cannot delay auth.
      const metadata = requestMetadata(request, state, path);
      const finish = async (status: number) => {
        await metadata;
        if (status === 429) append(state, 'throttled', status);
        else if (status === 403) append(state, 'blocked', status);
        if (state.mode === 'validation') append(state, status >= 200 && status < 300 ? 'validation_succeeded' : 'validation_failed', status);
        else if (status >= 400 && !state.events.some(event => ['throttled', 'blocked', 'registration_required'].includes(event.stage))) append(state, 'request_failed', status);
        state.closed = true;
        const results = await Promise.all(state.events.map(event => postTraceObservation(env, '/v1/trace', event, fetchImpl)));
        if (results.some(recorded => !recorded)) lost();
      };
      try {
        const response = await handler(request);
        void finish(response.status).catch(lost);
        return response;
      } catch (error) { void finish(500).catch(lost); throw error; }
    });
  };
}
