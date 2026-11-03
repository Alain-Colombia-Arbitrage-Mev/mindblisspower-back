import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { estimateMonthlyCost, INSTANCE_TYPES, RATE_CARD, zeroAccountUsage } from './cost-model.mjs';

function scenario() {
  return {
    name: 'synthetic-test', pricingDate: '2026-10-25', monthHours: 720,
    containers: [], workers: { requests: 0, averageCpuMsPerRequest: 0 },
    durableObjects: { billedRequests: 0, nonHibernatingInstanceHours: 0 },
    logs: { events: 0 }, r2Standard: { gbMonths: 0, classAOperations: 0, classBOperations: 0 },
    containerEgressGb: { northAmericaEurope: 0, oceaniaKoreaTaiwan: 0, other: 0 },
    existingAccountUsage: zeroAccountUsage(),
    otherCosts: ['postgresql', 'redis', 'email-delivery', 'other-cloudflare', 'taxes-and-other'].map((name) => ({
      name, monthlyUsd: null, note: 'Unknown in this offline synthetic test',
    })),
    notes: ['Synthetic inputs, not measured production usage'],
  };
}

function basic(overrides = {}) {
  return { name: 'api', environment: 'production', instanceType: 'basic', instances: 1,
    activeHoursPerInstance: 720, averageActiveVcpu: 0.02, ...overrides };
}

test('exports dated official sources and immutable instance/rate definitions', () => {
  assert.equal(RATE_CARD.checkedOn, '2026-10-25');
  assert.equal(RATE_CARD.validBefore, '2026-12-01');
  assert.equal(Object.keys(RATE_CARD.sources).length, 4);
  assert.ok(Object.values(RATE_CARD.sources).every((url) => url.startsWith('https://developers.cloudflare.com/')));
  assert.deepEqual(INSTANCE_TYPES.lite, { vcpu: 0.0625, memoryGib: 0.25, diskGb: 2 });
  assert.throws(() => { INSTANCE_TYPES.basic.memoryGib = 100; }, TypeError);
  assert.throws(() => { RATE_CARD.containers.cpuUsdPerVcpuSecond = 0; }, TypeError);
});

test('never presents unknown external costs as free or a complete monthly budget', () => {
  const result = estimateMonthlyCost(scenario());
  assert.equal(result.cloudflare.modeledCloudflareAccountSubtotalUsd, 5);
  assert.equal(result.completeMonthlyBudgetUsd, null);
  assert.equal(result.unpricedCosts.length, 5);
  assert.equal(result.cloudflare.projectUsageIncrementalUsd, 0);
});

test('memory and disk use provisioned resources; CPU uses active usage rather than reserved capacity', () => {
  const input = scenario();
  input.containers = [basic()];
  const result = estimateMonthlyCost(input);
  assert.equal(result.accountUsage.project.containerMemoryGibSeconds, 720 * 3600);
  assert.equal(result.accountUsage.project.containerCpuVcpuSeconds, 720 * 3600 * 0.02);
  assert.equal(result.accountUsage.project.containerDiskGbSeconds, 720 * 3600 * 4);
  assert.deepEqual(result.cloudflare.components.containers, {
    memoryUsd: 6.255, cpuUsd: 0.5868, diskUsd: 0.67536, subtotalUsd: 7.51716,
  });
  input.containers[0].averageActiveVcpu = 0;
  const idle = estimateMonthlyCost(input).cloudflare.components.containers;
  assert.equal(idle.cpuUsd, 0);
  assert.equal(idle.memoryUsd, 6.255);
  assert.equal(idle.diskUsd, 0.67536);
});

test('deducts allowances once across all services and environments, not per container', () => {
  const input = scenario();
  input.containers = [basic({ activeHoursPerInstance: 20, averageActiveVcpu: 0 }),
    basic({ environment: 'staging', activeHoursPerInstance: 20, averageActiveVcpu: 0 })];
  const result = estimateMonthlyCost(input);
  assert.equal(result.cloudflare.components.containers.memoryUsd, 0.135);
  assert.equal(result.cloudflare.paidPlanMonthlyUsd, 5);
  assert.equal(result.cloudflare.modeledCloudflareAccountSubtotalUsd, 5.135);
});

