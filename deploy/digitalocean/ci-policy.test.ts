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
  test('API persistence and Go race tests cannot silently disappear from the gates', () => {
    const doc = workflow('postgres-rds.yml');
    const sqlSteps = JSON.stringify(doc.jobs.postgres.steps);
    expect(sqlSteps).toContain('--synthetic-docker --with-api-tests');
    expect(sqlSteps).toContain('bun test deploy/digitalocean/ci-policy.test.ts');
    expect(sqlSteps).toContain('docker run --rm --network none mindbliss/rds-api-test');
    expect(JSON.stringify(doc.jobs.go.steps)).toContain('go test -race');
  });
});
