import test from 'node:test';
import assert from 'node:assert/strict';
import { walletSandboxEnvironment, walletSandboxRequestAllowed } from '../src/wallet-sandbox-runtime.mjs';
const base = 'https://wallet.core.internal/api/member/sandbox-wallet';
const headers = { origin: 'https://wallet.mindblisspower.com', 'x-mindbliss-sandbox-subject': 'synthetic-owner' };
const env = () => ({ API_DATABASE_URL: 'postgres://sandbox_reader:test@db.example.test/mindbliss?sslmode=verify-full',
  API_AUTH_DATABASE_URL: 'postgres://sandbox_auth:test@db.example.test/mindbliss?sslmode=verify-full', API_AUTH_SECRET: 'a'.repeat(64),
  API_BFF_SHARED_SECRET: 'b'.repeat(64), MELD_API_SANDBOX: 'synthetic-sandbox-key', MELD_ACCOUNT_ID: 'synthetic-sandbox-account' });

test('isolated container receives only the sandbox merchant and explicit native session configuration', () => {
  const value = walletSandboxEnvironment({ ...env(), API_PIMLICO_API_KEY: 'must-not-pass', MELD_API_KEY: 'production-must-not-pass',
    REOWN_PROJECT_ID: 'must-not-pass', RESEND_API_KEY: 'must-not-pass', API_ENGINE_TLS_KEY_PEM: 'must-not-pass', PERSONAL_POLYGON_RELAY_ENABLED: 'true' });
  assert.equal(value.MELD_API_SANDBOX, 'synthetic-sandbox-key');
  assert.equal(value.BETTER_AUTH_TRUSTED_ORIGINS, headers.origin);
  assert.equal(value.WALLET_SANDBOX_REOWN_ENABLED, 'true');
  assert.equal(value.PERSONAL_POLYGON_RELAY_ENABLED, 'false');
  assert.equal(value.BETTER_AUTH_EMAIL_OTP_ENABLED, 'false');
  for (const key of ['API_PIMLICO_API_KEY', 'PIMLICO_API_KEY', 'MELD_API_KEY', 'REOWN_PROJECT_ID', 'RESEND_API_KEY', 'API_ENGINE_TLS_KEY_PEM']) assert.equal(value[key], undefined, key);
});
test('database ambiguity, administrator credentials, mismatched targets and missing secrets fail before process startup', () => {
  for (const change of [{ API_AUTH_SECRET: '' }, { API_BFF_SHARED_SECRET: 'short' }, { API_DATABASE_URL: 'postgres://postgres:test@db.example.test/mindbliss?sslmode=verify-full' },
    { API_AUTH_DATABASE_URL: env().API_DATABASE_URL }, { API_AUTH_DATABASE_URL: env().API_AUTH_DATABASE_URL.replace('/mindbliss?', '/other?') },
    { API_DATABASE_URL: env().API_DATABASE_URL + '&user=postgres' }, { API_DATABASE_URL: env().API_DATABASE_URL + '&sslmode=disable' },
    { API_DATABASE_URL: env().API_DATABASE_URL.replace('verify-full', 'disable') }]) assert.throws(() => walletSandboxEnvironment({ ...env(), ...change }), /wallet_sandbox_configuration/);
});
test('only exact sandbox methods and queries enter the private container', () => {
  for (const path of ['/status', '/capabilities', '/funding/history', '/funding/options?country=US&sourceCurrencyCode=USD', '/funding/options?country=MX&sourceCurrencyCode=MXN',
    '/funding/status?checkoutReference=11111111-1111-4111-8111-111111111111']) assert.equal(walletSandboxRequestAllowed(new Request(base + path, { headers })), true, path);
  for (const path of ['/challenge', '/verify', '/funding/session']) assert.equal(walletSandboxRequestAllowed(new Request(base + path, { method: 'POST', headers })), true, path);
  for (const url of [base + '/status?owner=other', base + '/funding/options?country=CO&sourceCurrencyCode=MXN', base + '/funding/options?country=MX&sourceCurrencyCode=USD&serviceProvider=BANXA',
    base.replace('/sandbox-wallet', '/company-payments') + '/submit', base.replace('/member/sandbox-wallet', '/auth') + '/sign-up/email', base.replace('wallet.core.internal', 'auth.core.internal') + '/status',
    base + '/funding/status?checkoutReference=invalid', base + '/funding/session?walletAddress=other']) assert.equal(walletSandboxRequestAllowed(new Request(url, { headers })), false, url);
});
test('foreign portal, stale-subject envelope and impersonation are rejected without a container start', () => {
  for (const change of [{ origin: 'https://app.mindblisspower.com' }, { origin: 'https://wallet.mindblisspower.com.evil.test' },
    { 'x-mindbliss-sandbox-subject': '' }, { 'x-mindbliss-sandbox-subject': '%73ynthetic-owner' }, { 'x-mindbliss-sandbox-subject': 'has%20space' }, { 'x-vp-act-as': 'other' }])
    assert.equal(walletSandboxRequestAllowed(new Request(base + '/status', { headers: { ...headers, ...change } })), false);
});
test('production mode passes exactly its merchant/account and never forwards sandbox credentials or broadcast secrets', () => {
  const result = walletSandboxEnvironment({ ...env(), WALLET_MELD_PRODUCTION_ENABLED: 'true', MELD_PRODUCTION_API_KEYS: 'production-synthetic',
    MELD_PRODUCTION_ACCOUNT_ID: 'production-account', PIMLICO_API_KEY: 'never', MELD_API_KEY: 'legacy-never' });
  assert.equal(result.ENV, 'production'); assert.equal(result.MELD_PRODUCTION_API_KEYS, 'production-synthetic');
  assert.equal(result.MELD_PRODUCTION_ACCOUNT_ID, 'production-account'); assert.equal(result.MELD_ADMIN_SANDBOX_ENABLED, 'false');
  for (const key of ['MELD_API_SANDBOX', 'MELD_ACCOUNT_ID', 'PIMLICO_API_KEY', 'MELD_API_KEY']) assert.equal(result[key], undefined);
  assert.throws(() => walletSandboxEnvironment({ ...env(), WALLET_MELD_PRODUCTION_ENABLED: 'true' }), /configuration/);
});
test('production native namespace has separate owner fence, exact methods/query admission and no old personal payment APIs', () => {
  const root = 'https://wallet.core.internal/api/member/wallet-funding', owner = { origin: headers.origin, 'x-mindbliss-wallet-subject': 'synthetic-owner' };
  for (const path of ['/capabilities', '/discovery', '/discovery?country=ES', '/options?country=CO&sourceCurrencyCode=COP', '/history', '/status?checkoutReference=11111111-1111-4111-8111-111111111111'])
    assert.equal(walletSandboxRequestAllowed(new Request(root + path, { headers: owner })), true, path);
  for (const action of ['/quote', '/session']) assert.equal(walletSandboxRequestAllowed(new Request(root + action, { method: 'POST', headers: owner })), true);
  for (const path of ['/discovery?country=MX&country=CO', '/options?country=US&sourceCurrencyCode=USD&provider=BANXA', '/history?owner=other', '/submit', '/session?walletAddress=other', '/options?country=%55%53&sourceCurrencyCode=USD', '/discovery?%63ountry=US'])
    assert.equal(walletSandboxRequestAllowed(new Request(root + path, { headers: owner })), false, path);
  assert.equal(walletSandboxRequestAllowed(new Request(root + '/capabilities', { headers })), false);
});
