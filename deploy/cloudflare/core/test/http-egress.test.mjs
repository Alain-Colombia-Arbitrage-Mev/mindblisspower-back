import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { containerHttpOutbound, strictHttpEgressEnabled, assertHttpEgressActivationSafe } from '../src/http-egress.mjs';

const strict = { CORE_HTTP_EGRESS_STRICT_ENABLED: 'true', AUTH_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'synthetic-resend-only' };
const resolve = () => assert.fail('unexpected Container target');
const input = (url = 'https://api.resend.com/emails', init = {}) => new Request(url, {
  method: 'POST', headers: { authorization: 'Bearer synthetic-resend-only', 'content-type': 'application/json' }, body: '{"synthetic":true}', ...init,
});

test('strict HTTP egress is explicit and off by default; it never disables general TCP internet access', async () => {
  for (const value of [undefined, 'false']) assert.equal(strictHttpEgressEnabled({ CORE_HTTP_EGRESS_STRICT_ENABLED: value }), false);
  for (const value of [false, true, null, '', 'yes', 'TRUE', 0]) {
    assert.throws(() => strictHttpEgressEnabled({ CORE_HTTP_EGRESS_STRICT_ENABLED: value }), /^Error: http_egress_configuration_unavailable$/);
  }
  let calls = 0;
  const response = await containerHttpOutbound('api', input('https://legacy.example.test/'), {}, resolve, async request => {
    calls++; assert.equal(request.url, 'https://legacy.example.test/'); return new Response('unchanged');
  });
  assert.equal(await response.text(), 'unchanged'); assert.equal(calls, 1);
  const worker = readFileSync(new URL('../src/worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /enableInternet: true/);
  assert.match(worker, /assertHttpEgressActivationSafe\(env\);\s*super\(ctx, env/);
  assert.doesNotMatch(worker, /this\.setOutboundHandler\(/);
  assert.doesNotMatch(worker, /Class\.outbound\s*=/);
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.equal([...config.matchAll(/"CORE_HTTP_EGRESS_STRICT_ENABLED": "false"/g)].length, 2);
});

test('unsupported strict activation and unknown flags fail before installation; disabled mode leaves SDK state untouched', async () => {
  for (const value of [undefined, 'false']) assert.doesNotThrow(() => assertHttpEgressActivationSafe({ CORE_HTTP_EGRESS_STRICT_ENABLED: value }));
  assert.throws(() => assertHttpEgressActivationSafe(strict), /^Error: http_egress_rollback_unavailable$/);
  for (const value of ['', 'yes', null, true]) {
    assert.throws(() => assertHttpEgressActivationSafe({ CORE_HTTP_EGRESS_STRICT_ENABLED: value }), /^Error: http_egress_configuration_unavailable$/);
    const response = await containerHttpOutbound('api', input(), { CORE_HTTP_EGRESS_STRICT_ENABLED: value }, resolve, () => assert.fail('malformed policy reached internet'));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'egress_unavailable' });
  }
});

test('API may send only to its selected exact HTTPS provider contract, once with original bytes and no redirects', async () => {
  for (const status of [200, 422, 429, 503]) {
    let calls = 0;
    const env = { ...strict };
    Object.defineProperty(env, 'CLOUDFLARE_EMAIL_API_TOKEN', { get() { assert.fail('inactive credential read'); } });
    const response = await containerHttpOutbound('api', input(), env, resolve, async request => {
      calls++; assert.equal(request.redirect, 'manual');
      assert.equal(await request.text(), '{"synthetic":true}');
      assert.equal(request.headers.get('authorization'), 'Bearer synthetic-resend-only');
      return new Response('provider-classification', { status });
    });
    assert.equal(response.status, status); assert.equal(await response.text(), 'provider-classification'); assert.equal(calls, 1);
  }
});

test('Cloudflare sending uses only the configured account path and never reads Resend credentials', async () => {
  const account = 'a'.repeat(32);
  const env = { CORE_HTTP_EGRESS_STRICT_ENABLED: 'true', AUTH_EMAIL_PROVIDER: 'cloudflare',
    CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_EMAIL_API_TOKEN: 'synthetic-cloudflare-only' };
  Object.defineProperty(env, 'RESEND_API_KEY', { get() { assert.fail('inactive credential read'); } });
  const response = await containerHttpOutbound('api', input(`https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/send`, {
    headers: { authorization: 'Bearer synthetic-cloudflare-only', 'content-type': 'application/json' },
  }), env, resolve, async () => Response.json({ success: true }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true });
  const denied = await containerHttpOutbound('api', input(`https://api.cloudflare.com/client/v4/accounts/${'b'.repeat(32)}/email/sending/send`), env, resolve, () => assert.fail());
  assert.equal(denied.status, 403);
});

test('strict mode rejects aliases, downgrades, redirects, queries, missing credentials, wrong services and arbitrary origins before egress', async () => {
  for (const url of ['http://api.resend.com/emails', 'https://api.resend.com.evil.test/emails', 'https://api.resend.com/emails?next=x',
    'https://api.resend.com/emails/', 'https://api.resend.com/%65mails', 'https://api.resend.com/usage',
    'https://127.0.0.1/emails', 'https://169.254.169.254/latest/meta-data/', 'https://unknown.core.internal/path',
    'https://api.resend.com:444/emails', 'https://api.resend.com/emails#fragment']) {
    assert.equal((await containerHttpOutbound('api', input(url), strict, resolve, () => assert.fail(url))).status, 403);
  }
  // Native Request rejects URL userinfo before dispatch; retain a defensive
  // parser test for a malformed request-like object at the trust boundary.
  assert.equal((await containerHttpOutbound('api', { url: 'https://user:pass@api.resend.com/emails' }, strict, resolve, () => assert.fail())).status, 403);
  for (const source of ['engine', 'payments', 'withdrawals', 'unrecognized']) {
    assert.equal((await containerHttpOutbound(source, input(), strict, resolve, () => assert.fail(source))).status, 403);
  }
  for (const init of [{ method: 'GET', body: undefined }, { headers: { 'content-type': 'text/plain', authorization: 'Bearer synthetic-resend-only' } },
    { headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-synthetic-key' } },
    { headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-resend-only', 'content-encoding': 'gzip' } }]) {
    assert.equal((await containerHttpOutbound('api', input(undefined, init), strict, resolve, () => assert.fail())).status, 403);
  }
});

test('known private/provider hosts retain their independent capability guard even with catch-all disabled', async () => {
  for (const enabled of ['true', 'false']) {
    const response = await containerHttpOutbound('payments', input('https://api.nowpayments.io/v1/invoice'), {
      CORE_HTTP_EGRESS_STRICT_ENABLED: enabled, CORE_ENV: 'production',
    }, resolve, () => assert.fail('NOW capture gate bypassed'));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'core_not_ready' });
  }
});

test('redirects, oversized bodies and transport errors remain generic without retries or provider fallback', async () => {
  let calls = 0;
  const redirect = await containerHttpOutbound('api', input(), strict, resolve, async () => {
    calls++; return new Response('private-provider-error', { status: 302, headers: { location: 'https://evil.test/' } });
  });
  assert.equal(redirect.status, 503); assert.deepEqual(await redirect.json(), { error: 'egress_unavailable' }); assert.equal(calls, 1);
  const oversized = await containerHttpOutbound('api', input(undefined, { body: 'a'.repeat(128 * 1024 + 1) }), strict, resolve, () => assert.fail());
  assert.equal(oversized.status, 503);
  const failure = await containerHttpOutbound('api', input(), strict, resolve, async () => { calls++; throw new Error('private-token-body'); });
  assert.deepEqual(await failure.json(), { error: 'egress_unavailable' }); assert.equal(calls, 2);
});

test('installed SDK persistence prevents claiming a flag-off or restart-only rollback as verified', () => {
  const sdk = readFileSync(new URL('../node_modules/@cloudflare/containers/dist/lib/container.js', import.meta.url), 'utf8');
  assert.match(sdk, /persistOutboundConfiguration\(configuration\)\s*\{\s*this\.ctx\.storage\.kv\.put/);
  assert.match(sdk, /const persistedOutboundConfiguration = this\.restoreOutboundConfiguration\(\)/);
  assert.match(sdk, /this\.outboundHandlerOverride = configuration\.outboundHandlerOverride/);
  assert.match(sdk, /this\.hasInterceptAllRegistration = configuration\.hasInterceptAllRegistration === true/);
  const runbook = readFileSync(new URL('../HTTP-EGRESS-CANARY.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(runbook, /not approved for production activation/);
  assert.match(runbook, /restarting a Container is not a proven\nrollback/);
  assert.match(runbook, /new isolated Worker, DO namespace and instance/);
});
