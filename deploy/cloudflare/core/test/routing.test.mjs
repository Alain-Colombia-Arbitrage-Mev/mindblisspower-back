import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dispatchCore, dispatchContainerOutbound, isGrpcTunnelRequest, coreReady, authReady, reportsReady, TUNNEL_PROTOCOL } from '../src/routing.mjs';
import { containerEnvironment } from '../src/runtime-env.mjs';

const ready = { CORE_ENV: 'staging', CORE_SERVICES_ENABLED: 'true', CORE_NETWORK_VERIFIED: 'true', CORE_DATA_ACCESS_VERIFIED: 'true', AUTH_CUTOVER_VERIFIED: 'true' };
const request = (path = '/health', init = {}, host = 'auth.core.internal') => new Request(`https://${host}${path}`, init);

test('disabled or incomplete gates never instantiate a container', async () => {
  for (const key of ['CORE_SERVICES_ENABLED', 'CORE_NETWORK_VERIFIED', 'CORE_DATA_ACCESS_VERIFIED']) {
    const response = await dispatchCore(request(), { ...ready, [key]: 'false' }, () => assert.fail('container started'));
    assert.equal(response.status, 503);
  }
  assert.equal((await dispatchCore(request(), { ...ready, CORE_ENV: '' }, () => assert.fail())).status, 503);
});

const authOnlyReady = { ...ready, CORE_SERVICES_ENABLED: 'false', CORE_NETWORK_VERIFIED: 'false', AUTH_SERVICES_ENABLED: 'true' };

