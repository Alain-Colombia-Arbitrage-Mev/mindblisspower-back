import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { containerEnvironment } from '../src/runtime-env.mjs';
import { dispatchCore, dispatchContainerOutbound, coreReady } from '../src/routing.mjs';

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
const staleSms = { AUTH_SMS_OPT_IN_ENABLED: 'true', AUTH_SMS_OPT_IN_SCHEMA_READY: 'true',
  BETTER_AUTH_PHONE_OTP_ENABLED: 'true', BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY: 'true',
  BETTER_AUTH_REGISTRATION_SMS_REQUIRED: 'true',
  SENTDM_API_KEY: 'synthetic-not-real', SENTDM_OTP_TEMPLATE_ID: '00000000-0000-4000-8000-000000000001', SENTDM_OTP_CHANNEL: 'sms',
  SENTDM_PROFILE_ID: '00000000-0000-4000-8000-000000000002', SENTDM_OTP_PARAMETER: 'code' };
const phonePaths = ['/api/auth/phone-number', '/api/auth/phone-number/opt-in', '/api/auth/phone-number/send-otp',
  '/api/auth/phone-number/verify', '/api/auth/phone-number/revoke-consent', '/api/auth/phone-number/request-password-reset',
  '/api/auth/phone-number/reset-password', '/api/auth/sign-in/phone-number',
  '/api/auth/registration', '/api/auth/registration/phone', '/api/auth/registration/phone/send',
  '/api/auth/registration/phone/verify', '/api/auth/registration/phone/status'];
const noSms = values => {
  assert.equal(Object.keys(values).some(key => key.startsWith('SENTDM_') || key.startsWith('AUTH_SMS_')), false);
};

test('email-only runtime permanently disables phone auth and never forwards SMS provider credentials', () => {
  for (const config of [{}, staleSms, { ...staleSms, SENTDM_OTP_CHANNEL: 'whatsapp' }]) {
    const values = containerEnvironment('api', { ...fixture(), ...config });
    assert.equal(values.BETTER_AUTH_PHONE_OTP_ENABLED, 'false');
    assert.equal(values.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'false');
    assert.equal(values.BETTER_AUTH_REGISTRATION_SMS_REQUIRED, 'false');
    assert.equal(values.BETTER_AUTH_EMAIL_OTP_ENABLED, 'true');
    assert.equal(values.BETTER_AUTH_JWT_ENABLED, 'true');
    noSms(values);
  }
});

test('all obsolete registration flags are ignored, including exact true, regardless of provider validity', () => {
  for (const value of [undefined, false, true, 'false', 'TRUE', '1', 'true', 'true ', {}]) {
    const values = containerEnvironment('api', { ...fixture(), ...staleSms, BETTER_AUTH_REGISTRATION_SMS_REQUIRED: value,
      AUTH_SMS_OPT_IN_ENABLED: value, AUTH_SMS_OPT_IN_SCHEMA_READY: value, SENTDM_API_KEY: {}, SENTDM_OTP_TEMPLATE_ID: 'invalid' });
    assert.equal(values.BETTER_AUTH_PHONE_OTP_ENABLED, 'false');
    assert.equal(values.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'false');
    assert.equal(values.BETTER_AUTH_REGISTRATION_SMS_REQUIRED, 'false');
    assert.equal(values.BETTER_AUTH_EMAIL_OTP_ENABLED, 'true');
    assert.equal(values.CLOUDFLARE_EMAIL_API_TOKEN, 'synthetic-email-key');
    noSms(values);
  }
});

test('email runtime never even reads dormant provider secrets', () => {
  const env = fixture();
  for (const key of Object.keys(staleSms)) {
    Object.defineProperty(env, key, { get: () => assert.fail(`obsolete SMS configuration was accessed: ${key}`) });
  }
  const values = containerEnvironment('api', env);
  assert.equal(values.BETTER_AUTH_REGISTRATION_SMS_REQUIRED, 'false');
  assert.equal(values.BETTER_AUTH_EMAIL_OTP_ENABLED, 'true');
  noSms(values);
});

test('all phone registration and login routes return 404 before resolving any Container, even with stale true flags', async () => {
  for (const fullCore of [false, true]) {
    const env = { ...gates, ...staleSms, CORE_SERVICES_ENABLED: String(fullCore), CORE_NETWORK_VERIFIED: String(fullCore) };
    assert.equal(coreReady(env), fullCore);
    for (const path of phonePaths) for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const host of ['auth.core.internal', 'core.internal', 'payments.core.internal', 'withdrawals.core.internal']) {
        const response = await dispatchCore(new Request(`https://${host}${path}`, { method }), env,
          () => assert.fail('email-only phone request started a Container'));
        assert.equal(response.status, 404, `${method} ${host}${path}`);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
      }
    }
  }
});

test('phone denial is independent of missing infrastructure/auth gates and request upgrade headers', async () => {
  for (const env of [{}, { ...gates, CORE_ENV: 'development' }, { ...gates, AUTH_CUTOVER_VERIFIED: 'false' }]) {
    for (const path of phonePaths) {
      const response = await dispatchCore(new Request(`https://auth.core.internal${path}`,
        { headers: { upgrade: 'websocket' } }), env, () => assert.fail('unconfigured phone request started a Container'));
      assert.equal(response.status, 404, path);
    }
  }
});

