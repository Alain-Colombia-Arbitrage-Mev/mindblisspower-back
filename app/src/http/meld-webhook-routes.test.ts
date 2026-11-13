import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { expect, test } from 'bun:test';
import { registerMeldWebhookRoutes } from './meld-webhook-routes';
import type { ApiEnvironment } from './types';
import { sandboxEnvironment, sandboxDatabase } from '../modules/payments/meld-sandbox-fixtures';

test('native HTTP webhook verifies signed test events without auth cookies and retains private responses', async () => {
  const db = sandboxDatabase(), app = new Hono<ApiEnvironment>();
  registerMeldWebhookRoutes(app, { database: db.database, environment: sandboxEnvironment,
    fetchImpl: (async () => { throw Error('no provider access'); }) as unknown as typeof fetch });
  const timestamp = new Date().toISOString(), body = JSON.stringify({ eventType: 'WEBHOOK_TEST', eventId: 'native-test', timestamp,
    accountId: 'sandbox-account', profileId: null, version: '2026-02-03', payload: { requestId: 'native-request' } });
  const signature = createHmac('sha256', sandboxEnvironment.MELD_WEBHOOK_SIGNING_KEY)
    .update(`${timestamp}.${sandboxEnvironment.MELD_WEBHOOK_PUBLIC_URL}.${body}`).digest('base64url') + '=';
  const headers = { 'content-type': 'application/json', 'meld-signature': signature, 'meld-signature-timestamp': timestamp };
  const response = await app.request('/api/webhooks/meld', { method: 'POST', body, headers });
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ received: true, duplicate: false, mode: 'sandbox_only' });
  expect(db.queries).toHaveLength(1);
  const invalid = await app.request('/api/webhooks/meld', { method: 'POST', body: body + ' ', headers });
  expect(invalid.status).toBe(401); expect(db.queries).toHaveLength(1);
});

test('native webhook bounds both declared and actual stream body, JSON and compressed ingress before storage', async () => {
  const db = sandboxDatabase(), app = new Hono<ApiEnvironment>(); registerMeldWebhookRoutes(app, { database: db.database, environment: sandboxEnvironment });
  for (const [headers, body, expected] of [
    [{ 'content-type': 'application/json', 'content-length': '131073' }, '{}', 413],
    [{ 'content-type': 'application/json' }, 'x'.repeat(131073), 413],
    [{ 'content-type': 'text/plain' }, '{}', 415],
    [{ 'content-type': 'application/json', 'content-encoding': 'gzip' }, '{}', 415],
  ] as const) {
    const response = await app.request('/api/webhooks/meld', { method: 'POST', headers, body });
    expect(response.status).toBe(expected);
  }
  expect(db.queries).toHaveLength(0);
});