test('auth-only launch permits exactly OTP, session, token, JWKS and internal health without asserting Go readiness', async () => {
  assert.equal(coreReady(authOnlyReady), false); assert.equal(authReady(authOnlyReady), true);
  for (const [method, paths] of [
    ['GET', ['/api/auth/get-session', '/api/auth/jwks', '/api/auth/token', '/health']],
    ['POST', ['/api/auth/email-otp/send-verification-otp', '/api/auth/sign-in/email-otp', '/api/auth/sign-out']],
  ]) for (const path of paths) {
    let calls = 0;
    const response = await dispatchCore(request(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) }), authOnlyReady,
      (service, instance) => { calls++; assert.equal(service, 'api'); assert.equal(instance, 'singleton');
        return { fetch: async () => Response.json({ synthetic: true }) }; });
    assert.equal(response.status, 200, `${method} ${path}`); assert.equal(calls, 1);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('auth-only release remains closed with missing, malformed or incomplete auth gates', async () => {
  for (const key of ['AUTH_SERVICES_ENABLED', 'AUTH_CUTOVER_VERIFIED', 'CORE_DATA_ACCESS_VERIFIED']) {
    for (const value of [undefined, 'false', 'TRUE', '1', true]) {
      const env = { ...authOnlyReady, [key]: value };
      assert.equal(authReady(env), false);
      for (const path of ['/api/auth/jwks', '/health']) {
        assert.equal((await dispatchCore(request(path), env, () => assert.fail('unverified API started'))).status, 503);
      }
    }
  }
  assert.equal((await dispatchCore(request('/health'), { ...authOnlyReady, CORE_ENV: 'development' }, () => assert.fail())).status, 503);
});

test('auth-only cannot start business services, claim identity, expand auth paths or accept alternate methods/hosts', async () => {
  for (const [path, method, host] of [
    ['/api/member/identity/claim', 'POST', 'auth.core.internal'],
    ['/api/member/balance', 'GET', 'auth.core.internal'],
    ['/api/affiliates', 'GET', 'core.internal'],
    ['/api/auth/sign-up/email', 'POST', 'auth.core.internal'],
    ['/api/auth/sign-in/email', 'POST', 'auth.core.internal'],
    ['/api/auth/email-otp/check-verification-otp', 'POST', 'auth.core.internal'],
    ['/api/auth/phone-number/send-otp', 'POST', 'auth.core.internal'],
    ['/api/auth/email-otp/reset-password', 'POST', 'auth.core.internal'],
    ['/api/auth/sign-in/email-otp/', 'POST', 'auth.core.internal'],
    ['/api/auth/sign-in/email-otp?target=business', 'POST', 'auth.core.internal'],
    ['/api/auth/sign-in/email-otp', 'GET', 'auth.core.internal'],
    ['/api/auth/sign-in/email-otp', 'OPTIONS', 'auth.core.internal'],
    ['/api/auth/get-session', 'POST', 'auth.core.internal'],
    ['/api/auth/get-session', 'GET', 'core.internal'],
    ['/api/auth/get-session', 'GET', 'payments.core.internal'],
    ['/health', 'GET', 'payments.core.internal'],
    ['/ready', 'GET', 'engine.core.internal'],
    ['/api/withdrawals', 'POST', 'withdrawals.core.internal'],
  ]) {
    const response = await dispatchCore(request(path, { method }, host), authOnlyReady, () => assert.fail('auth-only escaped'));
    assert.equal(response.status, 503, `${method} ${host}${path}`);
  }
  assert.equal((await dispatchCore(new Request('http://auth.core.internal/health'), authOnlyReady, () => assert.fail())).status, 503);
  const tunnel = new Request('http://engine-grpc.core.internal/v1/engine-tunnel', { headers: { upgrade: 'websocket', 'sec-websocket-protocol': TUNNEL_PROTOCOL } });
  assert.equal((await dispatchContainerOutbound('api', tunnel, authOnlyReady, () => assert.fail('Go tunnel started'))).status, 503);
});

test('auth-only preserves signed proxy context, bounded OTP bodies and multiple secure cookies', async () => {
  const input = request('/api/auth/sign-in/email-otp', { method: 'POST', body: '{"otp":"synthetic"}',
    headers: { 'x-vp-auth-signature': 'signed-context', cookie: 'session=synthetic', 'cf-container-target-port': '50051' } });
  const response = await dispatchCore(input, authOnlyReady, () => ({ fetch: async forwarded => {
    assert.equal(forwarded.headers.get('x-vp-auth-signature'), 'signed-context');
    assert.equal(forwarded.headers.get('cookie'), 'session=synthetic');
    assert.equal(forwarded.headers.get('cf-container-target-port'), null);
    assert.equal(forwarded.redirect, 'manual'); assert.equal(await forwarded.text(), '{"otp":"synthetic"}');
    const headers = new Headers();
    for (const name of ['session', 'other']) headers.append('set-cookie', `__Secure-${name}=synthetic; HttpOnly; Secure; SameSite=Lax`);
    return Response.json({ ok: true }, { headers });
  } }));
  assert.equal(response.status, 200); assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal((await dispatchCore(request('/api/auth/sign-in/email-otp', { method: 'POST', body: 'x'.repeat(256 * 1024 + 1) }), authOnlyReady, () => assert.fail())).status, 413);
});

test('reports can release independently for payments/withdrawals reads only without asserting Go transport readiness', async () => {
  const env = { ...authOnlyReady, CORE_REPORTS_ENABLED: 'true' };
  assert.equal(coreReady(env), false); assert.equal(reportsReady(env), true);
  for (const host of ['payments.core.internal', 'withdrawals.core.internal']) {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const response = await dispatchCore(request('/api/member/balance?page=1', { method, headers: { authorization: 'Bearer synthetic' } }, host), env,
        (service, instance) => { assert.equal(service, host.split('.')[0]); assert.equal(instance, 'singleton'); return { fetch: async forwarded => {
          assert.equal(forwarded.method, method); assert.equal(forwarded.headers.get('authorization'), 'Bearer synthetic');
          assert.equal(new URL(forwarded.url).search, '?page=1'); return new Response(null);
        } }; });
      assert.equal(response.status, 200);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await dispatchCore(request('/api/member/balance', { method }, host), env, () => assert.fail('report mutation forwarded'))).status, 503);
    }
  }
  for (const [host, path] of [
    ['core.internal', '/api/affiliates'], ['auth.core.internal', '/api/member/balance'],
    ['engine.core.internal', '/ready'], ['payments.core.internal', '/api/member/identity/claim'],
  ]) assert.equal((await dispatchCore(request(path, {}, host), env, () => assert.fail('reports gate escaped'))).status, 503);
  assert.equal((await dispatchCore(new Request('http://payments.core.internal/api/member/balance'), env, () => assert.fail())).status, 503);
  const tunnel = new Request('http://engine-grpc.core.internal/v1/engine-tunnel', { headers: { upgrade: 'websocket', 'sec-websocket-protocol': TUNNEL_PROTOCOL } });
  assert.equal((await dispatchContainerOutbound('api', tunnel, env, () => assert.fail('gRPC opened by reports'))).status, 503);
});

