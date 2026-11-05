import test from 'node:test';
import assert from 'node:assert/strict';
import { containerEnvironment } from '../src/runtime-env.mjs';

const fixture = () => ({ CORE_ENV: 'production', AUTH_CUTOVER_VERIFIED: 'true',
  API_DATABASE_URL: 'postgres://reader.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
  API_AUTH_DATABASE_URL: 'postgres://auth.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
  API_AUTH_SECRET: 'a'.repeat(48), API_BFF_SHARED_SECRET: 'b'.repeat(48),
  API_AUTH_URL: 'https://portal.example.invalid', API_AUTH_ORIGINS: 'https://portal.example.invalid',
  API_ENGINE_GRPC_URL: 'https://private-engine.example.invalid:50051',
  API_ENGINE_TLS_CA_PEM: 'synthetic-ca', API_ENGINE_TLS_CERT_PEM: 'synthetic-cert', API_ENGINE_TLS_KEY_PEM: 'synthetic-key',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-email-key',
  AUTH_EMAIL_FROM: 'auth@example.invalid', AUTH_JWT_ISSUER: 'https://portal.example.invalid', AUTH_JWT_AUDIENCE: 'synthetic',
});
const unreadable = (env, keys) => {
  for (const key of keys) Object.defineProperty(env, key, { get: () => assert.fail(`inactive setting read: ${key}`) });
  return env;
};

test('branch portals append exact trusted origins without changing credentials, issuer or existing origins', () => {
  const env = { ...fixture(), API_AUTH_ORIGINS: 'https://mindblisspower.com,https://admin.mindblisspower.com',
    API_AUTH_ADDITIONAL_ORIGINS: 'https://app.mindblisspower.com,https://mindbliss-portal-rewon.devfidubit.workers.dev' };
  const values = containerEnvironment('api', env);
  assert.equal(values.BETTER_AUTH_TRUSTED_ORIGINS, `${env.API_AUTH_ORIGINS},${env.API_AUTH_ADDITIONAL_ORIGINS}`);
  assert.equal(values.BETTER_AUTH_URL, env.API_AUTH_URL);
  assert.equal(values.BETTER_AUTH_JWT_ISSUER, env.AUTH_JWT_ISSUER);
  assert.equal(values.BETTER_AUTH_JWT_AUDIENCE, env.AUTH_JWT_AUDIENCE);
  assert.equal(values.BETTER_AUTH_SECRET, env.API_AUTH_SECRET);
  assert.equal(containerEnvironment('api', { ...env, API_AUTH_ORIGINS: values.BETTER_AUTH_TRUSTED_ORIGINS }).BETTER_AUTH_TRUSTED_ORIGINS, values.BETTER_AUTH_TRUSTED_ORIGINS);
});

test('additional auth origins reject wildcards, lookalikes, insecure hosts and malformed configuration', () => {
  for (const origin of ['', null, true, ['https://app.mindblisspower.com'],
    'https://*.mindblisspower.com', 'https://app.mindblisspower.com.evil.test',
    'http://app.mindblisspower.com', 'https://app.mindblisspower.com/',
    'https://app.mindblisspower.com:443', ' https://app.mindblisspower.com',
    'https://app.mindblisspower.com,', 'https://app.mindblisspower.com\r\n',
    'https://*.workers.dev', 'https://other.devfidubit.workers.dev',
    'https://mindbliss-portal-rewon.other.workers.dev',
    'https://mindbliss-portal-rewon.devfidubit.workers.dev.evil.test',
    'http://mindbliss-portal-rewon.devfidubit.workers.dev',
    'https://mindbliss-portal-rewon.devfidubit.workers.dev/',
    'https://mindbliss-portal-rewon.devfidubit.workers.dev:443',
    'https://MINDBLISS-PORTAL-REWON.devfidubit.workers.dev']) {
    assert.throws(() => containerEnvironment('api', { ...fixture(), API_AUTH_ADDITIONAL_ORIGINS: origin }),
      { message: 'Invalid additional authentication origins' });
  }
  assert.equal(containerEnvironment('api', fixture()).BETTER_AUTH_TRUSTED_ORIGINS, fixture().API_AUTH_ORIGINS);
});

test('legacy and explicit Cloudflare configuration preserve transport and do not read Resend', () => {
  for (const provider of [undefined, 'cloudflare']) {
    const env = unreadable({ ...fixture(), AUTH_EMAIL_PROVIDER: provider }, ['RESEND_API_KEY']);
    const values = containerEnvironment('api', env);
    assert.equal(values.AUTH_EMAIL_PROVIDER, 'cloudflare');
    assert.equal(values.CLOUDFLARE_EMAIL_API_TOKEN, 'synthetic-email-key');
    assert.equal(values.RESEND_API_KEY, undefined);
  }
});

