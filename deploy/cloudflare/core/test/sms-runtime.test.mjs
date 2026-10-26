import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { containerEnvironment } from '../src/runtime-env.mjs';
import { dispatchCore, coreReady } from '../src/routing.mjs';

const gates = { CORE_ENV: 'production', CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false',
  CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_SERVICES_ENABLED: 'true', AUTH_CUTOVER_VERIFIED: 'true' };
const fixture = () => ({ ...gates,
  API_DATABASE_URL: 'postgres://reader.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
  API_AUTH_DATABASE_URL: 'postgres://auth.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
  API_AUTH_SECRET: 'a'.repeat(48), API_BFF_SHARED_SECRET: 'b'.repeat(48),
  API_AUTH_URL: 'https://portal.example.invalid', API_AUTH_ORIGINS: 'https://portal.example.invalid',
  API_ENGINE_GRPC_URL: 'https://private-engine.example.invalid:50051',
  API_ENGINE_TLS_CA_PEM: 'synthetic-ca', API_ENGINE_TLS_CERT_PEM: 'synthetic-cert', API_ENGINE_TLS_KEY_PEM: 'synthetic-key',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-email-key', AUTH_EMAIL_FROM: 'auth@example.invalid',
  AUTH_JWT_ISSUER: 'https://portal.example.invalid', AUTH_JWT_AUDIENCE: 'synthetic',
});
const dormantSms = { AUTH_SMS_OPT_IN_ENABLED: 'true', AUTH_SMS_OPT_IN_SCHEMA_READY: 'true',
  BETTER_AUTH_PHONE_OTP_ENABLED: 'true', BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY: 'true',
  SENTDM_API_KEY: 'synthetic-not-real', SENTDM_OTP_TEMPLATE_ID: '00000000-0000-4000-8000-000000000001', SENTDM_OTP_CHANNEL: 'sms',
  SENTDM_PROFILE_ID: '00000000-0000-4000-8000-000000000002', SENTDM_OTP_PARAMETER: 'code' };
const phonePaths = ['/api/auth/phone-number/opt-in', '/api/auth/phone-number/send-otp', '/api/auth/phone-number/verify',
  '/api/auth/phone-number/revoke-consent', '/api/auth/phone-number/request-password-reset', '/api/auth/phone-number/reset-password',
  '/api/auth/sign-in/phone-number'];

test('email-only runtime keeps phone delivery and consent-table readiness forced off', () => {
  for (const config of [{}, dormantSms, { ...dormantSms, SENTDM_OTP_CHANNEL: 'whatsapp' }]) {
    const values = containerEnvironment('api', { ...fixture(), ...config });
    assert.equal(values.BETTER_AUTH_PHONE_OTP_ENABLED, 'false');
    assert.equal(values.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'false');
    assert.equal(values.BETTER_AUTH_EMAIL_OTP_ENABLED, 'true');
    assert.equal(values.BETTER_AUTH_JWT_ENABLED, 'true');
    assert.equal(Object.keys(values).some(key => key.startsWith('SENTDM_') || key.startsWith('AUTH_SMS_')), false);
  }
});

test('obsolete SMS flags and malformed provider values cannot break working email', () => {
  for (const value of [undefined, false, true, 'false', 'TRUE', '1', 'true']) {
    const values = containerEnvironment('api', { ...fixture(), ...dormantSms, AUTH_SMS_OPT_IN_ENABLED: value,
      AUTH_SMS_OPT_IN_SCHEMA_READY: value, SENTDM_API_KEY: {}, SENTDM_OTP_TEMPLATE_ID: 'invalid' });
    assert.equal(values.BETTER_AUTH_PHONE_OTP_ENABLED, 'false');
    assert.equal(values.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'false');
    assert.equal(values.BETTER_AUTH_EMAIL_OTP_ENABLED, 'true');
    assert.equal(values.CLOUDFLARE_EMAIL_API_TOKEN, 'synthetic-email-key');
  }
});

test('phone paths return 404 without resolving a Container, including with full core readiness', async () => {
  for (const fullCore of [false, true]) {
    const env = { ...gates, ...dormantSms, CORE_SERVICES_ENABLED: String(fullCore), CORE_NETWORK_VERIFIED: String(fullCore) };
    assert.equal(coreReady(env), fullCore);
    for (const path of phonePaths) for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const host of ['auth.core.internal', 'core.internal']) {
        const response = await dispatchCore(new Request(`https://${host}${path}`, { method }), env,
          () => assert.fail('email-only phone request started a Container'));
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
      }
    }
  }
});

