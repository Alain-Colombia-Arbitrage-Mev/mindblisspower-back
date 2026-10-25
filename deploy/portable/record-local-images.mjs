import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: { tag: { type: 'string' }, output: { type: 'string' } } });
assert.match(values.tag ?? '', /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/);
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const services = ['api', 'engine', 'payments', 'withdrawals', 'client', 'admin', 'backup', 'edge'];
const images = {};
for (const service of services) {
  const ref = `mindbliss/${service}:${values.tag}`;
  const image = JSON.parse(execFileSync('docker', ['image', 'inspect', ref], { encoding: 'utf8' }))[0];
  assert.equal(`${image.Os}/${image.Architecture}`, 'linux/amd64');
  assert.ok(!(image.Config.Env ?? []).some(value => /^(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|DATABASE_URL|MEMBER_DATABASE_URL|PAYMENTS_SERVICE_TOKEN|BETTER_AUTH_SECRET|AWS_SECRET_ACCESS_KEY)=/.test(value)), `${service}: secret baked into image`);
  if (['api', 'engine', 'payments', 'withdrawals', 'client', 'admin'].includes(service)) {
    assert.ok(image.Config.User && !['root', '0', '0:0'].includes(image.Config.User), `${service}: root user`);
    assert.ok(image.Config.Healthcheck?.Test?.length > 0, `${service}: missing readiness probe`);
  }
  images[service] = {
    ref, localId: image.Id, registryDigests: image.RepoDigests ?? [],
    sizeBytesReportedByInspect: image.Size,
    dockerListSize: execFileSync('docker', ['image', 'ls', '--filter', `reference=${ref}`, '--format', '{{.Size}}'], { encoding: 'utf8' }).trim(),
    user: image.Config.User || 'root', healthcheck: image.Config.Healthcheck ?? null,
    layers: image.RootFS?.Layers ?? [],
  };
}
const sources = {};
for (const [name, repository] of Object.entries({ backend, client: path.resolve(backend, '../mindblisspowerfront'), admin: path.resolve(backend, '../mindblisspower-admin') })) {
  sources[name] = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    uncommittedTrackedChanges: execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean),
  };
}
const manifest = { format: 1, createdAt: new Date().toISOString(), state: 'local-tested-not-published', platform: 'linux/amd64', sources, images };
if (values.output) {
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(`Local image evidence: ${output}`);
} else console.log(JSON.stringify(manifest, null, 2));
