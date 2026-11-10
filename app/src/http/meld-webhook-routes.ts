import { z } from 'zod';
import { authDb } from '../db/auth-client';
import { captureMeldWebhookEvent, MELD_WEBHOOK_PATH, verifyMeldWebhook } from '../modules/payments/meld-webhook';
import type { ApiApplication } from './types';

const replyHeaders = { 'Cache-Control': 'private, no-store' };

export function registerMeldWebhookRoutes(app: ApiApplication) {
  app.post(MELD_WEBHOOK_PATH, async context => {
    if (context.req.header('content-encoding')
      || !/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') || '')) {
      return context.json({ error: 'json_required' }, 415, replyHeaders);
    }
    try {
      const rawBody = await context.req.text();
      const verified = verifyMeldWebhook({
        rawBody,
        signature: context.req.header('meld-signature'),
        signatureTimestamp: context.req.header('meld-signature-timestamp'),
        secret: process.env.MELD_WEBHOOK_SIGNING_KEY,
        publicUrl: process.env.MELD_WEBHOOK_PUBLIC_URL,
        accountId: process.env.MELD_ACCOUNT_ID,
        profileId: process.env.MELD_WEBHOOK_PROFILE_ID,
      });
      const capture = await captureMeldWebhookEvent(authDb, { ...verified, rawBody });
      return context.json({ received: true, duplicate: !capture.inserted, mode: 'capture_only' }, 200, replyHeaders);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'invalid_meld_signature') return context.json({ error: 'invalid_webhook_signature' }, 401, replyHeaders);
      if (code === 'meld_webhook_unconfigured') return context.json({ error: 'webhook_unavailable' }, 503, replyHeaders);
      if (error instanceof z.ZodError || error instanceof SyntaxError || code.startsWith('invalid_meld_')) {
        return context.json({ error: 'invalid_webhook_request' }, 400, replyHeaders);
      }
      return context.json({ error: 'webhook_unavailable' }, 503, replyHeaders);
    }
  });
}
