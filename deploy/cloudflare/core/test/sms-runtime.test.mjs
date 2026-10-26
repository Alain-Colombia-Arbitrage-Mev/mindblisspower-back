import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { containerEnvironment } from '../src/runtime-env.mjs';
import { dispatchCore, authReady, coreReady } from '../src/routing.mjs';

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
const sms = { AUTH_SMS_OPT_IN_ENABLED: 'true', AUTH_SMS_OPT_IN_SCHEMA_READY: 'true',
  SENTDM_API_KEY: 'synthetic-not-real', SENTDM_OTP_TEMPLATE_ID: '00000000-0000-4000-8000-000000000001', SENTDM_OTP_CHANNEL: 'sms' };

test('SMS defaults off and never forwards dormant credentials or bypasses reviewed flags', () => {
  const baseline = containerEnvironment('api', fixture());
  assert.equal(baseline.BETTER_AUTH_PHONE_OTP_ENABLED, 'false');
  assert.equal(baseline.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'false');
  assert.equal(baseline.BETTER_AUTH_EMAIL_OTP_ENABLED, 'true');
  assert.equal(baseline.BETTER_AUTH_JWT_ENABLED, 'true');
  for (const key of ['AUTH_CUTOVER_VERIFIED', 'AUTH_SMS_OPT_IN_ENABLED', 'AUTH_SMS_OPT_IN_SCHEMA_READY']) {
    for (const value of [undefined, false, true, 'false', 'TRUE', '1']) {
      const values = containerEnvironment('api', { ...fixture(), ...sms, [key]: value });
      assert.equal(values.BETTER_AUTH_PHONE_OTP_ENABLED, 'false', key);
      assert.equal(values.SENTDM_API_KEY, undefined);
      if (key !== 'AUTH_SMS_OPT_IN_ENABLED') assert.equal(values.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'false');
    }
  }
  const direct = containerEnvironment('api', { ...fixture(), SENTDM_API_KEY: sms.SENTDM_API_KEY,
    BETTER_AUTH_PHONE_OTP_ENABLED: 'true', BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY: 'true' });
  assert.equal(direct.BETTER_AUTH_PHONE_OTP_ENABLED, 'false');
  assert.equal(direct.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'false');
});

test('schema readiness permits consent reads and revocation independently of SMS provider/send availability', () => {
  for (const change of [{ AUTH_SMS_OPT_IN_ENABLED: 'false' }, { SENTDM_API_KEY: undefined }, { SENTDM_OTP_TEMPLATE_ID: '' }]) {
    const values = containerEnvironment('api', { ...fixture(), ...sms, ...change });
    assert.equal(values.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'true');
    assert.equal(values.BETTER_AUTH_PHONE_OTP_ENABLED, 'false');
    assert.equal(values.BETTER_AUTH_EMAIL_OTP_ENABLED, 'true');
    assert.equal(values.CLOUDFLARE_EMAIL_API_TOKEN, 'synthetic-email-key');
    assert.equal(values.SENTDM_API_KEY, undefined);
  }
});

test('SMS delivery requires an explicit SMS-only valid configuration and maps only its allowlist', () => {
  const env = { ...fixture(), ...sms, SENTDM_PROFILE_ID: '00000000-0000-4000-8000-000000000002',
    SENTDM_OTP_PARAMETER: 'auth_code', SENTDM_BASE_URL: 'https://attacker.invalid', SENTDM_WHATSAPP_TOKEN: 'must-not-forward',
    STRIPE_SECRET_KEY: 'must-not-forward', BETTER_AUTH_PHONE_OTP_ENABLED: 'false' };
  const values = containerEnvironment('api', env);
  assert.equal(values.BETTER_AUTH_PHONE_OTP_ENABLED, 'true');
  assert.equal(values.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'true');
  for (const key of ['SENTDM_API_KEY', 'SENTDM_OTP_TEMPLATE_ID', 'SENTDM_PROFILE_ID', 'SENTDM_OTP_PARAMETER']) assert.equal(values[key], env[key]);
  assert.equal(values.SENTDM_OTP_CHANNEL, 'sms');
  for (const key of ['SENTDM_BASE_URL', 'SENTDM_WHATSAPP_TOKEN', 'STRIPE_SECRET_KEY', 'AUTH_SMS_OPT_IN_ENABLED']) assert.equal(values[key], undefined);
  assert.equal(containerEnvironment('api', { ...fixture(), ...sms }).SENTDM_OTP_PARAMETER, 'code');
  for (const change of [{ SENTDM_API_KEY: '' }, { SENTDM_API_KEY: 'has whitespace' }, { SENTDM_API_KEY: {} },
    { SENTDM_OTP_TEMPLATE_ID: 'not-uuid' }, { SENTDM_OTP_TEMPLATE_ID: '00000000-0000-0000-0000-000000000000' },
    { SENTDM_OTP_CHANNEL: 'whatsapp' }, { SENTDM_OTP_CHANNEL: 'SMS' }, { SENTDM_OTP_CHANNEL: undefined },
    { SENTDM_PROFILE_ID: 'not-uuid' }, { SENTDM_PROFILE_ID: null }, { SENTDM_OTP_PARAMETER: 'with\nlinebreak' },
    { SENTDM_OTP_PARAMETER: 'x'.repeat(65) }, { SENTDM_OTP_PARAMETER: {} }]) {
    const invalid = containerEnvironment('api', { ...fixture(), ...sms, ...change });
    assert.equal(invalid.BETTER_AUTH_PHONE_OTP_ENABLED, 'false');
    assert.equal(invalid.BETTER_AUTH_EMAIL_OTP_ENABLED, 'true');
    assert.equal(invalid.BETTER_AUTH_SMS_OPT_IN_SCHEMA_READY, 'true');
    assert.equal(invalid.SENTDM_API_KEY, undefined);
  }
});