test('reports require explicit report/data/auth gates and never rely on readiness-probe enablement', async () => {
  const enabled = { ...authOnlyReady, CORE_REPORTS_ENABLED: 'true', CORE_READINESS_PROBE_ENABLED: 'true' };
  for (const key of ['CORE_REPORTS_ENABLED', 'CORE_DATA_ACCESS_VERIFIED', 'AUTH_CUTOVER_VERIFIED']) {
    for (const value of [undefined, 'false', 'TRUE', '1', true]) {
      const env = { ...enabled, [key]: value }; assert.equal(reportsReady(env), false);
      assert.equal((await dispatchCore(request('/api/member/balance', {}, 'payments.core.internal'), env, () => assert.fail())).status, 503);
    }
  }
});

test('private HTTPS JWKS is available to Go consumers when auth is ready but Engine networking is still unverified', async () => {
  for (const source of ['payments', 'withdrawals']) {
    const response = await dispatchContainerOutbound(source, request('/api/auth/jwks'), authOnlyReady, service => {
      assert.equal(service, 'api'); return { fetch: async () => Response.json({ keys: [] }) };
    });
    assert.equal(response.status, 200);
    assert.equal((await dispatchContainerOutbound(source, request('/api/auth/jwks'), { ...authOnlyReady, AUTH_CUTOVER_VERIFIED: 'false' }, () => assert.fail())).status, 503);
  }
  for (const [source, url, init] of [
    ['api', 'https://auth.core.internal/api/auth/jwks', {}],
    ['engine', 'https://auth.core.internal/api/auth/jwks', {}],
    ['payments', 'http://auth.core.internal/api/auth/jwks', {}],
    ['payments', 'https://auth.core.internal/api/auth/token', {}],
    ['payments', 'https://auth.core.internal/api/auth/jwks?target=bad', {}],
    ['payments', 'https://auth.core.internal:444/api/auth/jwks', {}],
    ['withdrawals', 'https://auth.core.internal/api/auth/jwks', { method: 'POST' }],
  ]) assert.equal((await dispatchContainerOutbound(source, new Request(url, init), authOnlyReady, () => assert.fail())).status, 503);
});

test('dispatch uses an exact private hostname and fixed singleton, never user path or headers as origin', async () => {
  let called = 0;
  const resolve = (service, instance) => {
    called++;
    assert.equal(service, 'payments'); assert.equal(instance, 'singleton');
    return { fetch: async forwarded => { assert.equal(new URL(forwarded.url).pathname, '/api/member/balance'); return Response.json({ balance: null }); } };
  };
  const response = await dispatchCore(request('/api/member/balance', {}, 'payments.core.internal'), ready, resolve);
  assert.equal(response.status, 200); assert.equal(called, 1);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  for (const host of ['attacker.example', 'payments.core.internal.attacker.example', 'constructor']) {
    assert.equal((await dispatchCore(request('/health', { headers: { 'x-forwarded-host': 'payments.core.internal' } }, host), ready, () => assert.fail())).status, 404);
  }
});

test('infrastructure release never enables money, placement or withdrawal commands', async () => {
  for (const host of ['payments.core.internal', 'withdrawals.core.internal', 'engine.core.internal', 'auth.core.internal']) {
    const response = await dispatchCore(request('/api/activate', { method: 'POST', body: '{}' }, host), ready, () => assert.fail('business write forwarded'));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'financial_review_required');
  }
});

