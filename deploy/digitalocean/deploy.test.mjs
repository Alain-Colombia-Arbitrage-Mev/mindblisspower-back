import test from 'node:test';
import assert from 'node:assert/strict';
import { appSpec } from './app-spec.mjs';
import { imagePlan, deployImages } from './deploy.mjs';
import { services } from './release.mjs';

const appId = '01234567-1234-1234-1234-123456789abc';
const projectId = '12345678-1234-1234-1234-123456789abc';
const stagingId = '23456789-1234-1234-1234-123456789abc';
const stagingProject = '34567890-1234-1234-1234-123456789abc';
const deploymentId = '45678901-1234-1234-1234-123456789abc';
const release = { format: 1, platform: 'linux/amd64', registry: 'test-registry', images: Object.fromEntries(services.map(name =>
  [name, { repository: `mindbliss-${name}`, digest: `sha256:${'a'.repeat(64)}`, source: 'example/backend', commit: 'b'.repeat(40) }])) };
function spec(environment = 'staging', current = 'c') {
  const images = Object.fromEntries(services.map(name => [name, { registry: release.registry, repository: `mindbliss-${name}`, digest: `sha256:${current.repeat(64)}` }]));
  const value = appSpec(environment, images, { vpcId: projectId, hosts: Object.fromEntries(['client', 'admin', 'api'].map(name => [name, `${name}.${environment}.example.com`])) });
  for (const service of value.services) for (const variable of service.envs) {
    if (variable.type === 'SECRET') variable.value = 'EV[1:synthetic-encrypted-secret]';
  }
  return value;
}
function api(environment = 'staging', options = {}) {
  const current = spec(environment);
  const calls = [];
  let updated;
  let reads = 0;
  const target = () => ({ id: appId, project_id: options.wrongProject ? stagingProject : projectId, spec: updated ?? current,
    active_deployment: { id: updated ? deploymentId : stagingId, phase: 'ACTIVE', spec: updated ?? current } });
  const fetcher = async (url, request) => {
    calls.push({ url, request });
    const route = url.replace('https://api.digitalocean.com/v2/', '');
    let body;
    if (!url.startsWith('https://api.digitalocean.com/')) return new Response('ok', { status: options.badHealth ? 503 : 200 });
    if (route === `projects/${projectId}`) body = { project: { name: environment === 'production' ? 'mindbliss-prod' : 'mindbliss' } };
    else if (route === `projects/${stagingProject}`) body = { project: { name: 'mindbliss' } };
    else if (route === `apps/${stagingId}`) {
      const stage = spec('staging', options.stagingOld ? 'c' : 'a');
      body = { app: { id: stagingId, project_id: stagingProject, spec: stage, active_deployment: { phase: 'ACTIVE', spec: stage } } };
    } else if (request.method === 'PUT') {
      if (options.writeError) return new Response('private-provider-body-password', { status: 504 });
      updated = JSON.parse(request.body).spec;
      body = { app: { pending_deployment: options.unknownWrite ? undefined : { id: deploymentId } } };
    } else if (route === `apps/${appId}/deployments/${deploymentId}`) body = { deployment: { id: deploymentId, phase: options.deploymentError ? 'ERROR' : 'ACTIVE' } };
    else {
      reads++;
      body = { app: target() };
      if (options.drift && reads > 1) {
        body.app.spec = structuredClone(body.app.spec);
        body.app.spec.services[0].instance_size_slug = 'apps-s-1vcpu-2gb';
      }
      if (options.busy) body.app.pending_deployment = { phase: 'PENDING_BUILD' };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { current, calls, fetcher };
}
const config = { environment: 'staging', appId, projectId, release, token: 'synthetic-token', pause: async () => {} };
test('image-only plan changes no secrets, ports, sizing, routes or original objects', () => {
  const before = spec();
  const snapshot = structuredClone(before);
  const after = imagePlan(before, release, 'staging');
  assert.deepEqual(before, snapshot);
  for (const service of after.services) service.image.digest = `sha256:${'c'.repeat(64)}`;
  assert.deepEqual(after, before);
});
test('unsafe bootstrap, public financial APIs, jobs and multi-replica defaults are refused', () => {
  for (const mutate of [
    x => { x.vpc = undefined; },
    x => { x.services.pop(); },
    x => { x.jobs = [{ name: 'unreviewed-job' }]; },
    x => { x.services[0].envs[0].value = 'production'; },
    x => { x.services[0].envs[2].value = 'REPLACE_SECRET'; },
    x => { x.services[0].instance_count = 2; },
    x => { x.services[1].http_port = 9090; },
    x => { x.services[1].envs.find(e => e.key === 'BONUS_ENGINE_SCHEDULER_ENABLED').value = 'true'; },
    x => { x.ingress.rules[0].match.path = { prefix: '/api' }; },
    x => { x.services[0].image.deploy_on_push = { enabled: true }; },
  ]) { const value = spec(); mutate(value); assert.throws(() => imagePlan(value, release, 'staging')); }
});
test('dry run is the default and never sends a PUT', async () => {
  const mock = api();
  const receipt = await deployImages({ ...config, fetcher: mock.fetcher });
  assert.equal(receipt.applied, false);
  assert.ok(mock.calls.every(c => c.request.method === 'GET'));
  assert.ok(!JSON.stringify(receipt).includes('encrypted-secret'));
});
test('apply updates once, preserves secret values and checks ACTIVE plus public health', async () => {
  const mock = api();
  const receipt = await deployImages({ ...config, apply: true, fetcher: mock.fetcher });
  assert.equal(receipt.applied, true);
  assert.equal(receipt.healthChecks, 3);
  const writes = mock.calls.filter(c => c.request.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].request.body).update_all_source_versions, false);
});
test('production refuses a release not ACTIVE in the independent staging project', async () => {
  const mock = api('production', { stagingOld: true });
  await assert.rejects(deployImages({ ...config, environment: 'production', stagingAppId: stagingId,
    stagingProjectId: stagingProject, apply: true, fetcher: mock.fetcher }), /same release/);
  assert.ok(mock.calls.every(c => c.request.method === 'GET'));
});
test('production can promote exactly the already ACTIVE staging digests', async () => {
  const mock = api('production');
  const receipt = await deployImages({ ...config, environment: 'production', stagingAppId: stagingId,
    stagingProjectId: stagingProject, apply: true, fetcher: mock.fetcher });
  assert.equal(receipt.applied, true);
});
test('provider error bodies never leak credentials and writes are never automatically retried', async () => {
  let calls = 0;
  await assert.rejects(deployImages({ ...config, fetcher: async () => {
    calls++; return new Response('private-provider-body-password', { status: 403 });
  } }), error => !error.message.includes('password'));
  assert.equal(calls, 2);
});

test('wrong project, concurrent deployment and drift stop before any update', async () => {
  for (const options of [{ wrongProject: true }, { busy: true }, { drift: true }]) {
    const mock = api('staging', options);
    await assert.rejects(deployImages({ ...config, apply: true, fetcher: mock.fetcher }));
    assert.ok(mock.calls.every(c => c.request.method === 'GET'));
  }
});

test('ambiguous write errors never trigger a retry or expose provider secrets', async () => {
  for (const options of [{ writeError: true }, { unknownWrite: true }]) {
    const mock = api('staging', options);
    await assert.rejects(deployImages({ ...config, apply: true, fetcher: mock.fetcher }), error => !error.message.includes('password'));
    assert.equal(mock.calls.filter(c => c.request.method === 'PUT').length, 1);
  }
});

test('failed deployment or public smoke is not reported as success or rolled back automatically', async () => {
  for (const options of [{ deploymentError: true }, { badHealth: true }]) {
    const mock = api('staging', options);
    await assert.rejects(deployImages({ ...config, apply: true, fetcher: mock.fetcher }));
    assert.equal(mock.calls.filter(c => c.request.method === 'PUT').length, 1);
  }
});