test('SMS configuration never reaches Go or changes read-only financial/provider/job constraints', () => {
  const env = { ...fixture(), ...sms,
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
    if (service === 'payments') { assert.equal(values.COMMS_ENABLED, 'false'); assert.equal(values.PAYMENTS_RECONCILE_INTERVAL_MIN, '0'); }
  }
  assert.equal(env.CORE_SERVICES_ENABLED, 'false'); assert.equal(env.CORE_NETWORK_VERIFIED, 'false');
});

test('private auth release permits exact SMS opt-in routes independently of provider flags but never phone login or financial commands', async () => {
  for (const config of [{}, sms, { ...sms, AUTH_SMS_OPT_IN_ENABLED: 'false' }, { ...sms, AUTH_SMS_OPT_IN_SCHEMA_READY: 'false' }]) {
    const env = { ...gates, ...config };
    assert.equal(coreReady(env), false); assert.equal(authReady(env), true);
    for (const [method, path] of [['GET', '/api/auth/phone-number/opt-in'], ['POST', '/api/auth/phone-number/send-otp'],
      ['POST', '/api/auth/phone-number/verify'], ['POST', '/api/auth/phone-number/revoke-consent']]) {
      let calls = 0;
      const response = await dispatchCore(new Request(`https://auth.core.internal${path}`, { method,
        ...(method === 'POST' ? { body: '{}', headers: { 'x-vp-auth-signature': 'synthetic', cookie: 'session=synthetic' } } : {}) }), env,
      service => { calls++; assert.equal(service, 'api'); return { fetch: async request => {
        assert.equal(request.method, method); assert.equal(new URL(request.url).pathname, path);
        if (method === 'POST') assert.equal(request.headers.get('x-vp-auth-signature'), 'synthetic');
        // The backend owns consent/schema/send checks, including disabled 404.
        return Response.json({ available: false }, { status: method === 'POST' ? 404 : 200 });
      } }; });
      assert.equal(response.status, method === 'POST' ? 404 : 200); assert.equal(calls, 1);
    }
    for (const [host, path, method] of [['auth.core.internal', '/api/auth/sign-in/phone-number', 'POST'],
      ['auth.core.internal', '/api/auth/phone-number/reset-password', 'POST'], ['auth.core.internal', '/api/auth/phone-number/send-otp/', 'POST'],
      ['auth.core.internal', '/api/auth/phone-number/verify?target=business', 'POST'], ['core.internal', '/api/auth/phone-number/opt-in', 'GET'],
      ['payments.core.internal', '/api/payments/checkout', 'POST'], ['withdrawals.core.internal', '/api/payments/withdraw', 'POST'],
      ['auth.core.internal', '/api/member/identity/claim', 'POST']]) {
      const response = await dispatchCore(new Request(`https://${host}${path}`, { method }), env, () => assert.fail('scope escaped'));
      assert.equal(response.status, 503);
    }
  }
});

test('SMS paths do not bypass existing auth/data/cutover release prerequisites', async () => {
  for (const key of ['AUTH_SERVICES_ENABLED', 'AUTH_CUTOVER_VERIFIED', 'CORE_DATA_ACCESS_VERIFIED']) {
    for (const value of [undefined, 'false', 'TRUE', true]) {
      const env = { ...gates, ...sms, [key]: value };
      for (const [method, path] of [['GET', '/api/auth/phone-number/opt-in'], ['POST', '/api/auth/phone-number/send-otp'],
        ['POST', '/api/auth/phone-number/verify'], ['POST', '/api/auth/phone-number/revoke-consent']]) {
        const response = await dispatchCore(new Request(`https://auth.core.internal${path}`, { method }), env,
          () => assert.fail('SMS bypassed auth release gates'));
        assert.equal(response.status, 503);
      }
    }
  }
});

test('checked-in environments keep SMS and schema-readiness off without embedding secrets', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  for (const name of ['staging', 'production']) {
    assert.equal(config.env[name].vars.AUTH_SMS_OPT_IN_ENABLED, 'false');
    assert.equal(config.env[name].vars.AUTH_SMS_OPT_IN_SCHEMA_READY, 'false');
    assert.equal(Object.keys(config.env[name].vars).some(key => key.startsWith('SENTDM_')), false);
  }
});
