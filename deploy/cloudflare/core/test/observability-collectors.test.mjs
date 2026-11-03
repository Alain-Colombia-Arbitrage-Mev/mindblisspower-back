import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { collectOperationalProviders } from '../src/observability-collectors.mjs';

const NOW = Date.parse('2026-11-02T15:00:00Z');
const env = {
  RESEND_MONITOR_API_KEY: 'synthetic_resend_monitor', CLOUDFLARE_MONITOR_API_TOKEN: 'synthetic_cloudflare_monitor',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), PLANETSCALE_MONITOR_SERVICE_TOKEN_ID: 'synthetic_token_id',
  PLANETSCALE_MONITOR_SERVICE_TOKEN: 'synthetic_planetscale_token', PLANETSCALE_MONITOR_ORGANIZATION: 'example-org',
  PLANETSCALE_MONITOR_DATABASE: 'example-db', PLANETSCALE_MONITOR_BRANCH: 'main',
};
const json = value => Response.json(value);
const usage = (used = 100, limit = 50000) => ({ object: 'usage', emails: {
  monthly: { used, limit, sent: used, received: 0, resets_at: '2026-11-26T00:00:00Z' },
  daily: { used: 10, limit: null, sent: 10, received: 0, resets_at: '2026-11-03T00:00:00Z' },
} });
function workers({ coreCpu = 10000, portalCpu = 5000, requests = 100, errors = 0, exceeded = 0 } = {}) {
  const account = {};
  for (const [alias, cpu] of [['core', coreCpu], ['portal', portalCpu], ['admin', 100000]]) {
    account[alias] = [{ sum: { requests, errors }, quantiles: { cpuTimeP99: cpu } }];
    account[`${alias}Outcomes`] = [{ sum: { requests: Math.max(0, requests - exceeded) }, dimensions: { status: 'success' } },
      ...(exceeded ? [{ sum: { requests: exceeded }, dimensions: { status: 'exceededResources' } }] : [])];
  }
  return { data: { viewer: { accounts: [account] } }, errors: null };
}
const series = ({ cpu = 20, memory = 50, lag = 0, at = NOW / 1000 } = {}) => ({ series: [
  { metric: 'planetscale_pods_cpu_util_percentages', points: [[at, cpu]] },
  { metric: 'planetscale_pods_mem_util_percentages', points: [[at, memory]] },
  { metric: 'planetscale_replica_lag_seconds', points: [[at, lag]] },
] });
const instant = ({ storage = 25 } = {}) => ({ metrics: [
  { metric: 'planetscale_volume_usage_percentage', values: [{ value: storage }] },
  { metric: 'planetscale_pgbouncer_current_client_connections', values: [{ value: 10, pod: 'node-a' }] },
  { metric: 'planetscale_pgbouncer_settings_max_client_conn', values: [{ value: 100, pod: 'node-a' }] },
] });
function fixture(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://api.resend.com/usage') return json(overrides.resend ?? usage());
    if (url === 'https://api.cloudflare.com/client/v4/graphql') return json(overrides.workers ?? workers());
    if (new URL(url).pathname.endsWith('/metrics/instant')) return json(overrides.instant ?? instant());
    if (new URL(url).pathname.endsWith('/metrics')) return json(overrides.series ?? series());
    assert.fail(`Unexpected URL ${url}`);
  };
  return { calls, fetchImpl };
}
const run = (config, fetchImpl) => collectOperationalProviders(config, { fetchImpl, now: NOW });

test('without dedicated monitor credentials nothing is queried and absence is unknown, not zero', async () => {
  const value = await run({ RESEND_API_KEY: 'sending_key_not_for_monitoring', RESEND_API: 'other_sending_key' }, () => assert.fail('No network'));
  assert.equal(value.observed_at, '2026-11-02T15:00:00.000Z');
  assert.equal(value.email[0].status, 'unknown');
  assert.equal(value.email[0].used, null);
  assert.equal(value.email[0].limit, null);
  for (const service of value.infrastructure) {
    assert.equal(service.status, 'unknown');
    assert.ok(service.metrics.every(metric => metric.value === null && metric.source === 'unavailable'));
  }
});