test('auth requires a separate cutover gate, preserves HMAC/body/cookies and never follows redirects', async () => {
  const input = request('/api/auth/sign-in/email-otp', { method: 'POST', body: '{"otp":"synthetic"}', headers: { 'x-vp-auth-signature': 'signed-context', cookie: 'session=synthetic', origin: 'https://portal.example.invalid', 'cf-container-target-port': '50051' } });
  assert.equal((await dispatchCore(input.clone(), { ...ready, AUTH_CUTOVER_VERIFIED: 'false' }, () => assert.fail())).status, 503);
  const response = await dispatchCore(input, ready, () => ({ fetch: async forwarded => {
    assert.equal(forwarded.headers.get('x-vp-auth-signature'), 'signed-context');
    assert.equal(forwarded.headers.get('cookie'), 'session=synthetic');
    assert.equal(forwarded.headers.get('cf-container-target-port'), null);
    assert.equal(forwarded.redirect, 'manual');
    assert.equal(await forwarded.text(), '{"otp":"synthetic"}');
    const headers = new Headers({ location: 'https://portal.example.invalid/dashboard' });
    headers.append('set-cookie', '__Secure-session=synthetic; HttpOnly; Secure; SameSite=Lax');
    headers.append('set-cookie', '__Secure-other=synthetic; HttpOnly; Secure; SameSite=Lax');
    return new Response(null, { status: 302, headers });
  } }));
  assert.equal(response.status, 302); assert.equal(response.headers.getSetCookie().length, 2);
});

test('streaming and declared body limits fail before resolving a container', async () => {
  const body = 'x'.repeat(256 * 1024 + 1);
  for (const headers of [{}, { 'content-length': String(body.length) }]) {
    const response = await dispatchCore(request('/api/auth/sign-in/email-otp', { method: 'POST', body, headers }), ready, () => assert.fail('oversize forwarded'));
    assert.equal(response.status, 413);
  }
});

test('backend and provider failures have constant sanitized diagnostics', async () => {
  const secret = 'never-reflect-this-private-dsn';
  for (const fetch of [async () => { throw new Error(secret); }, async () => new Response(secret, { status: 500 })]) {
    const response = await dispatchCore(request(), ready, () => ({ fetch }));
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), new RegExp(secret));
  }
});

function apiSecrets() {
  return { ...ready, AUTH_CUTOVER_VERIFIED: 'false',
    API_DATABASE_URL: 'postgres://reader.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    API_AUTH_DATABASE_URL: 'postgres://auth.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    API_AUTH_SECRET: 'a'.repeat(48), API_BFF_SHARED_SECRET: 'b'.repeat(48), API_AUTH_URL: 'https://portal.example.invalid', API_AUTH_ORIGINS: 'https://portal.example.invalid',
    API_ENGINE_GRPC_URL: 'https://private-engine.example.invalid:50051', API_ENGINE_HTTP_URL: 'http://engine.core.internal',
    API_ENGINE_TLS_CA_PEM: 'synthetic-ca', API_ENGINE_TLS_CERT_PEM: 'synthetic-cert', API_ENGINE_TLS_KEY_PEM: 'synthetic-key',
    ENGINE_DATABASE_URL: 'must-not-reach-api', STRIPE_SECRET_KEY: 'must-not-reach-api', BONUS_ENGINE_SCHEDULER_ENABLED: 'true',
  };
}

test('each container receives only scoped secrets and fixed security settings', () => {
  const env = containerEnvironment('api', apiSecrets());
  assert.equal(env.AUTH_DATABASE_POOL_MAX, '4'); assert.equal(env.DATABASE_POOL_MAX, '4');
  assert.equal(env.ENGINE_MTLS_REQUIRED, 'true'); assert.equal(env.BETTER_AUTH_EMAIL_OTP_ENABLED, 'false');
  assert.equal(env.STRIPE_SECRET_KEY, undefined); assert.equal(env.ENGINE_DATABASE_URL, undefined);
  assert.equal(env.BONUS_ENGINE_SCHEDULER_ENABLED, undefined);
  assert.equal(env.VP_ENGINE_TUNNEL_ENABLED, 'true');
  assert.equal(env.VP_ENGINE_TUNNEL_URL, 'ws://engine-grpc.core.internal/v1/engine-tunnel');
  assert.equal(env.VP_ENGINE_HTTP_URL, 'http://engine.core.internal');
  assert.throws(() => containerEnvironment('chatwoot', apiSecrets()));
});

