import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { auth } from './auth';
import { apiErrorHandler } from './http/errors';
import { registerAffiliateRoutes } from './http/affiliate-routes';
import { registerTransactionRoutes } from './http/transaction-routes';
import { registerCommandCenterRoutes } from './http/command-center-routes';
import { registerIdentityRoutes } from './http/identity-routes';
import { authProxyContext } from './http/auth-proxy-context';
import type { ApiEnvironment } from './http/types';

const app = new Hono<ApiEnvironment>();
app.onError(apiErrorHandler);
app.use('/api/auth/*', bodyLimit({ maxSize: 32 * 1024,
  onError: c => c.json({ error: 'request_too_large' }, 413) }));
app.use('/api/auth/*', authProxyContext(process.env.AUTH_BFF_SHARED_SECRET));

// Mount Better Auth — handles /api/auth/* (signup, signin, signout, callbacks)
app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Session middleware
app.use('/api/*', async (c, next) => {
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

app.get('/health', (c) => c.text('ok'));

export default {
  hostname: process.env.API_LISTEN_HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
