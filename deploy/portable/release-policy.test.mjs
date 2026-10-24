import test from 'node:test';
import assert from 'node:assert/strict';
import { lockImageReferences } from './release-policy.mjs';

const names = ['api', 'engine', 'payments', 'withdrawals', 'client', 'admin', 'backup', 'edge'];
function fixture() {
  return { state: 'built-not-published', images: Object.fromEntries(names.map(name => [name, { ref: `ghcr.io/example/${name}:r1`, localId: `local-${name}` }])) };
}
function inspect(ref) {
  const name = ref.split('/').at(-1).split(':')[0];
  return { Id: `local-${name}`, RepoDigests: [`ghcr.io/example/${name}@sha256:${'a'.repeat(64)}`] };
}
test('local RepoDigests alone do not prove publication', () => {
  assert.throws(() => lockImageReferences(fixture(), inspect, () => false), /Publish and verify/);
});
test('locks all eight digests only after remote verification', () => {
  const calls = [];
  const result = lockImageReferences(fixture(), inspect, ref => { calls.push(ref); return true; });
  assert.equal(calls.length, 8);
  assert.equal(result.trim().split('\n').length, 8);
  assert.match(result, /CADDY_IMAGE=ghcr.io\/example\/edge@sha256:/);
});
test('fails if the local artifact changed after build', () => {
  assert.throws(() => lockImageReferences(fixture(), () => ({ Id: 'other' }), () => true), /changed after build/);
});
test('rejects incomplete releases', () => {
  const manifest = fixture(); delete manifest.images.backup;
  assert.throws(() => lockImageReferences(manifest, inspect, () => true), /eight/);
});
