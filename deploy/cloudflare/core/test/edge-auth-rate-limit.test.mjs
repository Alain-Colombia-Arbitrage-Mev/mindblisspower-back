import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTH_RATE_PATHS, edgeAuthRateLimitDraft } from '../src/edge-auth-rate-limit.mjs';

test('Free-compatible rule scopes only exact auth paths, never webhooks, sessions, logout or payments', () => {
  const rule = edgeAuthRateLimitDraft();
  const paths = [...rule.expression.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(paths, AUTH_RATE_PATHS);
  assert.equal(new Set(paths).size, paths.length);
  for (const path of ['/api/webhooks/nowpayments', '/api/webhooks/resend', '/api/auth/logout', '/api/auth/sign-out',
    '/api/auth/session', '/api/auth/get-session', '/api/payments/checkout', '/api/member/tree', '/login', '/register']) {
    assert.equal(paths.includes(path), false, path);
  }
  assert.doesNotMatch(rule.expression, /http\.host|http\.request\.method|http\.response|matches|starts_with/);
  assert.equal(rule.action, 'block');
  assert.deepEqual(rule.ratelimit, { characteristics: ['cf.colo.id', 'ip.src'], period: 10,
    requests_per_period: 30, mitigation_timeout: 10 });
});

test('each draft is independent and never changes OTP/account quotas or creates bypass rules', () => {
  const first = edgeAuthRateLimitDraft();
  first.ratelimit.requests_per_period = 1;
  assert.equal(edgeAuthRateLimitDraft().ratelimit.requests_per_period, 30);
  assert.doesNotMatch(JSON.stringify(edgeAuthRateLimitDraft()), /"action":"(?:skip|allow|managed_challenge)"/);
});
