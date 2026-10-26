import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteSyntheticSidecarCreate, startSyntheticDockerProxy } from './synthetic-docker-proxy.mjs';

const name = `workerd-mindbliss-real-core-synthetic-local-only-FixtureApi-${'a'.repeat(64)}-proxy`;
const body = Buffer.from(JSON.stringify({ Image: 'synthetic-sidecar', Cmd: ['-tls-intercept', '--gateway-ip=192.168.65.254'] }));

test('local workaround rewrites only exact synthetic sidecar create commands', () => {
  for (const prefix of ['/', '/v1.51/']) {
    const rewritten = JSON.parse(rewriteSyntheticSidecarCreate('POST', `${prefix}containers/create?name=${name}`, body, '172.17.0.1'));
    assert.deepEqual(rewritten, { Image: 'synthetic-sidecar', Cmd: ['-tls-intercept', '--gateway-ip=172.17.0.1'] });
  }
});

test('unrelated containers, other requests and malformed synthetic names remain byte-identical', () => {
  for (const [method, target] of [
    ['GET', `/containers/create?name=${name}`], ['POST', '/containers/create?name=production'],
    ['POST', `/containers/create?name=${name.slice(0, -6)}`], ['POST', `/containers/${name}/start`],
    ['POST', `/not-a-docker-api/containers/create?name=${name}`],
  ]) assert.equal(rewriteSyntheticSidecarCreate(method, target, body, '172.17.0.1'), body);
});

test('workaround refuses arbitrary gateway addresses or non-isolated socket paths', async () => {
  assert.throws(() => rewriteSyntheticSidecarCreate('POST', `/containers/create?name=${name}`, body, '127.0.0.1'));
  await assert.rejects(startSyntheticDockerProxy('/tmp/docker.sock', '172.17.0.1'));
  await assert.rejects(startSyntheticDockerProxy('/tmp/mindbliss-synthetic-docker-123.sock', '192.168.65.254'));
});
