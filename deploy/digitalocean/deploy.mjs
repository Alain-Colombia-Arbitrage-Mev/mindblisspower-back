import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { services, validateRelease, releaseId } from './release.mjs';

const projects = { staging: 'mindbliss', production: 'mindbliss-prod' };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && value.replaceAll('-', '') !== '0'.repeat(32);
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const vars = (spec, service) => Object.fromEntries([...(spec.envs ?? []), ...(service.envs ?? [])].map(item => [item.key, item.value]));

export function imagePlan(spec, release, environment) {
  validateRelease(release);
  assert.ok(projects[environment], 'Unknown deployment environment');
  assert.equal(spec.name, `mindbliss-${environment}`, 'Unexpected app name/environment');
  assert.ok(uuid(spec.vpc?.id), 'A real VPC must be configured first');
  assert.deepEqual(spec.services.map(s => s.name).sort(), [...services].sort(), 'The app must contain exactly six services');
  for (const key of ['jobs', 'workers', 'functions', 'static_sites']) assert.equal(spec[key]?.length ?? 0, 0, 'Separate operational jobs from image-only releases');
  assert.ok(!/REPLACE_|example\.invalid|sha256:0{64}/.test(JSON.stringify(spec)), 'Finish bootstrap configuration first');
  const next = structuredClone(spec);
  for (const service of next.services) {
    const env = vars(next, service);
    assert.equal(env.ENV, environment, 'Cross-environment service configuration');
    assert.equal(service.instance_count, 1, 'Shared OTP/concurrent jobs must be audited before multiple replicas');
    assert.ok(!service.git && !service.github && !service.gitlab, 'Only immutable image sources are allowed');
    assert.equal(service.image.registry_type, 'DOCR');
    assert.equal(service.image.registry, release.registry, 'Wrong registry');
    assert.equal(service.image.repository, `mindbliss-${service.name}`);
    assert.ok(!service.image.tag && !service.image.deploy_on_push?.enabled, 'Disable moving tags and Autodeploy');
    if (['engine', 'withdrawals'].includes(service.name)) {
      assert.equal(service.http_port, undefined, 'Internal services cannot have public HTTP ports');
      assert.ok(!next.ingress.rules.some(rule => rule.component?.name === service.name), 'Private service has ingress');
    }
    if (service.name === 'engine') {
      assert.equal(env.BONUS_ENGINE_SCHEDULER_ENABLED, 'false');
      assert.equal(env.BONUS_ENGINE_BINARY_CYCLE_ENABLED, 'false');
      assert.equal(env.GRPC_TLS_REQUIRE_CLIENT_CERT, 'true');
    }
    if (service.name === 'payments') {
      assert.equal(env.REQUIRE_VERIFIED_IDENTITY, 'true');
      assert.equal(env.PAYMENTS_RECONCILE_INTERVAL_MIN, '0');
      assert.equal(env.PAYMENTS_CART_REMINDER_ENABLED, 'false');
      assert.equal(env.COMMS_ENABLED, 'false');
      const rules = next.ingress.rules.filter(rule => rule.component?.name === 'payments');
      assert.equal(rules.length, 1);
      assert.deepEqual(rules[0].match.path, { exact: '/api/webhooks/stripe' });
      assert.ok(rules[0].match.authority?.exact, 'Webhook must be bound to its API hostname');
    }
    if (service.name === 'withdrawals') {
      assert.equal(env.WITHDRAWALS_REQUIRE_VERIFIED_IDENTITY, 'true');
      assert.equal(env.WITHDRAWALS_REQUIRE_BMP, 'true');
    }
    if (['client', 'admin'].includes(service.name)) {
      assert.equal(env.DEMO_LOGIN_ENABLED, '0');
      assert.equal(env.VP_FORWARD_ID_TOKEN, '1');
    }
    service.image.digest = release.images[service.name].digest;
  }
  return next;
}

export function assertRunning(app, release) {
  assert.equal(app.active_deployment?.phase, 'ACTIVE', 'Staging must have an ACTIVE deployment');
  const actual = app.active_deployment.spec.services;
  for (const name of services) {
    const image = actual.find(s => s.name === name)?.image;
    assert.equal(image?.digest, release.images[name].digest, 'Staging does not run the same release');
    assert.equal(image.registry, release.registry, 'Staging registry differs');
    assert.equal(image.repository, release.images[name].repository, 'Staging image differs');
  }
}