test('existing account workloads consume the same allowance and are not silently omitted', () => {
  const input = scenario();
  input.containers = [basic({ activeHoursPerInstance: 20, averageActiveVcpu: 0 })];
  input.existingAccountUsage.containerMemoryGibSeconds = 25 * 3600;
  input.existingAccountUsage.workerRequests = 10_000_000;
  input.workers.requests = 1_000_000;
  const result = estimateMonthlyCost(input);
  assert.equal(result.cloudflare.components.containers.memoryUsd, 0.18);
  assert.equal(result.cloudflare.components.workers.requestsUsd, 0.30);
  assert.equal(result.cloudflare.projectUsageIncrementalUsd, 0.48);
  assert.equal(result.cloudflare.modeledCloudflareAccountSubtotalUsd, 5.48);
});

test('Workers pricing reproduces the official 15 million requests / 7 ms example', () => {
  const input = scenario();
  input.workers = { requests: 15_000_000, averageCpuMsPerRequest: 7 };
  const result = estimateMonthlyCost(input);
  assert.deepEqual(result.cloudflare.components.workers, { requestsUsd: 1.5, cpuUsd: 1.5, subtotalUsd: 3 });
  assert.equal(result.cloudflare.modeledCloudflareAccountSubtotalUsd, 8);
});

test('Durable Object compute rounds post-allowance usage up, with independent hibernation assumptions', () => {
  const input = scenario();
  input.durableObjects = { billedRequests: 1_000_001, nonHibernatingInstanceHours: 400_001 / (3600 * 0.128) };
  const result = estimateMonthlyCost(input);
  assert.deepEqual(result.cloudflare.components.durableObjects, { requestsUsd: 0.15, durationUsd: 12.5, subtotalUsd: 12.65 });
  input.durableObjects = { billedRequests: 1_000_000, nonHibernatingInstanceHours: 400_000 / (3600 * 0.128) };
  assert.equal(estimateMonthlyCost(input).cloudflare.components.durableObjects.subtotalUsd, 0);
  input.containers = [basic()];
  input.durableObjects = { billedRequests: 0, nonHibernatingInstanceHours: 0 };
  assert.equal(estimateMonthlyCost(input).accountUsage.project.durableObjectGbSeconds, 0);
});

test('R2 Standard operations and storage round up after account allowances', () => {
  const input = scenario();
  input.r2Standard = { gbMonths: 10.1, classAOperations: 1_000_001, classBOperations: 10_000_001 };
  assert.deepEqual(estimateMonthlyCost(input).cloudflare.components.r2Standard, {
    storageUsd: 0.015, classAUsd: 4.5, classBUsd: 0.36, subtotalUsd: 4.875,
  });
});

test('container network regions have separate allowances; zero R2 egress does not mask them', () => {
  const input = scenario();
  input.containerEgressGb = { northAmericaEurope: 1100, oceaniaKoreaTaiwan: 600, other: 600 };
  assert.deepEqual(estimateMonthlyCost(input).cloudflare.components.containerEgress, {
    northAmericaEuropeUsd: 2.5, oceaniaKoreaTaiwanUsd: 5, otherUsd: 4, subtotalUsd: 11.5,
  });
  input.existingAccountUsage.egressOtherGb = 500;
  assert.equal(estimateMonthlyCost(input).cloudflare.components.containerEgress.otherUsd, 24);
});

test('Workers/container logs are charged as their own usage dimension', () => {
  const input = scenario();
  input.logs.events = 21_000_000;
  assert.equal(estimateMonthlyCost(input).cloudflare.components.logs.subtotalUsd, 0.6);
});

test('supports explicit user-priced external estimates without mutating the scenario', () => {
  const input = scenario();
  input.otherCosts.forEach((entry, index) => { entry.monthlyUsd = index + 1; });
  const before = structuredClone(input);
  const result = estimateMonthlyCost(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.unpricedCosts, []);
  assert.equal(result.otherPricedSubtotalUsd, 15);
  assert.equal(result.completeMonthlyBudgetUsd, 20);
});

