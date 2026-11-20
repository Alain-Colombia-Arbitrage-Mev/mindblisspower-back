import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { APP_MELD_RECONCILIATION_PATH, registerAppMeldReconciliation } from './app-meld-reconciliation-routes';
import type { ApiEnvironment } from './types';

const secret = 'synthetic-native-cron-shared-secret';
const environment = { ENV: 'production', APP_MELD_PRODUCTION_ENABLED: 'true', AUTH_BFF_SHARED_SECRET: secret };
const database = { execute: () => { throw Error('fixture does not query the database'); } };
const path = APP_MELD_RECONCILIATION_PATH;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function headers(body = '{}', signaturePath = path, timestamp = String(Math.floor(Date.now() / 1000))) {
  return new Headers({ 'content-type': 'application/json', 'x-vp-auth-client-ip': '127.0.0.1', 'x-vp-auth-timestamp': timestamp,
    'x-vp-auth-signature': createHmac('sha256', secret).update(['POST', signaturePath, timestamp, '127.0.0.1', hash(''), hash(body)].join('\n')).digest('hex') });
}

test('only the signed private cron can invoke reconciliation without a user session', async () => {
  const app = new Hono<ApiEnvironment>();
  let calls = 0;
  registerAppMeldReconciliation(app, { database, environment, reconcile: async (db, options) => {
    calls++;
    expect(db).toBe(database);
    expect(options.environment).toBe(environment);
    expect(options.signal.aborted).toBe(false);
    return { processed: 3 };
  } });
  const response = await app.request(path, { method: 'POST', headers: headers(), body: '{}' });
  expect(await response.json()).toEqual({ processed: 3 });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  for (const [name, value] of [
    ['cookie', ''], ['authorization', 'Bearer fake'], ['origin', 'https://app.example.test'],
    ['x-vp-act-as', 'synthetic'], ['content-encoding', 'gzip'], ['x-vp-auth-client-ip', '192.0.2.25'],
    ['x-vp-auth-signature', 'a'.repeat(64)],
  ] as const) {
    const changed = headers(); changed.set(name, value);
    expect((await app.request(path, { method: 'POST', headers: changed, body: '{}' })).status).toBe(404);
  }
  expect((await app.request(path + '?attempt=caller-supplied', { method: 'POST', headers: headers(), body: '{}' })).status).toBe(404);
  expect((await app.request(path, { method: 'POST', headers: headers('{}', '/different'), body: '{}' })).status).toBe(404);
  expect((await app.request(path, { method: 'POST', headers: headers('{}', path, '1000000000'), body: '{}' })).status).toBe(404);
  for (const body of ['[]', '{ }', '{"attempt":"caller"}']) {
    expect((await app.request(path, { method: 'POST', headers: headers(), body })).status).toBe(404);
  }
  expect(calls).toBe(1);
});

test('nonproduction requests stay closed and failures never expose provider details', async () => {
  for (const config of [{ ...environment, ENV: 'staging' }, { ...environment, APP_MELD_PRODUCTION_ENABLED: 'false' },
    { ...environment, AUTH_BFF_SHARED_SECRET: undefined }]) {
    const app = new Hono<ApiEnvironment>();
    registerAppMeldReconciliation(app, { database, environment: config, reconcile: async () => { expect.unreachable(); } });
    expect((await app.request(path, { method: 'POST', headers: headers(), body: '{}' })).status).toBe(404);
  }
  const failureApp = new Hono<ApiEnvironment>();
  registerAppMeldReconciliation(failureApp, { database, environment, reconcile: async () => { throw Error('private details'); } });
  const response = await failureApp.request(path, { method: 'POST', headers: headers(), body: '{}' });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'wallet_funding_unavailable' });
});