export async function deployImages({ environment, appId, projectId, stagingAppId, stagingProjectId, release, token, apply = false,
  fetcher = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  assert.ok(uuid(appId) && uuid(projectId), 'Real app/project UUIDs are required');
  assert.ok(token, 'A scoped DigitalOcean token is required');
  assert.ok(projects[environment], 'Unknown deployment environment');
  validateRelease(release);
  async function request(route, method = 'GET', body) {
    const response = await fetcher(`https://api.digitalocean.com/v2/${route}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    // Never expose provider bodies: they may contain encrypted or plaintext secrets.
    if (!response.ok) throw new Error(`DigitalOcean ${method} failed (HTTP ${response.status}); no automatic write retry`);
    return response.json();
  }
  async function target(id, project, env) {
    const [{ app }, { project: meta }] = await Promise.all([request(`apps/${id}`), request(`projects/${project}`)]);
    assert.equal(app.id, id); assert.equal(app.project_id, project, 'Wrong project assignment');
    assert.equal(meta.name, projects[env], 'Wrong project name/environment');
    for (const deployment of [app.in_progress_deployment, app.pending_deployment]) {
      assert.ok(!deployment || ['ACTIVE', 'ERROR', 'CANCELED', 'SUPERSEDED'].includes(deployment.phase), 'Another deployment is in progress');
    }
    return app;
  }
  const app = await target(appId, projectId, environment);
  const next = imagePlan(app.spec, release, environment);
  if (environment === 'production') {
    assert.ok(uuid(stagingAppId) && uuid(stagingProjectId) && stagingAppId !== appId && stagingProjectId !== projectId, 'Separate staging app/project are required');
    const staging = await target(stagingAppId, stagingProjectId, 'staging');
    imagePlan(staging.spec, release, 'staging');
    imagePlan(staging.active_deployment.spec, release, 'staging');
    assertRunning(staging, release);
  }
  const receipt = { release: releaseId(release), environment, appId, projectId, applied: false,
    changes: next.services.map(s => ({ service: s.name, before: app.spec.services.find(old => old.name === s.name).image.digest, after: s.image.digest })) };
  if (!apply) return receipt;
  const latest = await target(appId, projectId, environment);
  assert.equal(stable(latest.spec), stable(app.spec), 'App configuration changed while preparing deployment');
  const { app: updated } = await request(`apps/${appId}`, 'PUT', { spec: next, update_all_source_versions: false });
  const id = updated.pending_deployment?.id;
  assert.ok(uuid(id), 'Update outcome needs manual inspection; no automatic retry');
  for (let attempt = 0; attempt < 120; attempt++) {
    const { deployment } = await request(`apps/${appId}/deployments/${id}`);
    if (deployment.phase === 'ACTIVE') {
      const { app: live } = await request(`apps/${appId}`);
      assert.equal(live.active_deployment?.id, id, 'Deployment was superseded');
      assertRunning(live, release);
      for (const name of ['client', 'admin', 'api']) {
        const host = live.spec.ingress.rules.find(r => r.component?.name === name)?.match.authority?.exact;
        assert.match(host ?? '', /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/);
        const health = await fetcher(`https://${host}${name === 'api' ? '/health' : '/login'}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
        assert.equal(health.status, 200, 'Post-deploy smoke failed; inspect before manual rollback');
      }
      return { ...receipt, applied: true, deploymentId: id, healthChecks: 3 };
    }
    assert.ok(!['ERROR', 'CANCELED', 'SUPERSEDED'].includes(deployment.phase), 'Deployment failed; inspect provider status, no automatic DB rollback');
    await pause(10000);
  }
  throw new Error('Deployment timed out; inspect provider state before retrying');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { environment: { type: 'string' }, release: { type: 'string' }, apply: { type: 'boolean', default: false }, output: { type: 'string' } } });
    assert.match(values.release ?? '', /^deploy\/digitalocean\/releases\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/, 'Use a reviewed release inside deploy/digitalocean/releases');
    const receipt = await deployImages({ environment: values.environment, release: JSON.parse(await readFile(values.release, 'utf8')),
      appId: process.env.DO_APP_ID, projectId: process.env.DO_PROJECT_ID, stagingAppId: process.env.DO_STAGING_APP_ID,
      stagingProjectId: process.env.DO_STAGING_PROJECT_ID, token: process.env.DIGITALOCEAN_ACCESS_TOKEN, apply: values.apply });
    if (values.output) await writeFile(values.output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(receipt, null, 2));
  } catch { console.error('Deployment stopped. Check configuration and provider state; no secrets printed and no automatic rollback/retry.'); process.exitCode = 1; }
}
