import { imageKeys } from './manage.mjs';

export function lockImageReferences(manifest, inspectLocal, verifyRemote) {
  if (manifest.state !== 'built-not-published') throw new Error('A complete build manifest is required');
  const lines = [];
  for (const [name, entry] of Object.entries(manifest.images)) {
    if (!imageKeys[name]) throw new Error(`Unknown release service: ${name}`);
    const image = inspectLocal(entry.ref);
    if (image.Id !== entry.localId) throw new Error(`Image changed after build: ${name}`);
    const repo = entry.ref.slice(0, entry.ref.lastIndexOf(':'));
    const digest = image.RepoDigests?.find(ref => ref.startsWith(`${repo}@sha256:`));
    if (!digest) throw new Error(`No digest for the tested image: ${name}`);
    // Docker Desktop can record RepoDigests before a push. Only an authenticated
    // registry lookup proves another host can obtain this immutable artifact.
    if (verifyRemote(digest) !== true) throw new Error(`Publish and verify the registry image first: ${name}`);
    lines.push(`${imageKeys[name]}=${digest}`);
  }
  if (lines.length !== 8) throw new Error('All eight application/tool images are required');
  return `${lines.join('\n')}\n`;
}