test('Core name and explicit CPU limit stay aligned with its deployment file', () => {
  const core = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(core.env.production.name, 'mindbliss-core-production');
  assert.equal(core.limits.cpu_ms, 50);
});

test('fixed read-only APIs, provider reset dates and actual Worker names/CPU limits', async () => {
  const f = fixture(); const value = await run(env, f.fetchImpl);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(value.email.map(item => item.period), ['provider_month', 'day']);
  assert.equal(value.email[0].window_start, null);
  assert.equal(value.email[0].window_end, '2026-11-26T00:00:00.000Z');
  assert.equal(value.email[0].used, 100); assert.equal(value.email[0].limit, 50000);
  assert.equal(value.email[1].limit, null); assert.equal(value.email[1].status, 'ok');
  for (const item of value.email) {
    for (const key of ['accepted', 'delivered', 'bounced', 'rejected', 'tracking_started_at']) assert.equal(item[key], null);
  }
  const worker = value.infrastructure[0]; assert.equal(worker.status, 'ok');
  const byName = Object.fromEntries(worker.metrics.map(item => [item.name, item]));
  assert.equal(byName['mindbliss-core-production.cpu_p99_ms'].value, 10);
  assert.equal(byName['mindbliss-core-production.cpu_p99_ms'].threshold, 40);
  assert.equal(byName['mindbliss-portal-production.cpu_p99_ms'].threshold, 24000);
  assert.equal(byName['mindbliss-admin-production.cpu_p99_ms'].threshold, null);
  const cf = f.calls.find(call => call.url.includes('cloudflare.com'));
  const query = JSON.parse(cf.options.body);
  assert.equal(query.variables.start, '2026-11-02T14:55:00.000Z');
  for (const name of ['mindbliss-core-production', 'mindbliss-portal-production', 'mindbliss-admin-production']) assert.ok(query.query.includes(name));
  assert.ok(!query.query.includes('mutation'));
  for (const { options, url } of f.calls) {
    assert.equal(options.redirect, 'manual'); assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.method, url.includes('graphql') ? 'POST' : 'GET');
    assert.equal(new Headers(options.headers).has('cookie'), false);
  }
  const ps = f.calls.filter(call => call.url.includes('planetscale.com'));
  assert.equal(ps.length, 2);
  assert.ok(ps.every(call => new Headers(call.options.headers).get('authorization') === 'synthetic_token_id:synthetic_planetscale_token'));
  assert.ok(ps.every(call => new URL(call.url).pathname.startsWith('/v1/organizations/example-org/databases/example-db/branches/main/metrics')));
  assert.equal(new URL(ps.find(call => !call.url.includes('/instant')).url).searchParams.get('steps'), '5');
  assert.equal(value.infrastructure[1].status, 'ok');
  assert.ok(value.infrastructure[1].metrics.every(item => item.source === 'provider'));
  assert.ok(!JSON.stringify(value).includes('synthetic_'));
});

test('Resend quota thresholds and unlimited/zero cap honor provider, not a hard-coded 50000', async () => {
  for (const [used, limit, status] of [[79, 100, 'ok'], [80, 100, 'warn'], [95, 100, 'critical'], [101, 100, 'critical'], [0, 0, 'critical'], [100000, null, 'ok']]) {
    const f = fixture({ resend: usage(used, limit) });
    const value = await run({ RESEND_MONITOR_API_KEY: env.RESEND_MONITOR_API_KEY }, f.fetchImpl);
    assert.equal(value.email[0].status, status);
    assert.equal(value.email[0].limit, limit);
  }
});

test('invalid or expired Resend usage is unknown without leaking payloads', async () => {
  for (const bad of [null, {}, { object: 'emails', emails: usage().emails },
    usage('12'), usage(1, '50000'), { object: 'usage', emails: { monthly: { used: 1, limit: 100, resets_at: '2026-10-01T00:00:00Z' } } }]) {
    const value = await run({ RESEND_MONITOR_API_KEY: env.RESEND_MONITOR_API_KEY }, async () => json(bad));
    assert.equal(value.email[0].status, 'unknown');
    assert.equal(value.email[0].coverage, 'unknown');
  }
});

