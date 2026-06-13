import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { requireAdmin } from './admin-gate';

test('alerts route is gated: 401 without session', async () => {
  const app = new Hono<{ Variables: { session: any } }>();
  app.use('*', async (c, next) => { c.set('session', null); await next(); });
  app.get('/api/admin/command-center/alerts', requireAdmin, (c) => c.json({ alerts: [] }));
  const res = await app.request('/api/admin/command-center/alerts');
  expect(res.status).toBe(401);
});
