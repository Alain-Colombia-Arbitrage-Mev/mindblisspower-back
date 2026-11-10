import { z } from 'zod';
import { authDb } from '../db/auth-client';
import { createMeldOnrampAttempt, onrampIntentInput } from '../modules/payments/meld-onramp-attempt';
import { availabilityInput, createMeldOnrampQuote, quoteInput, readMeldOnrampAvailability } from '../modules/payments/meld-onramp';
import type { ApiApplication } from './types';

const noStore = { 'Cache-Control': 'private, no-store' };

function failure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { error: 'invalid_request', status: 400 as const };
  if (error instanceof Error && error.message === 'meld_onramp_quote_unavailable') return { error: 'onramp_quote_unavailable', status: 409 as const };
  if (error instanceof Error && error.message === 'meld_onramp_unconfigured') return { error: 'onramp_unconfigured', status: 503 as const };
  return { error: 'onramp_unavailable', status: 503 as const };
}

function allowedOrigin(value: string) {
  return [process.env.BETTER_AUTH_URL, ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS || '').split(',')]
    .filter(Boolean).some(candidate => { try { return new URL(candidate!.trim()).origin === value; } catch { return false; } });
}

export function registerMeldOnrampRoutes(app: ApiApplication) {
  app.get('/api/member/onramp/availability', async context => {
    try {
      const input = availabilityInput.parse({
        country: context.req.query('country'), fiat: context.req.query('fiat'), crypto: context.req.query('crypto'),
      });
      return context.json(await readMeldOnrampAvailability(input), 200, noStore);
    } catch (error) {
      const next = failure(error);
      return context.json({ error: next.error }, next.status, noStore);
    }
  });

  app.post('/api/member/onramp/quote', async context => {
    if (!allowedOrigin(context.req.header('origin') || '')) return context.json({ error: 'invalid_origin' }, 403, noStore);
    try {
      const input = quoteInput.parse(await context.req.json());
      return context.json(await createMeldOnrampQuote(input), 200, noStore);
    } catch (error) {
      const next = failure(error);
      return context.json({ error: next.error }, next.status, noStore);
    }
  });

  app.post('/api/member/onramp/intent', async context => {
    if (!allowedOrigin(context.req.header('origin') || '')) return context.json({ error: 'invalid_origin' }, 403, noStore);
    const subject = context.get('session')?.user.id;
    if (!subject) return context.json({ error: 'unauthenticated' }, 401, noStore);
    try {
      const input = onrampIntentInput.parse(await context.req.json());
      return context.json(await createMeldOnrampAttempt(authDb, input, { subject }), 201, noStore);
    } catch (error) {
      const next = failure(error);
      return context.json({ error: next.error }, next.status, noStore);
    }
  });
}
