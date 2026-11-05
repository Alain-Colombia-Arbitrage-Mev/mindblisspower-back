import { createHash, createHmac, randomUUID } from 'node:crypto';

export type EmailObservation = {
  version: 1;
  id: string;
  occurred_at: string;
  provider: 'resend' | 'cloudflare';
  outcome: 'configuration' | 'accepted' | 'rejected' | 'unknown';
  http_status?: number;
  provider_code?: number;
};
export type EmailObservationInput = Omit<EmailObservation, 'version' | 'id' | 'occurred_at' | 'provider'> & {
  provider: EmailObservation['provider'] | null;
};
export type EmailObservationLost = { event: 'auth_email_observation_lost';
  reason: 'configuration' | 'invalid_provider' | 'transport' | 'invalid_ack' };
type Environment = Record<string, string | undefined>;
type LostReporter = (diagnostic: EmailObservationLost) => void;

export const EMAIL_OBSERVATION_URL = 'https://observability.core.internal/v1/email';
export const EMAIL_OBSERVATION_TIMEOUT_MS = 500;
const MAX_ACK_BYTES = 128;

export async function readAcknowledgement(response: Response, signal: AbortSignal) {
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) return false;
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]{1,4}$/.test(declared) || Number(declared) > MAX_ACK_BYTES)) return false;
  const reader = response.body?.getReader();
  if (!reader) return false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      if (signal.aborted) return false;
      const { value, done } = await reader.read();
      if (signal.aborted) return false;
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ACK_BYTES) return false;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return data !== null && typeof data === 'object' && !Array.isArray(data)
      && Object.keys(data).length === 1 && (data as { recorded?: unknown }).recorded === true;
  } catch { return false; }
  finally {
    signal.removeEventListener('abort', cancel);
    // Never await cancellation: a broken observation sink cannot hold auth open.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Best-effort, at-most-one terminal observation per auth email attempt. This is
 * not a billing ledger: failures are explicitly signalled and never retried.
 * No recipient, IP, content, OTP, session or provider message ID is accepted. */
export function createEmailObserver(env: Environment, fetchImpl: typeof fetch = globalThis.fetch,
  reportLost: LostReporter = diagnostic => console.warn(JSON.stringify(diagnostic))) {
  return async (input: EmailObservationInput): Promise<void> => {
    const lost = (reason: EmailObservationLost['reason']) => {
      try { reportLost({ event: 'auth_email_observation_lost', reason }); } catch { /* Logs cannot change auth. */ }
    };
    try {
      if (env.AUTH_OBSERVABILITY_ENABLED !== 'true') return;
      if (!['resend', 'cloudflare'].includes(input.provider || '')) { lost('invalid_provider'); return; }
      if (!['configuration', 'accepted', 'rejected', 'unknown'].includes(input.outcome)) { lost('configuration'); return; }
      const secret = env.AUTH_BFF_SHARED_SECRET;
      if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096 || /[\r\n]/.test(secret)) {
        lost('configuration'); return;
      }
      // Reconstruct the fixed allowlist instead of serializing caller objects.
      const event: EmailObservation = { version: 1, id: randomUUID(), occurred_at: new Date().toISOString(),
        provider: input.provider as EmailObservation['provider'], outcome: input.outcome,
        ...(Number.isInteger(input.http_status) && input.http_status! >= 100 && input.http_status! <= 599 ? { http_status: input.http_status } : {}),
        ...(Number.isInteger(input.provider_code) && input.provider_code! >= 10000 && input.provider_code! <= 10999 ? { provider_code: input.provider_code } : {}) };
      const body = JSON.stringify(event);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', secret).update(['POST', '/v1/email', timestamp,
        createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Response | undefined;
      try {
        const deadline = new Promise<'timeout'>(resolve => {
          timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, EMAIL_OBSERVATION_TIMEOUT_MS);
        });
        const operation = (async () => {
          response = await fetchImpl(EMAIL_OBSERVATION_URL, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
            headers: { 'content-type': 'application/json', 'x-vp-observation-timestamp': timestamp,
              'x-vp-observation-signature': signature }, body, signal: controller.signal });
          return await readAcknowledgement(response, controller.signal) ? 'recorded' : 'invalid_ack';
        })();
        const result = await Promise.race([operation, deadline]);
        if (result !== 'recorded') lost(result === 'timeout' ? 'transport' : 'invalid_ack');
      } catch { lost('transport'); }
      finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
        if (!response?.bodyUsed) void response?.body?.cancel().catch(() => {});
      }
    } catch { lost('transport'); }
  };
}