test('Resend reads and forwards only its own key to the API', () => {
  const env = unreadable({ ...fixture(), AUTH_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_synthetic-not-real' },
    ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN', 'SENTDM_API_KEY', 'BREVO_API_KEY']);
  const values = containerEnvironment('api', env);
  assert.equal(values.AUTH_EMAIL_PROVIDER, 'resend');
  assert.equal(values.RESEND_API_KEY, 're_synthetic-not-real');
  assert.equal(values.AUTH_EMAIL_FROM, 'auth@example.invalid');
  assert.equal(values.BETTER_AUTH_EMAIL_OTP_ENABLED, 'true');
  assert.equal(values.BETTER_AUTH_PHONE_OTP_ENABLED, 'false');
  assert.equal(values.BETTER_AUTH_JWT_ENABLED, 'true');
  for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN', 'SENTDM_API_KEY', 'BREVO_API_KEY']) {
    assert.equal(values[key], undefined);
  }
});

test('malformed and unsupported explicit providers fail closed rather than defaulting', () => {
  for (const provider of ['', 'RESEND', 'resend ', 'brevo', 'cloudflare ', null, true, {}, ['resend']]) {
    assert.throws(() => containerEnvironment('api', { ...fixture(), AUTH_EMAIL_PROVIDER: provider }),
      { message: 'Invalid email provider configuration' });
  }
});

test('selected Resend credential and common email configuration must be present and bounded', () => {
  for (const key of ['RESEND_API_KEY', 'AUTH_EMAIL_FROM', 'AUTH_JWT_ISSUER', 'AUTH_JWT_AUDIENCE']) {
    for (const value of [undefined, '', ' ', {}, 'bad\r\nvalue', 'a'.repeat(4097)]) {
      assert.throws(() => containerEnvironment('api', { ...fixture(), AUTH_EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_synthetic-not-real', [key]: value }), { message: 'Email authentication secrets are incomplete' });
    }
  }
});

test('configured inactive keys never rescue a missing selected credential', () => {
  assert.throws(() => containerEnvironment('api', { ...fixture(), AUTH_EMAIL_PROVIDER: 'resend' }),
    { message: 'Email authentication secrets are incomplete' });
  assert.throws(() => containerEnvironment('api', { ...fixture(), RESEND_API_KEY: 're_synthetic-not-real',
    CLOUDFLARE_EMAIL_API_TOKEN: undefined }), { message: 'Email authentication secrets are incomplete' });
});

test('credentials with whitespace cannot reach an authorization header', () => {
  for (const value of [' re_synthetic', 're_synthetic ', 're_ synthetic', 're_\tsynthetic']) {
    assert.throws(() => containerEnvironment('api', { ...fixture(), AUTH_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: value }),
      { message: 'Email authentication secrets are incomplete' });
  }
});

test('disabled authentication does not read or forward either email provider', () => {
  const env = unreadable({ ...fixture(), AUTH_CUTOVER_VERIFIED: 'false' },
    ['AUTH_EMAIL_PROVIDER', 'RESEND_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN', 'AUTH_EMAIL_FROM']);
  const values = containerEnvironment('api', env);
  assert.equal(values.BETTER_AUTH_EMAIL_OTP_ENABLED, 'false');
  assert.equal(values.BETTER_AUTH_JWT_ENABLED, 'false');
  for (const key of ['AUTH_EMAIL_PROVIDER', 'RESEND_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN', 'AUTH_EMAIL_FROM']) {
    assert.equal(values[key], undefined);
  }
});

test('no Go container reads or receives email provider settings', () => {
  const env = unreadable({ ...fixture(),
    ENGINE_DATABASE_URL: 'postgres://engine.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    ENGINE_ROOT_AFFILIATE_ID: '50793', ENGINE_TLS_CERT_PEM: 'synthetic', ENGINE_TLS_KEY_PEM: 'synthetic', ENGINE_TLS_CLIENT_CA_PEM: 'synthetic',
    PAYMENTS_DATABASE_URL: 'postgres://payments.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    PAYMENTS_SERVICE_TOKEN: 'synthetic', PAYMENTS_ROOT_AFFILIATE_ID: '50793', CORE_SUPER_ADMIN_EMAILS: 'owner@example.invalid',
    WITHDRAWALS_DATABASE_URL: 'postgres://withdrawals.branch:synthetic@db.example.invalid/app?sslmode=verify-full', WITHDRAWALS_SERVICE_TOKEN: 'synthetic',
  }, ['AUTH_EMAIL_PROVIDER', 'RESEND_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN', 'AUTH_EMAIL_FROM']);
  for (const service of ['engine', 'payments', 'withdrawals']) {
    const values = containerEnvironment(service, env);
    for (const key of ['AUTH_EMAIL_PROVIDER', 'RESEND_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN', 'AUTH_EMAIL_FROM']) {
      assert.equal(values[key], undefined);
    }
  }
});
