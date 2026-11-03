import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Offline planning only: this file does not provision resources, read env files,
// contact Cloudflare, or inspect an account's billing plan/actual usage.
export const RATE_CARD = Object.freeze({
  currency: 'USD',
  checkedOn: '2026-10-25',
  validBefore: '2026-12-01', // Workers Logs pricing changes on this date.
  plan: 'Workers Paid / Standard (not Enterprise or legacy pricing)',
  paidPlanMonthlyUsd: 5,
  containers: Object.freeze({
    memoryIncludedGibSeconds: 25 * 3600,
    memoryUsdPerGibSecond: 0.0000025,
    cpuIncludedVcpuSeconds: 375 * 60,
    cpuUsdPerVcpuSecond: 0.000020,
    diskIncludedGbSeconds: 200 * 3600,
    diskUsdPerGbSecond: 0.00000007,
  }),
  workers: Object.freeze({
    requestsIncluded: 10_000_000, requestsUsdPerMillion: 0.30,
    cpuMsIncluded: 30_000_000, cpuUsdPerMillionMs: 0.02,
  }),
  durableObjects: Object.freeze({
    requestsIncluded: 1_000_000, requestsUsdPerMillion: 0.15,
    gbSecondsIncluded: 400_000, durationUsdPerMillionGbSeconds: 12.50,
    allocatedMemoryGb: 0.128,
  }),
  logs: Object.freeze({ eventsIncluded: 20_000_000, usdPerMillionEvents: 0.60 }),
  r2Standard: Object.freeze({
    gbMonthsIncluded: 10, usdPerGbMonth: 0.015,
    classAIncluded: 1_000_000, usdPerMillionClassA: 4.50,
    classBIncluded: 10_000_000, usdPerMillionClassB: 0.36,
  }),
  containerEgress: Object.freeze({
    northAmericaEurope: Object.freeze({ includedGb: 1000, usdPerGb: 0.025 }),
    oceaniaKoreaTaiwan: Object.freeze({ includedGb: 500, usdPerGb: 0.05 }),
    other: Object.freeze({ includedGb: 500, usdPerGb: 0.04 }),
  }),
  sources: Object.freeze({
    containers: 'https://developers.cloudflare.com/containers/platform/pricing/',
    workersAndLogs: 'https://developers.cloudflare.com/workers/platform/pricing/',
    durableObjects: 'https://developers.cloudflare.com/durable-objects/platform/pricing/',
    r2: 'https://developers.cloudflare.com/r2/pricing/',
  }),
});

export const INSTANCE_TYPES = Object.freeze({
  lite: Object.freeze({ vcpu: 1 / 16, memoryGib: 0.25, diskGb: 2 }),
  basic: Object.freeze({ vcpu: 1 / 4, memoryGib: 1, diskGb: 4 }),
  'standard-1': Object.freeze({ vcpu: 1 / 2, memoryGib: 4, diskGb: 8 }),
  'standard-2': Object.freeze({ vcpu: 1, memoryGib: 6, diskGb: 12 }),
  'standard-3': Object.freeze({ vcpu: 2, memoryGib: 8, diskGb: 16 }),
  'standard-4': Object.freeze({ vcpu: 4, memoryGib: 12, diskGb: 20 }),
});

const USAGE_KEYS = Object.freeze([
  'containerMemoryGibSeconds', 'containerCpuVcpuSeconds', 'containerDiskGbSeconds',
  'workerRequests', 'workerCpuMs', 'durableObjectRequests', 'durableObjectGbSeconds',
  'logEvents', 'r2GbMonths', 'r2ClassAOperations', 'r2ClassBOperations',
  'egressNorthAmericaEuropeGb', 'egressOceaniaKoreaTaiwanGb', 'egressOtherGb',
]);
const REQUIRED_OTHER_COSTS = Object.freeze([
  'postgresql', 'redis', 'email-delivery', 'other-cloudflare', 'taxes-and-other',
]);
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9 ._/-]{0,99}$/;

