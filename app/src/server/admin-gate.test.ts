import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { createRequireAdmin, isAdminPerson, type PersonGateRow } from './admin-gate';
import type { Principal } from '../modules/identity/model';

const admin: Principal = { subject: 'synthetic-admin', auth_email: 'admin@example.test', email_verified: true, name: 'Synthetic',
  person_id: '7', public_id: '51f8d415-0f6c-40b9-9544-f553f8c247c6', person_email: 'ADMIN@example.test', person_status: 'active',
  blacklisted: false, user_id: 'synthetic-admin', is_admin: true, access_restricted: false };

test('only a verified, canonically bound, active unrestricted admin passes, including the existing superadmin', () => {
  expect(isAdminPerson(admin, admin.subject)).toBe(true);
  for (const update of [{ subject: 'another' }, { user_id: 'another' }, { email_verified: false },
    { person_email: 'another@example.test' }, { person_id: null }, { public_id: null }, { is_admin: false },
    { blacklisted: true }, { access_restricted: true }, { access_restricted: null }, { access_restricted: undefined },
    { person_status: 'pending' }, { person_status: 'suspended' }, { person_status: 'banned' }, { person_status: 'deleted' }]) {
    expect(isAdminPerson({ ...admin, ...update } as Principal, admin.subject)).toBe(false);
  }
  expect(isAdminPerson(admin, '')).toBe(false);
  expect(isAdminPerson(null, admin.subject)).toBe(false);
  expect(isAdminPerson(undefined, admin.subject)).toBe(false);
});

test('the middleware checks current authority every time and never trusts cookie roles, supplied email or a stale grant', async () => {
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  let row: PersonGateRow = admin;
  let lookups = 0, calls = 0;
  app.use('*', async (c, next) => {
    c.set('session', { user: { id: admin.subject, email: 'untrusted@example.test', role: 'superadmin' } });
    await next();
  });
  app.use('*', createRequireAdmin(async subject => { lookups++; expect(subject).toBe(admin.subject); return row; }));
  app.get('/', c => { calls++; expect(c.get('personIsAdmin')).toBe(true); return c.json({ ok: true }); });
  expect((await app.request('/?email=untrusted@example.test')).status).toBe(200);
  row = { ...admin, access_restricted: true };
  expect((await app.request('/')).status).toBe(403);
  expect(lookups).toBe(2);
  expect(calls).toBe(1);
});

test('missing sessions skip the lookup; database failures fail closed without details or privileged handler execution', async () => {
  for (const userId of [undefined, '', ' ', 7, 'a'.repeat(256), admin.subject]) {
    const app = new Hono<{ Variables: Record<string, unknown> }>();
    let lookups = 0;
    app.use('*', async (c, next) => { c.set('session', { user: { id: userId } }); await next(); });
    app.use('*', createRequireAdmin(async () => { lookups++; throw new Error('private-database-token-and-parameters'); }));
    app.get('/', () => { throw new Error('privileged handler ran'); });
    const response = await app.request('/');
    expect(response.status).toBe(userId === admin.subject ? 503 : 401);
    expect(await response.json()).toEqual({ error: userId === admin.subject ? 'account_status_unavailable' : 'unauthenticated' });
    expect(lookups).toBe(userId === admin.subject ? 1 : 0);
  }
});
