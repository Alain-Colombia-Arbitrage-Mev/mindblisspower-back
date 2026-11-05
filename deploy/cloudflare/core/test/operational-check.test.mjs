import test from 'node:test';
import assert from 'node:assert/strict';
import { monitoringEnvironment, checkOperations } from '../scripts/operational-check.mjs';

test('operator check never passes sender, auth, finance or database credentials into its collector', () => {
  const source = { RESEND_MONITOR_API_KEY: 'monitor-only', RESEND_API_KEY: 'must-not-pass', DATABASE_URL: 'must-not-pass',
    AUTH_BFF_SHARED_SECRET: 'must-not-pass', STRIPE_SECRET_KEY: 'must-not-pass', CLOUDFLARE_API_TOKEN: 'must-not-pass' };
  assert.deepEqual(monitoringEnvironment(source), { RESEND_MONITOR_API_KEY: 'monitor-only' });
});

test('without monitoring credentials only two fixed public login reads occur, not OTP requests', async () => {
  const calls = [];
  const report = await checkOperations({}, async (url, options) => {
    calls.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit'); return new Response('login', { status: url.includes('admin.') ? 503 : 200 });
  });
  assert.deepEqual(calls.sort(), ['https://admin.mindblisspower.com/login', 'https://mindblisspower.com/login']);
  assert.equal(report.availability.find(row => row.service === 'admin').status, 'critical');
  assert.equal(report.infrastructure.find(row => row.service === 'planetscale').status, 'unknown');
  assert.ok(report.missing_configuration.includes('RESEND_MONITOR_API_KEY'));
});