function object(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} must be a plain object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new TypeError(`${path} contains an unknown field`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`);
  }
  return value;
}

function number(value, path, { max = Number.MAX_SAFE_INTEGER, integer = false, min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
    || (integer && !Number.isSafeInteger(value))) {
    throw new TypeError(`${path} must be a finite ${integer ? 'integer' : 'number'} between ${min} and ${max}`);
  }
  return value;
}

function name(value, path) {
  if (typeof value !== 'string' || !NAME.test(value)) throw new TypeError(`${path} is invalid`);
  return value;
}

function list(value, path, max = 1000) {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`${path} must be a bounded array`);
  return value;
}

function round(value) {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 1e8) {
    throw new RangeError('Estimated cost is outside the supported numeric range');
  }
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

function sum(values) { return values.reduce((total, value) => total + value, 0); }
function over(value, included) { return Math.max(0, value - included); }
function blocksOver(value, included, block) { return Math.ceil(over(value, included) / block); }

export function zeroAccountUsage() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, 0]));
}

function accountUsage(value, path) {
  object(value, USAGE_KEYS, path);
  for (const key of USAGE_KEYS) number(value[key], `${path}.${key}`);
  return { ...value };
}

function usageCharges(u) {
  const c = RATE_CARD.containers;
  const w = RATE_CARD.workers;
  const d = RATE_CARD.durableObjects;
  const r = RATE_CARD.r2Standard;
  const e = RATE_CARD.containerEgress;
  const containers = {
    memoryUsd: over(u.containerMemoryGibSeconds, c.memoryIncludedGibSeconds) * c.memoryUsdPerGibSecond,
    cpuUsd: over(u.containerCpuVcpuSeconds, c.cpuIncludedVcpuSeconds) * c.cpuUsdPerVcpuSecond,
    diskUsd: over(u.containerDiskGbSeconds, c.diskIncludedGbSeconds) * c.diskUsdPerGbSecond,
  };
  const workers = {
    requestsUsd: over(u.workerRequests, w.requestsIncluded) / 1e6 * w.requestsUsdPerMillion,
    cpuUsd: over(u.workerCpuMs, w.cpuMsIncluded) / 1e6 * w.cpuUsdPerMillionMs,
  };
  // DO compute rounds UP the post-allowance amount to whole million-unit blocks.
  const durableObjects = {
    requestsUsd: blocksOver(u.durableObjectRequests, d.requestsIncluded, 1e6) * d.requestsUsdPerMillion,
    durationUsd: blocksOver(u.durableObjectGbSeconds, d.gbSecondsIncluded, 1e6) * d.durationUsdPerMillionGbSeconds,
  };
  const logs = { eventsUsd: over(u.logEvents, RATE_CARD.logs.eventsIncluded) / 1e6 * RATE_CARD.logs.usdPerMillionEvents };
  const r2Standard = {
    storageUsd: Math.ceil(over(u.r2GbMonths, r.gbMonthsIncluded)) * r.usdPerGbMonth,
    classAUsd: blocksOver(u.r2ClassAOperations, r.classAIncluded, 1e6) * r.usdPerMillionClassA,
    classBUsd: blocksOver(u.r2ClassBOperations, r.classBIncluded, 1e6) * r.usdPerMillionClassB,
  };
  const containerEgress = {
    northAmericaEuropeUsd: over(u.egressNorthAmericaEuropeGb, e.northAmericaEurope.includedGb) * e.northAmericaEurope.usdPerGb,
    oceaniaKoreaTaiwanUsd: over(u.egressOceaniaKoreaTaiwanGb, e.oceaniaKoreaTaiwan.includedGb) * e.oceaniaKoreaTaiwan.usdPerGb,
    otherUsd: over(u.egressOtherGb, e.other.includedGb) * e.other.usdPerGb,
  };
  const components = { containers, workers, durableObjects, logs, r2Standard, containerEgress };
  for (const part of Object.values(components)) {
    for (const key of Object.keys(part)) part[key] = round(part[key]);
    part.subtotalUsd = round(sum(Object.values(part)));
  }
  return { components, usageSubtotalUsd: round(sum(Object.values(components).map((part) => part.subtotalUsd))) };
}

/**
 * Pure monthly estimate for ONE account. Existing usage and all project services
 * share allowances once. The result is NOT an account quote, bill, or spend cap.
 * DO non-hibernating hours are independent of container hours: measure them.
 */
export function estimateMonthlyCost(input) {
  object(input, ['name', 'pricingDate', 'monthHours', 'containers', 'workers', 'durableObjects',
    'logs', 'r2Standard', 'containerEgressGb', 'existingAccountUsage', 'otherCosts', 'notes'], 'scenario');
  name(input.name, 'scenario.name');
  if (typeof input.pricingDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.pricingDate)
    || Number.isNaN(Date.parse(`${input.pricingDate}T00:00:00Z`))
    || new Date(`${input.pricingDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.pricingDate
    || input.pricingDate < RATE_CARD.checkedOn || input.pricingDate >= RATE_CARD.validBefore) {
    throw new TypeError('scenario.pricingDate is outside the checked rate-card period; refresh official rates');
  }
  const monthHours = number(input.monthHours, 'scenario.monthHours', { min: 1, max: 744 });
  const project = zeroAccountUsage();
  const ids = new Set();
  const containers = list(input.containers, 'scenario.containers').map((entry) => {
    object(entry, ['name', 'environment', 'instanceType', 'instances', 'activeHoursPerInstance', 'averageActiveVcpu'], 'container');
    name(entry.name, 'container.name');
    name(entry.environment, 'container.environment');
    const id = `${entry.environment}/${entry.name}`;
    if (ids.has(id)) throw new TypeError('Container names must be unique within an environment');
    ids.add(id);
    if (typeof entry.instanceType !== 'string' || !Object.hasOwn(INSTANCE_TYPES, entry.instanceType)) {
      throw new TypeError('container.instanceType is unsupported');
    }
    const type = INSTANCE_TYPES[entry.instanceType];
    const instances = number(entry.instances, 'container.instances', { min: 1, max: 100_000, integer: true });
    const hours = number(entry.activeHoursPerInstance, 'container.activeHoursPerInstance', { max: monthHours });
    const averageActiveVcpu = number(entry.averageActiveVcpu, 'container.averageActiveVcpu', { max: type.vcpu });
    const instanceSeconds = instances * hours * 3600;
    const usage = {
      containerMemoryGibSeconds: instanceSeconds * type.memoryGib,
      containerCpuVcpuSeconds: instanceSeconds * averageActiveVcpu,
      containerDiskGbSeconds: instanceSeconds * type.diskGb,
    };
    for (const key of Object.keys(usage)) project[key] += usage[key];
    return { ...entry, resourcesPerInstance: { ...type }, instanceHours: instances * hours, usage };
  });
  object(input.workers, ['requests', 'averageCpuMsPerRequest'], 'workers');
  project.workerRequests = number(input.workers.requests, 'workers.requests', { integer: true });
  project.workerCpuMs = project.workerRequests * number(input.workers.averageCpuMsPerRequest, 'workers.averageCpuMsPerRequest', { max: 900_000 });
  object(input.durableObjects, ['billedRequests', 'nonHibernatingInstanceHours'], 'durableObjects');
  project.durableObjectRequests = number(input.durableObjects.billedRequests, 'durableObjects.billedRequests');
  project.durableObjectGbSeconds = number(input.durableObjects.nonHibernatingInstanceHours,
    'durableObjects.nonHibernatingInstanceHours') * 3600 * RATE_CARD.durableObjects.allocatedMemoryGb;
  object(input.logs, ['events'], 'logs');
  project.logEvents = number(input.logs.events, 'logs.events', { integer: true });
  object(input.r2Standard, ['gbMonths', 'classAOperations', 'classBOperations'], 'r2Standard');
  project.r2GbMonths = number(input.r2Standard.gbMonths, 'r2Standard.gbMonths');
  project.r2ClassAOperations = number(input.r2Standard.classAOperations, 'r2Standard.classAOperations', { integer: true });
  project.r2ClassBOperations = number(input.r2Standard.classBOperations, 'r2Standard.classBOperations', { integer: true });
  object(input.containerEgressGb, ['northAmericaEurope', 'oceaniaKoreaTaiwan', 'other'], 'containerEgressGb');
  project.egressNorthAmericaEuropeGb = number(input.containerEgressGb.northAmericaEurope, 'containerEgressGb.northAmericaEurope');
  project.egressOceaniaKoreaTaiwanGb = number(input.containerEgressGb.oceaniaKoreaTaiwan, 'containerEgressGb.oceaniaKoreaTaiwan');
  project.egressOtherGb = number(input.containerEgressGb.other, 'containerEgressGb.other');
  const existing = accountUsage(input.existingAccountUsage, 'existingAccountUsage');
  const combined = accountUsage(Object.fromEntries(USAGE_KEYS.map((key) => [key, existing[key] + project[key]])), 'combinedAccountUsage');
  const existingCharges = usageCharges(existing);
  const combinedCharges = usageCharges(combined);
  const otherNames = new Set();
  const otherCosts = list(input.otherCosts, 'otherCosts', 100).map((entry) => {
    object(entry, ['name', 'monthlyUsd', 'note'], 'otherCost');
    name(entry.name, 'otherCost.name');
    if (otherNames.has(entry.name)) throw new TypeError('otherCost.name must be unique');
    otherNames.add(entry.name);
    if (entry.monthlyUsd !== null) number(entry.monthlyUsd, 'otherCost.monthlyUsd');
    if (typeof entry.note !== 'string' || entry.note.trim().length < 3 || entry.note.length > 1000) {
      throw new TypeError('otherCost.note must explain the estimate or unknown cost');
    }
    return { ...entry, status: entry.monthlyUsd === null ? 'unpriced' : 'user-supplied-estimate' };
  });
  for (const required of REQUIRED_OTHER_COSTS) {
    if (!otherNames.has(required)) throw new TypeError(`otherCosts must explicitly include ${required}; use null when unknown`);
  }
  list(input.notes, 'notes', 100);
  for (const note of input.notes) {
    if (typeof note !== 'string' || !note.trim() || note.length > 1000) throw new TypeError('notes must contain bounded nonempty strings');
  }
  const modeledCloudflareAccountSubtotalUsd = round(RATE_CARD.paidPlanMonthlyUsd + combinedCharges.usageSubtotalUsd);
  const unpricedCosts = otherCosts.filter((entry) => entry.monthlyUsd === null).map((entry) => entry.name);
  const otherPricedSubtotalUsd = round(sum(otherCosts.map((entry) => entry.monthlyUsd ?? 0)));
  return {
    name: input.name, currency: RATE_CARD.currency, pricingDate: input.pricingDate, monthHours,
    rateCard: RATE_CARD, containers,
    accountUsage: { existing, project, combined },
    cloudflare: {
      paidPlanMonthlyUsd: RATE_CARD.paidPlanMonthlyUsd,
      ...combinedCharges,
      modeledCloudflareAccountSubtotalUsd,
      projectUsageIncrementalUsd: round(combinedCharges.usageSubtotalUsd - existingCharges.usageSubtotalUsd),
    },
    otherCosts, otherPricedSubtotalUsd, unpricedCosts,
    completeMonthlyBudgetUsd: unpricedCosts.length ? null : round(modeledCloudflareAccountSubtotalUsd + otherPricedSubtotalUsd),
    assumptions: [
      'Illustrative USD estimate, not a quote, approval, activation, total bill, or hard spend limit.',
      'All environments/services share monthly account allowances exactly once; existing usage must be entered explicitly.',
      'Container CPU uses average active vCPU, not reserved vCPU. Memory/disk use provisioned instance resources while running.',
      'Active hours must include idle timeout and warm-up; aggregate hours approximate the platform 10 ms billing granularity.',
      'Durable Object requests/duration are separate. Non-hibernating instance-hours are explicit, not assumed equal to container hours.',
      'DO compute and R2 standard excess round up to their documented billing blocks. Workers/Logs use proportional usage rates.',
      'Container egress has separate regional pools; 1 TB is modeled as 1000 GB. R2 free egress does not cancel container/external-provider network charges.',
      'R2 gbMonths means monthly average daily peak storage, not final stored size; only Standard storage is modeled.',
      'other-cloudflare must cover DO storage, builds, registry, KV, queues, other products or explicitly justify non-use.',
      'Other provider fees, database replicas/storage/backups/egress, Redis persistence and email delivery are not included unless supplied in otherCosts.',
      'Instance sizes and hours are planning assumptions, not performance or production-readiness recommendations.',
      'Rate card must be rechecked before activation and before December 1, 2026 (announced Workers Logs pricing change).',
      ...input.notes,
    ],
  };
}

async function main() {
  if (process.argv.length !== 3 || !process.argv[2] || process.argv[2].startsWith('-')) {
    throw new TypeError('Usage: node deploy/cloudflare/cost-model.mjs path/to/scenarios.json');
  }
  const document = JSON.parse(await readFile(process.argv[2], 'utf8'));
  object(document, ['scenarios'], 'document');
  const scenarios = list(document.scenarios, 'document.scenarios', 100);
  if (!scenarios.length) throw new TypeError('document.scenarios must not be empty');
  console.log(JSON.stringify({ estimates: scenarios.map(estimateMonthlyCost) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Do not echo user files or input values on parse/validation errors.
    console.error('Cost model failed: check the JSON schema, numeric inputs, and checked pricing period. No resources were activated.');
    process.exitCode = 1;
  });
}