test('Worker CPU is converted from microseconds, not mistaken for ms or wall latency', async () => {
  for (const [options, status] of [[{ coreCpu: 40000 }, 'warn'], [{ coreCpu: 50000 }, 'critical'],
    [{ portalCpu: 24000000 }, 'warn'], [{ portalCpu: 30000000 }, 'critical'], [{ errors: 1 }, 'warn'], [{ errors: 5 }, 'critical'], [{ exceeded: 1 }, 'critical']]) {
    const f = fixture({ workers: workers(options) });
    const value = await run({ CLOUDFLARE_MONITOR_API_TOKEN: env.CLOUDFLARE_MONITOR_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID }, f.fetchImpl);
    assert.equal(value.infrastructure[0].status, status, JSON.stringify(options));
  }
});

test('Worker no traffic, missing outcome, malformed or GraphQL permission errors never report healthy', async () => {
  const missing = workers(); delete missing.data.viewer.accounts[0].portalOutcomes;
  const invalid = workers(); invalid.data.viewer.accounts[0].core[0].sum.errors = 200;
  for (const sample of [workers({ requests: 0 }), missing, invalid, { errors: [{ message: 'token secret@example.com' }] }, { data: { viewer: { accounts: [] } } }]) {
    const value = await run({ CLOUDFLARE_MONITOR_API_TOKEN: env.CLOUDFLARE_MONITOR_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID }, async () => json(sample));
    assert.equal(value.infrastructure[0].status, 'unknown');
    assert.ok(!JSON.stringify(value).includes('secret@example.com'));
  }
});

test('PlanetScale reports recent real CPU/memory/storage/lag thresholds and rejects future/stale samples', async () => {
  const config = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('PLANETSCALE_')));
  for (const [overrides, status] of [[{ series: series({ cpu: 80 }) }, 'warn'], [{ series: series({ cpu: 95 }) }, 'critical'],
    [{ series: series({ memory: 85 }) }, 'warn'], [{ series: series({ lag: 60 }) }, 'critical'],
    [{ instant: instant({ storage: 90 }) }, 'critical'], [{ series: series({ at: NOW / 1000 - 3600 }) }, 'unknown'],
    [{ series: series({ at: NOW / 1000 + 30 }) }, 'unknown'], [{ series: series({ cpu: 101 }) }, 'unknown']]) {
    const f = fixture(overrides); const value = await run(config, f.fetchImpl);
    assert.equal(value.infrastructure[1].status, status, JSON.stringify(overrides));
  }
});

test('PlanetScale does not invent connection utilization from different nodes', async () => {
  const sample = instant(); sample.metrics[2].values[0].pod = 'node-b';
  const f = fixture({ instant: sample }); const value = await run(env, f.fetchImpl);
  assert.equal(value.infrastructure[1].metrics.find(item => item.name === 'client_connections').value, 10);
  assert.equal(value.infrastructure[1].metrics.find(item => item.name === 'max_client_connections').value, 100);
  assert.equal(value.infrastructure[1].metrics.find(item => item.name === 'client_connection_utilization_percent').value, null);
  assert.equal(value.infrastructure[1].status, 'unknown');
});

test('connection utilization compares identical complete dimensions and alerts on the worst matching node', async () => {
  const sample = instant();
  sample.metrics[1].values = [{ value: 10, pod: 'a', zone: 'a' }, { value: 99, pod: 'b', zone: 'b' }];
  sample.metrics[2].values = [{ value: 100, zone: 'b', pod: 'b' }, { value: 100, zone: 'a', pod: 'a' }];
  const f = fixture({ instant: sample }); const value = await run(env, f.fetchImpl);
  assert.equal(value.infrastructure[1].metrics.find(item => item.name === 'client_connection_utilization_percent').value, 99);
  assert.equal(value.infrastructure[1].status, 'critical');
  for (const mutate of [
    value => { value.metrics[2].values[0].zone = 'different'; },
    value => { value.metrics[2].values.push({ ...value.metrics[2].values[0] }); },
    value => { value.metrics[2].values[0].value = 0; },
    value => { value.metrics[2].values[0].value = '100'; },
    value => { value.metrics[2].values[0].pod = { value: 'b' }; },
  ]) {
    const invalid = structuredClone(sample); mutate(invalid);
    const f = fixture({ instant: invalid }); const value = await run(env, f.fetchImpl);
    assert.equal(value.infrastructure[1].metrics.find(item => item.name === 'client_connection_utilization_percent').value, null);
    assert.equal(value.infrastructure[1].status, 'unknown');
  }
});

