// Deployment draft only: no network calls, credentials or changes to Cloudflare.
// The zone's Free plan permits one rule using Path and IP characteristics. Do
// not add Method/Host predicates or response-based counting requiring an upgrade.
export const AUTH_RATE_PATHS = Object.freeze([
  '/api/auth/register', '/api/auth/register/confirm', '/api/auth/access-help',
  '/api/auth/sign-in/email', '/api/auth/sign-in/email-otp',
  '/api/auth/email-otp/send-verification-otp', '/api/auth/email-otp/verify-email',
  '/api/auth/email-otp/request-password-reset', '/api/auth/email-otp/reset-password',
  '/api/auth/send-verification-email',
]);

export function edgeAuthRateLimitDraft() {
  return {
    ref: 'mindbliss_auth_burst_v1',
    description: 'Mindbliss authentication burst protection; exclude logout, sessions and webhooks',
    expression: `http.request.uri.path in {${AUTH_RATE_PATHS.map(path => JSON.stringify(path)).join(' ')}}`,
    action: 'block',
    enabled: true,
    ratelimit: {
      characteristics: ['cf.colo.id', 'ip.src'],
      period: 10,
      requests_per_period: 30,
      mitigation_timeout: 10,
    },
  };
}
