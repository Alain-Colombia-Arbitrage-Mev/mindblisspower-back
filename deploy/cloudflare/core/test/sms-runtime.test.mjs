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
const registrationPaths = ['/api/auth/registration/phone/send', '/api/auth/registration/phone/verify'];

test('email-only runtime keeps phone delivery and consent-table readiness forced off', () => {
  for (const config of [{}, dormantSms, { ...dormantSms, SENTDM_OTP_CHANNEL: 'whatsapp' }]) {
    const values = containerEnvironment('api', { ...fixture(), ...config });
    assert.equal(values.BETTER_AUTH_PHONE_OTP_ENABLED, 'false');
    assert.equal(values.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'false');
    assert.equal(values.BETTER_AUTH_EMAIL_OTP_ENABLED, 'true');
    assert.equal(values.BETTER_AUTH_JWT_ENABLED, 'true');
    assert.equal(values.BETTER_AUTH_REGISTRATION_SMS_REQUIRED, 'false');
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

test('phone paths return 404 even with registration proof enabled and full core readiness', async () => {
  for (const fullCore of [false, true]) {
    const env = { ...gates, ...dormantSms, BETTER_AUTH_REGISTRATION_SMS_REQUIRED: 'true',
      CORE_SERVICES_ENABLED: String(fullCore), CORE_NETWORK_VERIFIED: String(fullCore) };
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

test('registration SMS never forwards secrets to Go or alters read-only financial gates', async () => {
  const env = { ...fixture(), ...dormantSms, BETTER_AUTH_REGISTRATION_SMS_REQUIRED: 'true',
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
    assert.equal(values.BETTER_AUTH_REGISTRATION_SMS_REQUIRED, undefined);
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
    assert.equal(config.env[name].vars.BETTER_AUTH_REGISTRATION_SMS_REQUIRED, 'false');
    assert.equal(Object.keys(config.env[name].vars).some(key => key.startsWith('SENTDM_')), false);
  }
});

test('only exact true with verified email auth can scope SMS credentials to the API Container', () => {
  for (const flag of [undefined, false, true, 'false', 'TRUE', '1', 'true ', {}]) {
    const values = containerEnvironment('api', { ...fixture(), ...dormantSms, BETTER_AUTH_REGISTRATION_SMS_REQUIRED: flag });
    assert.equal(values.BETTER_AUTH_REGISTRATION_SMS_REQUIRED, 'false');
    assert.equal(Object.keys(values).some(key => key.startsWith('SENTDM_')), false);
  }
  const values = containerEnvironment('api', { ...fixture(), ...dormantSms, BETTER_AUTH_REGISTRATION_SMS_REQUIRED: 'true' });
  assert.equal(values.BETTER_AUTH_REGISTRATION_SMS_REQUIRED, 'true');
  for (const key of ['SENTDM_API_KEY', 'SENTDM_OTP_TEMPLATE_ID', 'SENTDM_OTP_CHANNEL', 'SENTDM_PROFILE_ID', 'SENTDM_OTP_PARAMETER']) {
    assert.equal(values[key], dormantSms[key]);
  }
  assert.equal(values.BETTER_AUTH_PHONE_OTP_ENABLED, 'false');
  assert.equal(values.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'false');
  assert.equal(values.BETTER_AUTH_EMAIL_OTP_ENABLED, 'true');
  const unverified = containerEnvironment('api', { ...fixture(), ...dormantSms, AUTH_CUTOVER_VERIFIED: 'false',
    BETTER_AUTH_REGISTRATION_SMS_REQUIRED: 'true' });
  assert.equal(unverified.BETTER_AUTH_REGISTRATION_SMS_REQUIRED, 'false');
  assert.equal(Object.keys(unverified).some(key => key.startsWith('SENTDM_')), false);
  const minimal = containerEnvironment('api', { ...fixture(), ...dormantSms, SENTDM_PROFILE_ID: undefined,
    SENTDM_OTP_PARAMETER: undefined, BETTER_AUTH_REGISTRATION_SMS_REQUIRED: 'true' });
  assert.equal(minimal.SENTDM_PROFILE_ID, undefined);
  assert.equal(minimal.SENTDM_OTP_PARAMETER, 'code');
});

test('incomplete SMS configuration fails closed for registration without breaking email startup', () => {
  for (const override of [{ SENTDM_API_KEY: undefined }, { SENTDM_API_KEY: {} }, { SENTDM_API_KEY: 'contains space' },
    { SENTDM_API_KEY: 'unsafe\nkey' }, { SENTDM_API_KEY: 'unsafe\u0000key' }, { SENTDM_API_KEY: 'a'.repeat(4097) },
    { SENTDM_OTP_TEMPLATE_ID: undefined }, { SENTDM_OTP_TEMPLATE_ID: 'invalid' }, { SENTDM_OTP_TEMPLATE_ID: {} },
    { SENTDM_OTP_CHANNEL: undefined }, { SENTDM_OTP_CHANNEL: 'whatsapp' }, { SENTDM_OTP_CHANNEL: 'SMS' },
    { SENTDM_PROFILE_ID: 'invalid' }, { SENTDM_PROFILE_ID: {} }, { SENTDM_OTP_PARAMETER: '' },
    { SENTDM_OTP_PARAMETER: 'unsafe\nparameter' }, { SENTDM_OTP_PARAMETER: {} }]) {
    const values = containerEnvironment('api', { ...fixture(), ...dormantSms, ...override, BETTER_AUTH_REGISTRATION_SMS_REQUIRED: 'true' });
    assert.equal(values.BETTER_AUTH_REGISTRATION_SMS_REQUIRED, 'true');
    assert.equal(Object.keys(values).some(key => key.startsWith('SENTDM_')), false);
    assert.equal(values.BETTER_AUTH_EMAIL_OTP_ENABLED, 'true');
    assert.equal(values.BETTER_AUTH_JWT_ENABLED, 'true');
    assert.equal(values.CLOUDFLARE_EMAIL_API_TOKEN, 'synthetic-email-key');
    assert.equal(values.BETTER_AUTH_PHONE_OTP_ENABLED, 'false');
    assert.equal(values.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'false');
  }
});

test('default-off or malformed registration flag rejects phone proof before resolving any Container', async () => {
  for (const flag of [undefined, false, true, 'false', 'TRUE', '1', 'true ', {}]) {
    for (const fullCore of [false, true]) for (const path of registrationPaths) {
      const response = await dispatchCore(new Request(`https://auth.core.internal${path}`, { method: 'POST' }),
        { ...gates, ...dormantSms, BETTER_AUTH_REGISTRATION_SMS_REQUIRED: flag,
          CORE_SERVICES_ENABLED: String(fullCore), CORE_NETWORK_VERIFIED: String(fullCore) }, () => assert.fail('registration SMS started while off'));
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
  }
});

test('registration proof allows only two exact POST routes independently of Go readiness', async () => {
  const env = { ...gates, BETTER_AUTH_REGISTRATION_SMS_REQUIRED: 'true' };
  assert.equal(coreReady(env), false);
  for (const path of registrationPaths) {
    let calls = 0;
    const response = await dispatchCore(new Request(`https://auth.core.internal${path}`, { method: 'POST', body: '{"synthetic":true}',
      headers: { 'x-vp-auth-signature': 'synthetic-context', cookie: 'proof=synthetic', 'cf-container-target-port': '50051' } }), env,
    service => { calls++; assert.equal(service, 'api'); return { fetch: async forwarded => {
      assert.equal(forwarded.method, 'POST');
      assert.equal(await forwarded.text(), '{"synthetic":true}');
      assert.equal(forwarded.headers.get('x-vp-auth-signature'), 'synthetic-context');
      assert.equal(forwarded.headers.get('cookie'), 'proof=synthetic');
      assert.equal(forwarded.headers.get('cf-container-target-port'), null);
      assert.equal(forwarded.redirect, 'manual');
      return Response.json({ synthetic: true });
    } }; });
    assert.equal(response.status, 200); assert.equal(calls, 1);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  // Even with no provider, email reaches the backend; only signup/SMS fail there.
  for (const path of ['/api/auth/sign-in/email-otp', '/api/auth/email-otp/send-verification-otp']) {
    assert.equal((await dispatchCore(new Request(`https://auth.core.internal${path}`, { method: 'POST' }), env,
      () => ({ fetch: async () => Response.json({ synthetic: true }) }))).status, 200);
  }
});

test('registration proof rejects alternate hosts, methods, queries, suffixes and encoded forms even when core is ready', async () => {
  let nestedSlash = '/';
  for (let index = 0; index < 10; index++) nestedSlash = encodeURIComponent(nestedSlash);
  for (const fullCore of [false, true]) {
    const env = { ...gates, BETTER_AUTH_REGISTRATION_SMS_REQUIRED: 'true',
      CORE_SERVICES_ENABLED: String(fullCore), CORE_NETWORK_VERIFIED: String(fullCore) };
    for (const path of registrationPaths) for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.equal((await dispatchCore(new Request(`https://auth.core.internal${path}`, { method }), env,
        () => assert.fail('alternate method escaped'))).status, 404);
    }
    for (const [host, protocol] of [['core.internal', 'https'], ['payments.core.internal', 'https'],
      ['withdrawals.core.internal', 'https'], ['auth.core.internal', 'http']]) {
      assert.equal((await dispatchCore(new Request(`${protocol}://${host}${registrationPaths[0]}`, { method: 'POST' }), env,
        () => assert.fail('alternate origin escaped'))).status, 404);
    }
    for (const path of ['/api/auth/registration', '/api/auth/registration/', '/api/auth/registration/phone',
      '/api/auth/registration/phone/status', '/api/auth/registration/phone/send/', '/api/auth/registration/phone/verify/extra',
      '/api/auth/registration/phone/send?purpose=login', '/api/auth/registration/phone/verify?proof=other',
      '/api/auth/registration/phone/%73end', '/api/auth/registration/phone/%2573end',
      '/api/auth/registration/phone/%252573end', '/api/auth/registration%2fphone/send',
      '/api/auth/registr%61tion/phone/verify', '/api%2fauth/registration/phone/send',
      `/api${nestedSlash}auth/registration/phone/send`]) {
      assert.equal((await dispatchCore(new Request(`https://auth.core.internal${path}`, { method: 'POST' }), env,
        () => assert.fail(`registration path escaped: ${path}`))).status, 404, path);
    }
  }
});
