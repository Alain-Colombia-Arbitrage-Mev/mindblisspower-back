import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { auth } from './auth';
import { apiErrorHandler } from './http/errors';
import { registerAffiliateRoutes } from './http/affiliate-routes';
import { registerTransactionRoutes } from './http/transaction-routes';
import { registerCommandCenterRoutes } from './http/command-center-routes';
import { registerIdentityRoutes } from './http/identity-routes';
import { registerWalletLinkRoutes } from './http/wallet-link-routes';
import { registerAdministrativeWalletRoutes } from './http/administrative-wallet-routes';
import { registerMeldWebhookRoutes } from './http/meld-webhook-routes';
import { registerMeldOnrampRoutes } from './http/meld-onramp-routes';
import { registerWalletFundingRoutes } from './http/wallet-funding-routes';
import { authDb } from './db/auth-client';
import { MELD_WEBHOOK_MAX_BYTES, MELD_WEBHOOK_PATH } from './modules/payments/meld-webhook';
import { authProxyContext } from './http/auth-proxy-context';
import { OTP_DIAGNOSTIC_PATH, otpDiagnosticPrivacy, registerOtpDiagnosticRoutes, registerOtpTraceReadiness } from './http/otp-diagnostic-routes';
import type { ApiEnvironment } from './http/types';

const app = new Hono<ApiEnvironment>();
app.onError(apiErrorHandler);
registerOtpTraceReadiness(app);
// Include failures returned by the shared session gate in private/no-store.
app.use(OTP_DIAGNOSTIC_PATH, otpDiagnosticPrivacy);
app.use('/api/auth/*', bodyLimit({ maxSize: 32 * 1024,
  onError: c => c.json({ error: 'request_too_large' }, 413) }));
app.use('/api/auth/*', authProxyContext(process.env.AUTH_BFF_SHARED_SECRET));
app.use(MELD_WEBHOOK_PATH, bodyLimit({ maxSize: MELD_WEBHOOK_MAX_BYTES,
  onError: c => c.json({ error: 'request_too_large' }, 413) }));
registerMeldWebhookRoutes(app);

// Mount Better Auth — handles /api/auth/* (signup, signin, signout, callbacks)
app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Session middleware
app.use('/api/*', async (c, next) => {
  if (c.req.path === MELD_WEBHOOK_PATH) return next();
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: 'unauthenticated' }, 401);
  }
  c.set('session', session);
  await next();
});
app.use('/api/*', bodyLimit({ maxSize: 256 * 1024,
  onError: c => c.json({ error: 'request_too_large' }, 413) }));
registerAffiliateRoutes(app);
registerTransactionRoutes(app);
registerCommandCenterRoutes(app);
registerIdentityRoutes(app);
registerWalletLinkRoutes(app, { database: authDb });
registerAdministrativeWalletRoutes(app);
registerMeldOnrampRoutes(app);
registerWalletFundingRoutes(app, { database: authDb });
registerOtpDiagnosticRoutes(app);

app.get('/health', (c) => c.text('ok'));

export default {
  hostname: process.env.API_LISTEN_HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
