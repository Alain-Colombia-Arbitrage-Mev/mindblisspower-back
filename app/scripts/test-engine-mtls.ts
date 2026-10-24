import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSecureServer, connect, type SecureClientSessionOptions } from 'node:http2';
import path from 'node:path';
import { engineTransportOptions } from '../src/clients/engine-transport';

const fixture = process.env.MTLS_FIXTURE_DIR;
if (!fixture) throw new Error('MTLS_FIXTURE_DIR must point to synthetic certificate fixtures');
const read = (relative: string) => readFileSync(path.join(fixture, relative));
const server = createSecureServer({ key: read('server/server.key'), cert: read('server/server.crt'), ca: read('server/ca.crt'), requestCert: true, rejectUnauthorized: true });
server.on('error', () => {});
server.on('sessionError', () => {});
server.on('stream', stream => { stream.respond({ ':status': 200 }); stream.end('verified'); });
await new Promise<void>(resolve => server.listen(0, resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No test server port');
const baseUrl = `https://localhost:${address.port}`;
const options = engineTransportOptions({
  VP_ENGINE_GRPC_URL: baseUrl, ENGINE_MTLS_REQUIRED: 'true',
  VP_ENGINE_TLS_CA: path.join(fixture, 'client/ca.crt'),
  VP_ENGINE_TLS_CERT: path.join(fixture, 'client/client.crt'),
  VP_ENGINE_TLS_KEY: path.join(fixture, 'client/client.key'),
});
function request(tlsOptions: SecureClientSessionOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const session = connect(baseUrl, tlsOptions);
    const timer = setTimeout(() => { session.destroy(); reject(new Error('TLS test timeout')); }, 5000);
    const fail = (error: Error) => { clearTimeout(timer); session.destroy(); reject(error); };
    session.on('error', fail);
    const stream = session.request({ ':path': '/' });
    stream.on('error', fail);
    let result = '';
    stream.setEncoding('utf8');
    stream.on('data', data => { result += data; });
    stream.on('end', () => {
      clearTimeout(timer); session.close();
      if (result !== 'verified') reject(new Error('HTTP/2 stream closed without authenticated response'));
      else resolve(result);
    });
    stream.end();
  });
}
try {
  assert.equal(await request(options.nodeOptions as SecureClientSessionOptions), 'verified');
  await assert.rejects(request({ ca: read('client/ca.crt'), rejectUnauthorized: true }), 'Client certificate must be required');
  await assert.rejects(request({ ...(options.nodeOptions as SecureClientSessionOptions), servername: 'wrong-host.invalid' }), 'Server hostname must be verified');
  console.log('PASS: real HTTP/2 mTLS handshake, refusal of missing client identity and wrong server hostname.');
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
}
