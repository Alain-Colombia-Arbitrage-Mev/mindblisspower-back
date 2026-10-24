import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { directory, imageKeys } from './manage.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  tag: { type: 'string' }, registry: { type: 'string', default: 'mindbliss' },
  output: { type: 'string', default: path.join(directory, 'artifacts') },
  platform: { type: 'string', default: 'linux/amd64' }, manifest: { type: 'string' },
} });
function run(command, args, cwd, inherit = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} failed; release stopped`);
  return result.stdout?.trim();
}
const backend = path.resolve(directory, '../..');
const repositories = { backend, client: path.resolve(backend, '../mindblisspowerfront'), admin: path.resolve(backend, '../mindblisspower-admin') };
const matrix = {
  api: { context: path.join(backend, 'app'), dockerfile: 'Dockerfile' },
  engine: { context: path.join(backend, 'vp-engine'), dockerfile: 'deployments/Dockerfile', cmd: 'vp-engine' },
  payments: { context: path.join(backend, 'vp-engine'), dockerfile: 'deployments/Dockerfile', cmd: 'vp-payments' },
  withdrawals: { context: path.join(backend, 'vp-engine'), dockerfile: 'deployments/Dockerfile', cmd: 'vp-withdrawals' },
  client: { context: repositories.client, dockerfile: 'Dockerfile' },
  admin: { context: repositories.admin, dockerfile: 'Dockerfile' },
  backup: { context: path.join(directory, 'backup'), dockerfile: 'Dockerfile' },
  edge: { context: directory, dockerfile: 'Dockerfile.edge' },
};
try {
  if (positionals[0] === 'build') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(values.tag || '') || ['latest', 'prod', 'staging'].includes(values.tag)) throw new Error('Use an immutable release tag, e.g. r20261023-01');
    if (!/^[a-z0-9][a-z0-9./:_-]*$/.test(values.registry)) throw new Error('Invalid registry namespace');
    const sources = {};
    for (const [name, repo] of Object.entries(repositories)) {
      if (run('git', ['status', '--porcelain', '--untracked-files=no'], repo)) throw new Error(`${name} has uncommitted tracked changes`);
      sources[name] = run('git', ['rev-parse', 'HEAD'], repo);
    }
    await mkdir(values.output, { recursive: true });
    const manifestPath = path.join(values.output, `${values.tag}.json`);
    // Reserve the tag before building. Failed builds leave an incomplete record.
    await writeFile(manifestPath, JSON.stringify({ tag: values.tag, state: 'building', sources }), { flag: 'wx' });
    const images = {};
    for (const [name, build] of Object.entries(matrix)) {
      const ref = `${values.registry}/${name}:${values.tag}`;
      run('docker', ['build', '--platform', values.platform, '-f', path.join(build.context, build.dockerfile),
        '-t', ref, '--label', `org.opencontainers.image.revision=${sources[name === 'client' || name === 'admin' ? name : 'backend']}`,
        ...(build.cmd ? ['--build-arg', `CMD=${build.cmd}`, '--build-arg', `COMMIT=${sources.backend}`, '--build-arg', `VERSION=${values.tag}`] : []), build.context], backend, true);
      const image = JSON.parse(run('docker', ['image', 'inspect', ref], backend))[0];
      images[name] = { ref, localId: image.Id };
    }
    await writeFile(manifestPath, JSON.stringify({ format: 1, tag: values.tag, state: 'built-not-published', platform: values.platform, sources, images }, null, 2));
    console.log(`Built without publishing: ${manifestPath}. Test these images before pushing.`);
  } else if (positionals[0] === 'lock' && values.manifest) {
    const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
    if (manifest.state !== 'built-not-published') throw new Error('A complete build manifest is required');
    const lines = [];
    for (const [name, entry] of Object.entries(manifest.images)) {
      const image = JSON.parse(run('docker', ['image', 'inspect', entry.ref], backend))[0];
      if (image.Id !== entry.localId) throw new Error(`Image changed after build: ${name}`);
      const repo = entry.ref.slice(0, entry.ref.lastIndexOf(':'));
      const digest = image.RepoDigests?.find(ref => ref.startsWith(`${repo}@sha256:`));
      if (!digest) throw new Error(`Push and inspect the tested image first: ${name}`);
      lines.push(`${imageKeys[name]}=${digest}`);
    }
    const target = `${values.manifest}.images.env`;
    await writeFile(target, `${lines.join('\n')}\n`, { flag: 'wx' });
    console.log(`Immutable image references: ${target}. Pin Postgres/Redis separately.`);
  } else throw new Error('Usage: release.mjs build --tag TAG --registry REGISTRY/NAMESPACE [--platform linux/amd64]; or lock --manifest FILE');
} catch (error) { console.error(error.message); process.exitCode = 1; }