test('Container outbound cannot reach removed phone capabilities with any infrastructure readiness', async () => {
  for (const env of [{}, { ...gates, ...staleSms }, { ...gates, ...staleSms, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' }]) {
    for (const source of ['api', 'engine', 'payments', 'withdrawals', 'unknown']) for (const path of phonePaths) {
      const response = await dispatchContainerOutbound(source, new Request(`https://auth.core.internal${path}`, { method: 'POST' }), env,
        () => assert.fail('Container outbound revived phone auth'));
      assert.equal(response.status, 404, `${source}:${path}`);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
  }
});

test('phone path suffixes, query strings, HTTP downgrade and nested encodings cannot evade denial', async () => {
  let nestedSlash = '/';
  for (let index = 0; index < 10; index++) nestedSlash = encodeURIComponent(nestedSlash);
  const env = { ...gates, ...staleSms, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true' };
  const variants = [...phonePaths.flatMap(path => [`${path}/`, `${path}/extra`, `${path}?purpose=login`]),
    '/api/auth/phone%2dnumber/send-otp', '/api/auth/phone%252dnumber/verify', '/api/auth/sign-in%2fphone-number',
    '/api/auth/registration/phone/%73end', '/api/auth/registration/phone/%2573end',
    '/api/auth/registration/phone/%252573end', '/api/auth/registration%2fphone/send',
    '/api/auth/registr%61tion/phone/verify', '/api%2fauth/registration/phone/send',
    `/api${nestedSlash}auth/registration/phone/send`];
  for (const protocol of ['https', 'http']) for (const path of variants) {
    const response = await dispatchCore(new Request(`${protocol}://auth.core.internal${path}`, { method: 'POST' }), env,
      () => assert.fail('encoded phone request escaped'));
    assert.equal(response.status, 404, `${protocol}:${path}`);
  }
});

test('email authentication exact routes remain usable with every obsolete SMS flag set true', async () => {
  const env = { ...gates, ...staleSms };
  for (const [method, path] of [['GET', '/api/auth/get-session'], ['GET', '/api/auth/token'], ['GET', '/api/auth/jwks'],
    ['POST', '/api/auth/sign-up/email'], ['POST', '/api/auth/email-otp/send-verification-otp'],
    ['POST', '/api/auth/email-otp/verify-email'], ['POST', '/api/auth/sign-in/email-otp'], ['POST', '/api/auth/sign-in/email']]) {
    let calls = 0;
    const response = await dispatchCore(new Request(`https://auth.core.internal${path}`, { method }), env,
      service => { calls++; assert.equal(service, 'api'); return { fetch: async () => Response.json({ synthetic: true }) }; });
    assert.equal(response.status, 200); assert.equal(calls, 1);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('phone removal never forwards provider secrets to Go or alters read-only financial gates', async () => {
  const env = { ...fixture(), ...staleSms,
    ENGINE_DATABASE_URL: 'postgres://engine.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    ENGINE_ROOT_AFFILIATE_ID: '50793', ENGINE_TLS_CERT_PEM: 'synthetic', ENGINE_TLS_KEY_PEM: 'synthetic', ENGINE_TLS_CLIENT_CA_PEM: 'synthetic',
    PAYMENTS_DATABASE_URL: 'postgres://payments.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    PAYMENTS_SERVICE_TOKEN: 'synthetic', PAYMENTS_ROOT_AFFILIATE_ID: '50793', CORE_SUPER_ADMIN_EMAILS: 'owner@example.invalid',
    WITHDRAWALS_DATABASE_URL: 'postgres://withdrawals.branch:synthetic@db.example.invalid/app?sslmode=verify-full', WITHDRAWALS_SERVICE_TOKEN: 'synthetic',
    SERVICE_READ_ONLY: 'false', BONUS_ENGINE_SCHEDULER_ENABLED: 'true', COMMS_ENABLED: 'true', STRIPE_SECRET_KEY: 'must-not-forward',
  };
  for (const service of ['engine', 'payments', 'withdrawals']) {
    const values = containerEnvironment(service, env);
    noSms(values);
    assert.equal(values.STRIPE_SECRET_KEY, undefined);
    assert.equal(values.BETTER_AUTH_REGISTRATION_SMS_REQUIRED, undefined);
    if (service === 'engine') assert.equal(values.BONUS_ENGINE_SCHEDULER_ENABLED, 'false');
    else assert.equal(values.SERVICE_READ_ONLY, 'true');
  }
  for (const host of ['payments.core.internal', 'withdrawals.core.internal']) {
    const response = await dispatchCore(new Request(`https://${host}/api/payments/checkout`, { method: 'POST' }),
      { ...env, CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true', STRIPE_CHECKOUT_ENABLED: 'true' }, () => assert.fail('financial mutation forwarded'));
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'financial_review_required');
  }
});

test('checked-in environments contain no phone-auth flags or provider settings', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  for (const name of ['staging', 'production']) {
    for (const flag of ['AUTH_SMS_OPT_IN_ENABLED', 'AUTH_SMS_OPT_IN_SCHEMA_READY', 'BETTER_AUTH_REGISTRATION_SMS_REQUIRED']) {
      assert.equal(config.env[name].vars[flag], undefined);
    }
    assert.equal(Object.keys(config.env[name].vars).some(key => key.startsWith('SENTDM_')), false);
  }
});
