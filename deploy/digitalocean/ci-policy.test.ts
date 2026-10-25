import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const directory = new URL('../../.github/workflows/', import.meta.url);
const workflow = (name: string) => Bun.YAML.parse(readFileSync(new URL(name, directory), 'utf8')) as Record<string, any>;
const checks = ['dependency-security.yml', 'postgres-rds.yml', 'app-platform-local.yml'];

describe('GitHub Actions review policy', () => {
  for (const name of checks) {
    test(`${name}: read-only checks run for every PR, with bounded jobs and immutable actions`, () => {
      const doc = workflow(name);
      expect(Object.hasOwn(doc.on, 'pull_request')).toBe(true);
      expect(doc.on.pull_request?.paths).toBeUndefined();
      expect(doc.on.pull_request?.['paths-ignore']).toBeUndefined();
      expect(doc.on.pull_request_target).toBeUndefined();
      expect(doc.permissions).toEqual({ contents: 'read' });
      expect(doc.concurrency['cancel-in-progress']).toBe(true);
      expect(JSON.stringify(doc)).not.toContain('${{ secrets.');
      for (const job of Object.values(doc.jobs) as any[]) {
        expect(job['timeout-minutes']).toBeGreaterThan(0);
        expect(job.permissions).toBeUndefined();
        for (const step of job.steps) {
          if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
          if (step.uses?.startsWith('actions/checkout@')) expect(step.with['persist-credentials']).toBe(false);
        }
      }
    });
  }
  test('AWS is disabled unless explicitly selected, including the old image builder', () => {
    for (const name of ['build.yml', 'deploy.yml']) {
      for (const job of Object.values(workflow(name).jobs) as any[]) {
        expect(job.if).toBe("vars.DEPLOYMENT_PROVIDER == 'aws'");
      }
    }
  });
  test('image publication stays manual, main-only and behind both verification workflows', () => {
    const doc = workflow('container-images.yml');
    expect(Object.keys(doc.on)).toEqual(['workflow_dispatch']);
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(doc.jobs.publish.if).toContain('github.event.repository.default_branch');
    expect(doc.jobs.publish.if).toContain("vars.DEPLOYMENT_PROVIDER == 'digitalocean'");
    expect(doc.jobs.publish.environment).toBe('container-images');
    expect(doc.jobs.publish.needs).toEqual(['verify', 'runtime']);
    expect(doc.jobs.verify.uses).toBe('./.github/workflows/postgres-rds.yml');
    expect(doc.jobs.runtime.uses).toBe('./.github/workflows/app-platform-local.yml');
    expect(JSON.stringify(doc.jobs.publish)).toContain('registry.digitalocean.com');
    expect(JSON.stringify(doc.jobs.publish)).toContain('--provenance=false');
    expect(JSON.stringify(doc.jobs.publish)).not.toContain('packages:write');
  });
  test('deployment is manual, defaults to planning and never races another release', () => {
    const doc = workflow('app-platform-deploy.yml');
    expect(Object.keys(doc.on)).toEqual(['workflow_dispatch']);
    expect(doc.on.workflow_dispatch.inputs.apply.default).toBe(false);
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(doc.concurrency['cancel-in-progress']).toBe(false);
    expect(doc.jobs.deploy.environment).toBe('${{ inputs.environment }}');
    expect(JSON.stringify(doc.jobs.deploy)).toContain('DO_LAUNCH_APPROVED');
  });
  test('selecting Cloudflare cannot activate legacy AWS or DigitalOcean writers', () => {
    const writers = [
      ...Object.values(workflow('build.yml').jobs),
      ...Object.values(workflow('deploy.yml').jobs),
      workflow('container-images.yml').jobs.publish,
      workflow('app-platform-deploy.yml').jobs.deploy,
    ] as any[];
    for (const job of writers) {
      const condition = String(job.if);
      expect(condition).toMatch(/vars\.DEPLOYMENT_PROVIDER == '(aws|digitalocean)'/);
      expect(condition).not.toContain('||');
      expect(condition).not.toContain('!');
      expect(condition).not.toContain('cloudflare');
    }
  });
  test('API persistence and Go race tests cannot silently disappear from the gates', () => {
    const doc = workflow('postgres-rds.yml');
    const sqlSteps = JSON.stringify(doc.jobs.postgres.steps);
    expect(sqlSteps).toContain('--synthetic-docker --with-api-tests');
    expect(sqlSteps).toContain('bun test deploy/digitalocean/ci-policy.test.ts');
    expect(sqlSteps).toContain('docker run --rm --network none mindbliss/rds-api-test');
    expect(JSON.stringify(doc.jobs.go.steps)).toContain('go test -race');
  });
  test('portable backup checks retain PG17 and test PG18 plus upgrades without secrets', () => {
    const doc = workflow('portable-infra.yml');
    const steps = JSON.stringify(doc.jobs.verify.steps);
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(doc.on.pull_request_target).toBeUndefined();
    expect(doc.jobs.verify['timeout-minutes']).toBeGreaterThan(0);
    expect(steps).not.toContain('${{ secrets.');
    expect(steps).toContain('mindbliss/backup:infra-20261023');
    expect(steps).toContain('POSTGRES_IMAGE=postgres:18.6-alpine3.23@sha256:dec395d8c09c45609d6deb5c2388a07882d64fa59b1d98c1895792e085f57888');
    expect(steps).toContain('--synthetic-docker --vanilla-postgres');
    expect(steps).toContain('--synthetic-docker --postgres-18');
    expect(steps).toContain('--synthetic-docker --postgres-18 --upgrade-from-17');
  });
  test('PlanetScale restore preparation is synthetic, read-only and cannot use CI secrets', () => {
    const doc = workflow('portable-infra.yml');
    const steps = JSON.stringify(doc.jobs.verify.steps);
    expect(doc.on.pull_request.paths).toContain('deploy/cloudflare/**');
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(steps).not.toContain('${{ secrets.');
    expect(steps).toContain('--network none --read-only --tmpfs /tmp:mode=1777');
    expect(steps).toContain('-B -m unittest -v test_restore_plan');
    expect(steps).toContain('deploy/cloudflare/test-restore-plan.mjs --synthetic-docker');
  });
});
