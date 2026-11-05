import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const services = ['api', 'engine', 'payments', 'withdrawals', 'client', 'admin'];
const known = [...services, 'backup'];
export function validateRelease(value, complete = true) {
  assert.equal(value?.format, 1, 'Unsupported release format');
  assert.equal(value.platform, 'linux/amd64', 'Only linux/amd64 is supported');
  assert.match(value.registry ?? '', /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'Invalid DOCR registry name');
  assert.ok(value.images && typeof value.images === 'object', 'Missing images');
  for (const [name, item] of Object.entries(value.images)) {
    assert.ok(known.includes(name), 'Unknown release component');
    assert.equal(item.repository, `mindbliss-${name}`, 'Repository does not match component');
    assert.match(item.digest ?? '', /^sha256:[a-f0-9]{64}$/, 'Invalid image digest');
    assert.notEqual(item.digest, `sha256:${'0'.repeat(64)}`, 'Placeholder digest');
    assert.match(item.commit ?? '', /^[a-f0-9]{40}$/, 'Use the full source commit');
    assert.match(item.source ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Invalid source repository');
    assert.deepEqual(Object.keys(item).sort(), ['commit', 'digest', 'repository', 'source']);
  }
  assert.deepEqual(Object.keys(value).sort(), ['format', 'images', 'platform', 'registry']);
  if (complete) {
    assert.ok(services.every(name => value.images[name]), 'All six service images are required');
    const backends = ['api', 'engine', 'payments', 'withdrawals'];
    assert.equal(new Set(backends.map(name => `${value.images[name].source}@${value.images[name].commit}`)).size, 1,
      'Backend services must come from the same tested commit');
  }
  return value;
}
export function assemble(parts) {
  assert.ok(parts.length > 0, 'No image lock files');
  const images = {};
  for (const part of parts) {
    validateRelease(part, false);
    assert.equal(part.registry, parts[0].registry, 'Cannot mix registries');
    for (const [name, item] of Object.entries(part.images)) {
      assert.ok(!images[name], 'Duplicate image lock'); images[name] = item;
    }
  }
  return validateRelease({ format: 1, platform: 'linux/amd64', registry: parts[0].registry,
    images: Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b))) });
}
export function releaseId(release) {
  validateRelease(release);
  return createHash('sha256').update(JSON.stringify(assemble([release]))).digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    output: { type: 'string' }, registry: { type: 'string' }, names: { type: 'string' },
  } });
  const [command, ...files] = positionals;
  let result;
  if (command === 'assemble') {
    result = assemble(await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8')))));
  } else if (command === 'lock') {
    const names = (values.names ?? '').split(',');
    const images = {};
    for (const name of names) {
      assert.ok(known.includes(name));
      const repository = `mindbliss-${name}`;
      const ref = `registry.digitalocean.com/${values.registry}/${repository}:${process.env.IMAGE_TAG ?? process.env.GITHUB_SHA}`;
      const image = JSON.parse(execFileSync('docker', ['image', 'inspect', ref], { encoding: 'utf8' }))[0];
      assert.equal(`${image.Os}/${image.Architecture}`, 'linux/amd64');
      assert.equal(image.Config.Labels['org.opencontainers.image.revision'], process.env.GITHUB_SHA);
      const pinned = image.RepoDigests.find(value => value.startsWith(ref.split(':')[0] + '@sha256:'));
      assert.ok(pinned, 'Push and verify the tested image before recording a lock');
      const manifest = JSON.parse(execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', pinned], { encoding: 'utf8' }));
      assert.equal(manifest.config?.digest, image.Id, 'Remote image does not match the tested local image');
      images[name] = { repository, digest: pinned.split('@')[1], commit: process.env.GITHUB_SHA, source: process.env.GITHUB_REPOSITORY };
    }
    result = validateRelease({ format: 1, platform: 'linux/amd64', registry: values.registry, images }, false);
  } else throw new Error('Use assemble PART.json... --output FILE, or lock --registry NAME --names api,... --output FILE');
  assert.ok(values.output, 'An output file is required');
  await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(`Image manifest saved: ${values.output}`);
}
