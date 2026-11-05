import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble, validateRelease, releaseId, services } from './release.mjs';

export function fixture() {
  return { format: 1, platform: 'linux/amd64', registry: 'test-registry', images: Object.fromEntries(services.map(name =>
    [name, { repository: `mindbliss-${name}`, digest: `sha256:${'a'.repeat(64)}`, commit: 'b'.repeat(40), source: 'example/backend' }])) };
}
test('release combines three repositories and identifies the same six digests deterministically', () => {
  const all = fixture();
  const parts = [['api', 'engine', 'payments', 'withdrawals'], ['client'], ['admin']].map(names =>
    ({ ...all, images: Object.fromEntries(names.map(name => [name, all.images[name]])) }));
  assert.deepEqual(assemble(parts), assemble(parts.reverse()));
  assert.equal(releaseId(all), releaseId(assemble([all])));
});
test('release fails closed for placeholders, tags, foreign repositories and incomplete backends', () => {
  for (const mutate of [
    x => { x.images.api.digest = `sha256:${'0'.repeat(64)}`; },
    x => { x.images.api.digest = 'latest'; },
    x => { x.images.api.repository = 'foreign-api'; },
    x => { x.images.api.tag = 'latest'; },
    x => { x.images.api.commit = 'c'.repeat(40); },
    x => { delete x.images.admin; },
    x => { x.secret = 'must-not-be-in-artifact'; },
  ]) { const value = fixture(); mutate(value); assert.throws(() => validateRelease(value)); }
});
test('a component cannot be replaced by a later duplicate lock or another registry', () => {
  const value = fixture();
  assert.throws(() => assemble([value, value]), /Duplicate/);
  assert.throws(() => assemble([value, { ...value, registry: 'another-registry' }]), /mix registries/);
});