test('rejects missing/unknown fields, implicit/free external costs, and duplicate services', () => {
  const mutations = [
    (s) => { delete s.workers; }, (s) => { s.workers.request = 5; },
    (s) => { delete s.existingAccountUsage.workerRequests; },
    (s) => { s.otherCosts.pop(); }, (s) => { s.otherCosts[0].monthlyUsd = undefined; },
    (s) => { s.containers = [basic(), basic()]; },
    (s) => { s.otherCosts.push({ ...s.otherCosts[0] }); },
    (s) => { s.containers = [basic({ instanceType: 'custom-unknown' })]; },
  ];
  for (const mutate of mutations) { const input = scenario(); mutate(input); assert.throws(() => estimateMonthlyCost(input), TypeError); }
});

test('rejects non-finite/negative/coerced inputs, impossible CPU, fractional replicas, and hours beyond the period', () => {
  for (const value of [-1, NaN, Infinity, '720', null, true]) {
    const input = scenario(); input.monthHours = value;
    assert.throws(() => estimateMonthlyCost(input), TypeError);
  }
  for (const change of [ { averageActiveVcpu: 0.26 }, { instances: 1.5 }, { instances: 0 },
    { activeHoursPerInstance: 721 }, { averageActiveVcpu: '0.02' } ]) {
    const input = scenario(); input.containers = [basic(change)];
    assert.throws(() => estimateMonthlyCost(input), TypeError);
  }
  const input = scenario(); input.workers.requests = Number.MAX_SAFE_INTEGER; input.workers.averageCpuMsPerRequest = 900_000;
  assert.throws(() => estimateMonthlyCost(input), TypeError);
});

test('fails closed outside the checked rate card period, especially announced December Logs changes', () => {
  for (const pricingDate of ['2026-10-24', '2026-12-01', '2027-01-01', '2026-11-31', 'garbage']) {
    const input = scenario(); input.pricingDate = pricingDate;
    assert.throws(() => estimateMonthlyCost(input), TypeError);
  }
  const input = scenario(); input.pricingDate = '2026-11-30';
  assert.equal(estimateMonthlyCost(input).pricingDate, '2026-11-30');
});

test('checked-in scenarios are explicitly hypothetical, incomplete budgets and reproduce independently', () => {
  const { scenarios } = JSON.parse(readFileSync(new URL('./scenarios.example.json', import.meta.url), 'utf8'));
  assert.equal(scenarios.length, 3);
  const results = scenarios.map(estimateMonthlyCost);
  assert.deepEqual(results.map((r) => r.cloudflare.modeledCloudflareAccountSubtotalUsd), [7.93796, 50.20276, 66.36612]);
  assert.ok(results.every((r) => r.completeMonthlyBudgetUsd === null && r.unpricedCosts.length === 4));
  assert.ok(scenarios.every((s) => s.containers.every((c) => !/chatwoot|rails|sidekiq/i.test(c.name))));
  assert.ok(scenarios.every((s) => s.notes.some((note) => note.includes('not measured'))));
});

test('CLI runs locally and fails with a generic diagnostic rather than echoing input content', () => {
  const cli = fileURLToPath(new URL('./cost-model.mjs', import.meta.url));
  const examples = fileURLToPath(new URL('./scenarios.example.json', import.meta.url));
  const ok = spawnSync(process.execPath, [cli, examples], { encoding: 'utf8', env: {} });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).estimates.length, 3);
  const bad = spawnSync(process.execPath, [cli, '--not-a-secret-or-resource'], { encoding: 'utf8', env: {} });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /No resources were activated/);
  assert.doesNotMatch(bad.stderr, /not-a-secret-or-resource/);
});

test('full reserved CPU utilization illustrates why the production example is not a spend cap', () => {
  const { scenarios } = JSON.parse(readFileSync(new URL('./scenarios.example.json', import.meta.url), 'utf8'));
  const input = structuredClone(scenarios.find((entry) => entry.name === 'illustrative-core-production-730h'));
  for (const container of input.containers) container.averageActiveVcpu = INSTANCE_TYPES[container.instanceType].vcpu;
  const result = estimateMonthlyCost(input);
  assert.equal(result.cloudflare.modeledCloudflareAccountSubtotalUsd, 98.55796);
  assert.equal(result.completeMonthlyBudgetUsd, null);
});
