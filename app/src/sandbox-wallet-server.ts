import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { auth } from './auth';
import { authDb } from './db/auth-client';
import { apiErrorHandler } from './http/errors';
import { registerSandboxWalletRoutes } from './http/sandbox-wallet-routes';
import type { ApiEnvironment } from './http/types';

// This process has no authentication, personal-payment, engine or broadcast
// routes. Existing Better Auth sessions are read using the shared auth service's
// database and signing secret; only the sandbox wallet has a writable API here.
const app = new Hono<ApiEnvironment>();
app.onError(apiErrorHandler);
app.use('/api/*', bodyLimit({ maxSize: 4096,
  onError: c => c.json({ error: 'request_too_large' }, 413) }));
app.use('/api/*', async (c, next) => {
  if (!c.req.path.startsWith('/api/member/sandbox-wallet/')) return c.json({ error: 'not_found' }, 404);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthenticated' }, 401);
  c.set('session', session);
  await next();
});
registerSandboxWalletRoutes(app, { database: authDb });
app.get('/health', c => c.text('ok'));
app.notFound(c => c.json({ error: 'not_found' }, 404));

export default { hostname: '0.0.0.0', port: 3000, fetch: app.fetch };