test('one PlanetScale subresource failing preserves the other sample and unknown coverage', async () => {
  const f = fixture();
  const value = await run(env, (url, options) => url.includes('/metrics/instant') ? Promise.resolve(new Response('unavailable', { status: 503 })) : f.fetchImpl(url, options));
  assert.equal(value.infrastructure[1].status, 'unknown');
  assert.equal(value.infrastructure[1].metrics.find(item => item.name === 'cpu_percent').value, 20);
  assert.equal(value.infrastructure[1].metrics.find(item => item.name === 'storage_percent').value, null);
});

test('unsafe configuration cannot select a destination, path, headers, SQL or sending key', async () => {
  for (const config of [
    { ...env, RESEND_MONITOR_API_KEY: 'bad\r\nsecret', CLOUDFLARE_MONITOR_API_TOKEN: 'bad\nsecret', PLANETSCALE_MONITOR_ORGANIZATION: '../other' },
    { ...env, RESEND_MONITOR_API_KEY: null, CLOUDFLARE_ACCOUNT_ID: 'https://evil.test', PLANETSCALE_MONITOR_DATABASE: 'foo?token=bar' },
    { ...env, RESEND_MONITOR_API_KEY: '', CLOUDFLARE_MONITOR_API_TOKEN: '', PLANETSCALE_MONITOR_BRANCH: 'main%2F..' },
  ]) {
    const value = await run(config, () => assert.fail('No fetch for invalid config'));
    assert.equal(value.email[0].status, 'unknown'); assert.ok(value.infrastructure.every(item => item.status === 'unknown'));
  }
});

test('HTTP denial, redirects, non-JSON, oversized and malformed bodies are bounded unknown with no retry or raw errors', async () => {
  for (const make of [() => new Response('secret', { status: 403 }), () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    () => new Response('secret', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '500000' } }),
    () => new Response('x'.repeat(200000), { headers: { 'content-type': 'application/json' } }),
    () => new Response('secret invalid JSON', { headers: { 'content-type': 'application/json' } }),
    () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } })]) {
    let calls = 0;
    const value = await run(env, async () => { calls++; return make(); });
    assert.equal(calls, 4); assert.ok(value.infrastructure.every(item => item.status === 'unknown'));
    assert.equal(value.email[0].status, 'unknown'); assert.ok(!JSON.stringify(value).includes('secret'));
  }
});

test('deadline covers both provider connection and response body without retries', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const blocked = run(env, () => { calls++; return new Promise(() => {}); });
  context.mock.timers.tick(4001);
  const value = await blocked;
  assert.equal(calls, 4); assert.ok(value.infrastructure.every(item => item.status === 'unknown'));
  let bodyCalls = 0;
  const body = run(env, async () => {
    bodyCalls++;
    return new Response(new ReadableStream({ start() {}, cancel() { return new Promise(() => {}); } }), { headers: { 'content-type': 'application/json' } });
  });
  await Promise.resolve(); await Promise.resolve();
  context.mock.timers.tick(4001);
  assert.equal((await body).email[0].status, 'unknown'); assert.equal(bodyCalls, 4);
});

test('caller cannot inject invalid observation time', async () => {
  for (const now of [NaN, Infinity, '2026-11-02', -1]) {
    await assert.rejects(collectOperationalProviders({}, { now, fetchImpl: () => assert.fail('No network') }), /Invalid observation time/);
  }
});