test('opaque tunnel is reachable only from the API outbound binding at a fixed private endpoint', async () => {
  const input = new Request('http://engine-grpc.core.internal/v1/engine-tunnel', { headers: { upgrade: 'websocket', 'sec-websocket-protocol': TUNNEL_PROTOCOL } });
  assert.equal(isGrpcTunnelRequest(input), true);
  let calls = 0;
  const resolve = (service, instance) => {
    calls++; assert.equal(service, 'engine'); assert.equal(instance, 'singleton');
    return { fetch: async forwarded => { assert.equal(forwarded.url, input.url); return new Response('synthetic private transport'); } };
  };
  assert.equal((await dispatchContainerOutbound('api', input, ready, resolve)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await dispatchCore(input, ready, () => assert.fail('public tunnel forwarded'))).status, 404);
  for (const source of ['payments', 'withdrawals', 'engine', 'unknown']) {
    assert.equal((await dispatchContainerOutbound(source, input, ready, () => assert.fail())).status, 404);
  }
  assert.equal((await dispatchContainerOutbound('api', input, { ...ready, CORE_NETWORK_VERIFIED: 'false' }, () => assert.fail())).status, 503);
  for (const [url, headers] of [
    ['http://engine-grpc.core.internal/v1/engine-tunnel?host=attacker.invalid', {}],
    ['https://engine-grpc.core.internal/v1/engine-tunnel', {}],
    ['http://engine-grpc.core.internal/v1/engine-tunnel', { 'sec-websocket-protocol': 'unknown' }],
    ['http://engine-grpc.core.internal:50051/v1/engine-tunnel', {}],
  ]) {
    const bad = new Request(url, { headers: { ...Object.fromEntries(input.headers), ...headers } });
    assert.equal(isGrpcTunnelRequest(bad), false);
    assert.equal((await dispatchContainerOutbound('api', bad, ready, () => assert.fail())).status, 404);
  }
});

test('container HTTP routes permit native Engine reads and HTTPS JWKS only; no gRPC or auth downgrade', async () => {
  const resolve = service => ({ fetch: async () => Response.json({ service }) });
  assert.equal((await dispatchContainerOutbound('api', new Request('http://engine.core.internal/ready'), ready, resolve)).status, 200);
  assert.equal((await dispatchContainerOutbound('payments', new Request('https://auth.core.internal/api/auth/jwks'), ready, resolve)).status, 200);
  for (const [source, url, method] of [
    ['withdrawals', 'http://auth.core.internal/api/auth/jwks', 'GET'],
    ['payments', 'https://auth.core.internal/api/auth/jwks?target=bad', 'GET'],
    ['payments', 'https://auth.core.internal/api/auth/sign-in', 'POST'],
    ['api', 'http://engine.core.internal/vicionpower.v1.LedgerService/PostTransaction', 'POST'],
    ['withdrawals', 'http://engine.core.internal/ready', 'GET'],
    ['engine', 'https://auth.core.internal/api/auth/jwks', 'GET'],
  ]) assert.equal((await dispatchContainerOutbound(source, new Request(url, { method }), ready, () => assert.fail())).status, 404);
});

test('Go services use private HTTPS JWKS with ephemeral and system roots, not configurable public URLs', () => {
  const env = containerEnvironment('withdrawals', { ...ready,
    WITHDRAWALS_DATABASE_URL: 'postgres://reader.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    WITHDRAWALS_SERVICE_TOKEN: 'service-fixture', WITHDRAWALS_BMP_ORIGIN: 'https://portal.example.invalid',
    CORE_SUPER_ADMIN_EMAILS: 'owner@example.invalid',
    AUTH_JWT_ISSUER: 'https://portal.example.invalid', AUTH_JWT_AUDIENCE: 'synthetic', AUTH_JWKS_URL: 'http://attacker.invalid',
  });
  assert.equal(env.BETTER_AUTH_JWKS_URL, 'https://auth.core.internal/api/auth/jwks');
  assert.equal(env.SSL_CERT_DIR, '/etc/ssl/certs:/etc/cloudflare/certs');
  assert.equal(env.SERVICE_READ_ONLY, 'true');
  assert.equal(env.BMP_BASE_URL, undefined);
});

