import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { requireAdmin } from './admin-gate';

// Verify the gate blocks non-admins without a session.
test('requireAdmin returns 401 without session', async () => {
  const app = new Hono<{ Variables: { session: any } }>();
  app.use('*', async (c, next) => { c.set('session', null); await next(); });
  app.get('/x', requireAdmin, (c) => c.text('ok'));
  const res = await app.request('/x');
  expect(res.status).toBe(401);
});
