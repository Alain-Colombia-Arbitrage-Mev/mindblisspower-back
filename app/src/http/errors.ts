import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

export const apiErrorHandler: ErrorHandler = (error, context) => {
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return context.json({ error: 'invalid_request' }, 400);
  }
  if (error instanceof HTTPException) return error.getResponse();
  if (error.name === 'FinancialRecoveryPendingError') {
    return context.json({ error: 'stripe_recovery_review_pending', retryable: false }, 503);
  }
  // Never include request bodies, headers, database messages or upstream errors.
  console.error(JSON.stringify({ event: 'api_error', path: context.req.path, type: error.name }));
  return context.json({ error: 'internal_error' }, 500);
};
