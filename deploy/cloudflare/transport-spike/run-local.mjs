// Synthetic only. Generates short-lived local certificates, never reads .env.local.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
if (process.platform === 'win32') throw new Error('Wrangler Containers local development needs Linux/WSL. Do not use remote dev as a workaround.');
const { unstable_dev } = await import(process.env.SPIKE_TOOL_ROOT ? `${process.env.SPIKE_TOOL_ROOT}/node_modules/wrangler/wrangler-dist/cli.js` : '../core/node_modules/wrangler/wrangler-dist/cli.js');
const runtime = join(directory, 'runtime');
mkdirSync(runtime, { recursive: true });
const pki = mkdtempSync(join(runtime, 'synthetic-pki-'));
const openssl = process.env.SPIKE_OPENSSL || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
const run = args => execFileSync(openssl, args, { cwd: pki, stdio: 'pipe', timeout: 30_000, windowsHide: true });
run(['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=Synthetic local spike CA', '-keyout', 'ca.key', '-out', 'ca.crt', '-addext', 'basicConstraints=critical,CA:TRUE']);
for (const [name, usage] of [['server', 'serverAuth'], ['client', 'clientAuth']]) {
  run(['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-subj', `/CN=${name === 'server' ? 'engine.synthetic.internal' : 'synthetic-client'}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
  writeFileSync(join(pki, `${name}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\n${name === 'server' ? 'subjectAltName=DNS:engine.synthetic.internal\n' : ''}`);
  run(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-out', `${name}.crt`, '-extfile', `${name}.ext`]);
}
run(['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=Untrusted synthetic client', '-keyout', 'alien.key', '-out', 'alien.crt']);
const pems = Object.fromEntries([['caCert', 'ca.crt'], ['serverKey', 'server.key'], ['serverCert', 'server.crt'], ['clientKey', 'client.key'], ['clientCert', 'client.crt'], ['alienKey', 'alien.key'], ['alienCert', 'alien.crt']].map(([key, file]) => [key, readFileSync(join(pki, file), 'utf8')]));
process.env.WRANGLER_SEND_METRICS = 'false';
let worker;
try {
  worker = await unstable_dev(join(directory, 'worker.ts'), { config: join(directory, 'wrangler.jsonc'), local: true, envFiles: [], port: 8797, persist: false, vars: { SYNTHETIC_PEMS: JSON.stringify(pems) }, logLevel: 'error', experimental: { forceLocal: true, enableContainers: true, disableExperimentalWarning: true, disableDevRegistry: true, watch: false } });
  const denied = await worker.fetch('http://localhost/engine');
  assert.equal(denied.status, 404);
  const result = await worker.fetch('http://localhost/run', { signal: AbortSignal.timeout(60_000) });
  const body = await result.json();
  writeFileSync(join(runtime, 'last-local-result.json'), JSON.stringify({ synthetic: true, localOnly: true, status: result.status, result: body }, null, 2));
  if (result.status !== 200) console.log(JSON.stringify({ synthetic: true, failure: body }));
  assert.equal(result.status, 200);
  assert.deepEqual(body.privateOutboundHttp, { status: 200, matched: true });
  assert.deepEqual(body.valid, { sameBytes: true, grpcStatus: '0', alpn: 'h2' });
  assert.deepEqual(body.large, { sameBytes: true, grpcStatus: '0', alpn: 'h2' });
  for (const name of ['missingClient', 'wrongClient', 'wrongServer', 'wrongCa']) assert.equal(body[name].rejected, true, name);
  console.log(JSON.stringify({ synthetic: true, localOnly: true, tests: 8, result: body }));
} finally {
  await worker?.stop();
  // Wrangler currently leaves local interception sidecars after stopping.
  // Remove only this fixture's exact SDK-generated container name patterns.
  const names = execFileSync('docker', ['ps', '-a', '--filter', 'name=workerd-mindbliss-grpc-transport-synthetic-local-only-', '--format', '{{.Names}}'], { encoding: 'utf8', windowsHide: true }).trim().split('\n').filter(Boolean);
  for (const name of names) {
    if (!/^workerd-mindbliss-grpc-transport-synthetic-local-only-Synthetic(?:Engine|Client)-[a-f0-9]{64}(?:-proxy)?$/.test(name)) throw new Error('Unexpected cleanup target; refusing to remove it');
    execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe', windowsHide: true });
  }
}