test('phone path suffixes, query strings and encoded path forms cannot evade email-only denial', async () => {
  const env = { ...gates, ...dormantSms, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' };
  for (const path of [...phonePaths.map(path => `${path}/`), ...phonePaths.map(path => `${path}?target=other`),
    '/api/auth/phone%2dnumber/send-otp', '/api/auth/phone%252dnumber/verify', '/api/auth/sign-in%2fphone-number']) {
    const response = await dispatchCore(new Request(`https://auth.core.internal${path}`, { method: 'POST' }), env,
      () => assert.fail('encoded phone request escaped'));
    assert.equal(response.status, 404, path);
  }
});

test('email authentication exact routes remain usable with stale SMS flags but no phone capability', async () => {
  const env = { ...gates, ...dormantSms };
  for (const [method, path] of [['GET', '/api/auth/get-session'], ['GET', '/api/auth/token'], ['GET', '/api/auth/jwks'],
    ['POST', '/api/auth/sign-up/email'], ['POST', '/api/auth/email-otp/send-verification-otp'],
    ['POST', '/api/auth/email-otp/verify-email'], ['POST', '/api/auth/sign-in/email-otp'], ['POST', '/api/auth/sign-in/email']]) {
    let calls = 0;
    const response = await dispatchCore(new Request(`https://auth.core.internal${path}`, { method }), env,
      service => { calls++; assert.equal(service, 'api'); return { fetch: async () => Response.json({ synthetic: true }) }; });
    assert.equal(response.status, 200); assert.equal(calls, 1);
  }
});

test('email-only policy does not forward SMS secrets to Go or alter read-only financial gates', async () => {
  const env = { ...fixture(), ...dormantSms,
    ENGINE_DATABASE_URL: 'postgres://engine.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    ENGINE_ROOT_AFFILIATE_ID: '50793', ENGINE_TLS_CERT_PEM: 'synthetic', ENGINE_TLS_KEY_PEM: 'synthetic', ENGINE_TLS_CLIENT_CA_PEM: 'synthetic',
    PAYMENTS_DATABASE_URL: 'postgres://payments.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    PAYMENTS_SERVICE_TOKEN: 'synthetic', PAYMENTS_ROOT_AFFILIATE_ID: '50793', CORE_SUPER_ADMIN_EMAILS: 'owner@example.invalid',
    WITHDRAWALS_DATABASE_URL: 'postgres://withdrawals.branch:synthetic@db.example.invalid/app?sslmode=verify-full', WITHDRAWALS_SERVICE_TOKEN: 'synthetic',
    SERVICE_READ_ONLY: 'false', BONUS_ENGINE_SCHEDULER_ENABLED: 'true', COMMS_ENABLED: 'true', STRIPE_SECRET_KEY: 'must-not-forward',
  };
  for (const service of ['engine', 'payments', 'withdrawals']) {
    const values = containerEnvironment(service, env);
    assert.equal(Object.keys(values).some(key => key.startsWith('SENTDM_') || key.startsWith('AUTH_SMS_')), false);
    assert.equal(values.STRIPE_SECRET_KEY, undefined);
    if (service === 'engine') assert.equal(values.BONUS_ENGINE_SCHEDULER_ENABLED, 'false');
    else assert.equal(values.SERVICE_READ_ONLY, 'true');
  }
  for (const host of ['payments.core.internal', 'withdrawals.core.internal']) {
    const response = await dispatchCore(new Request(`https://${host}/api/payments/checkout`, { method: 'POST' }),
      { ...env, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' }, () => assert.fail('financial mutation forwarded'));
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'financial_review_required');
  }
});

test('checked-in environments retain dormant false flags and no provider secrets', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  for (const name of ['staging', 'production']) {
    assert.equal(config.env[name].vars.AUTH_SMS_OPT_IN_ENABLED, 'false');
    assert.equal(config.env[name].vars.AUTH_SMS_OPT_IN_SCHEMA_READY, 'false');
    assert.equal(Object.keys(config.env[name].vars).some(key => key.startsWith('SENTDM_')), false);
  }
});
