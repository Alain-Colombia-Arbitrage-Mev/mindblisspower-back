import { z } from 'zod';
import { MELD_WEBHOOK_PATH } from '../modules/payments/meld-webhook';
import { handleSandboxMeldWebhook } from '../modules/payments/meld-sandbox-webhook';
import type { SandboxDatabase } from '../modules/payments/meld-sandbox-reconciliation';
import type { ApiApplication } from './types';

const replyHeaders = { 'Cache-Control': 'private, no-store' };

async function webhookBody(request: Request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > 131_072)) throw new RangeError('request_too_large');
  const reader = request.body?.getReader(); if (!reader) throw new SyntaxError('missing_body');
  let size = 0; const parts: Uint8Array[] = [];
  let timedOut = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, 10_000);
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (request.signal.aborted || timedOut) throw new Error('webhook_body_unavailable');
      const next = await reader.read();
      if (request.signal.aborted || timedOut) throw new Error('webhook_body_unavailable');
      if (next.done) break; size += next.value.byteLength;
      if (size > 131_072) throw new RangeError('request_too_large'); parts.push(next.value);
    }
    if (!size) throw new SyntaxError('missing_body');
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}

export function registerMeldWebhookRoutes(app: ApiApplication, {
  database, environment = process.env, fetchImpl = fetch,
}: { database?: SandboxDatabase; environment?: Record<string, string | undefined>; fetchImpl?: typeof fetch } = {}) {
  app.post(MELD_WEBHOOK_PATH, async context => {
    if (context.req.raw.headers.has('content-encoding')
      || !/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') || '')) {
      return context.json({ error: 'json_required' }, 415, replyHeaders);
    }
    try {
      const rawBody = await webhookBody(context.req.raw);
      const result = await handleSandboxMeldWebhook(database ?? (await import('../db/auth-client')).authDb, rawBody, {
        signature: context.req.header('meld-signature'),
        signatureTimestamp: context.req.header('meld-signature-timestamp'),
      }, { environment, fetchImpl, signal: context.req.raw.signal });
      return context.json(result, 200, replyHeaders);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (error instanceof RangeError && code === 'request_too_large') return context.json({ error: 'request_too_large' }, 413, replyHeaders);
      if (code === 'invalid_meld_signature') return context.json({ error: 'invalid_webhook_signature' }, 401, replyHeaders);
      if (code === 'meld_webhook_unconfigured') return context.json({ error: 'webhook_unavailable' }, 503, replyHeaders);
      if (error instanceof z.ZodError || error instanceof SyntaxError || code.startsWith('invalid_meld_')) {
        return context.json({ error: 'invalid_webhook_request' }, 400, replyHeaders);
      }
      return context.json({ error: 'webhook_unavailable' }, 503, replyHeaders);
    }
  });
}