test('read-only report services never receive Stripe or BMP credentials even if present in the Worker', () => {
  const env = containerEnvironment('payments', { ...ready,
    PAYMENTS_DATABASE_URL: 'postgres://reader.branch:synthetic@db.example.invalid/app?sslmode=verify-full',
    PAYMENTS_SERVICE_TOKEN: 'service-fixture', PAYMENTS_ROOT_AFFILIATE_ID: '50793',
    CORE_SUPER_ADMIN_EMAILS: 'owner@example.invalid',
    AUTH_JWT_ISSUER: 'https://portal.example.invalid', AUTH_JWT_AUDIENCE: 'synthetic',
    PAYMENTS_STRIPE_SECRET_KEY: 'must-not-reach-read-service', PAYMENTS_STRIPE_WEBHOOK_SECRET: 'must-not-reach-read-service',
    BMP_CLIENT_SECRET: 'must-not-reach-read-service', SERVICE_READ_ONLY: 'false',
  });
  assert.equal(env.SERVICE_READ_ONLY, 'true');
  assert.equal(env.STRIPE_SECRET_KEY, undefined);
  assert.equal(env.STRIPE_WEBHOOK_SECRET, undefined);
  assert.equal(env.BMP_CLIENT_SECRET, undefined);
  assert.equal(env.PAYMENTS_RECONCILE_INTERVAL_MIN, '0');
  assert.equal(env.PAYMENTS_CART_REMINDER_ENABLED, 'false');
  assert.equal(env.COMMS_ENABLED, 'false');
  assert.equal(env.PAYMENTS_SUPER_ADMIN_EMAILS, 'owner@example.invalid');
});

test('auth isolation, verified TLS and complete secret sets fail closed without leaking values', () => {
  for (const change of [
    { API_AUTH_DATABASE_URL: apiSecrets().API_DATABASE_URL }, { API_AUTH_DATABASE_URL: 'postgres://postgres:secret@db.example.invalid/app?sslmode=verify-full' },
    { API_DATABASE_URL: 'postgres://reader:secret@db.example.invalid/app?sslmode=disable' },
    { API_DATABASE_URL: apiSecrets().API_DATABASE_URL + '&user=postgres' }, { API_AUTH_SECRET: '' },
  ]) {
    assert.throws(() => containerEnvironment('api', { ...apiSecrets(), ...change }), error => !/postgres:\/\//.test(error.message));
  }
});

test('the versioned environments contain no public ingress, scheduler, secrets or Chatwoot resources', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  for (const name of ['staging', 'production']) {
    const env = config.env[name];
    assert.equal(env.workers_dev, false); assert.equal(env.preview_urls, false); assert.deepEqual(env.routes, []);
    assert.equal(env.vars.CORE_SERVICES_ENABLED, 'false');
    assert.equal(env.vars.AUTH_SERVICES_ENABLED, name === 'production' ? 'true' : 'false');
    assert.equal(env.vars.CORE_NETWORK_VERIFIED, 'false');
    assert.equal(env.vars.CORE_READINESS_PROBE_ENABLED, 'false');
    assert.equal(env.vars.CORE_REPORTS_ENABLED, name === 'production' ? 'true' : 'false');
    assert.equal(env.vars.CORE_DATA_ACCESS_VERIFIED, name === 'production' ? 'true' : 'false');
    assert.equal(env.vars.AUTH_CUTOVER_VERIFIED, name === 'production' ? 'true' : 'false');
    assert.equal(env.containers.length, 4);
    assert.ok(env.containers.every(container => container.max_instances === 1 && container.instance_type === 'basic' && container.scheduling_policy === 'default'));
    assert.equal(env.triggers, undefined);
    assert.ok(Object.keys(env.vars).every(key => !/SECRET|TOKEN|PASSWORD|DATABASE_URL/.test(key)));
  }
  assert.doesNotMatch(JSON.stringify(config.containers || []), /chatwoot|sidekiq|rails/i);
});
