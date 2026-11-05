import assert from 'node:assert/strict';
import { connect } from 'node:http2';

let checks = 0;
async function probe(url, expected, options = {}) {
  const result = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  assert.equal(result.status, expected, `${url}: HTTP ${result.status}`);
  checks++;
  return result;
}
await probe('http://api:3000/health', 200);
await probe('http://engine:9090/health', 200);
await probe('http://payments:9095/health', 200);
await probe('http://withdrawals:9097/health', 200);
await probe('http://api:3000/api/auth/sign-in/email', 401, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://synthetic.example.invalid' },
  body: JSON.stringify({ email: 'nobody@example.invalid', password: 'synthetic-invalid-password' }) });
await probe('http://payments:9095/api/admin/finance?email=admin@example.invalid', 401);
await probe('http://withdrawals:9097/api/admin/withdrawals?email=admin@example.invalid', 401);
const serviceOnly = { 'X-VP-Service-Token': process.env.SERVICE_TOKEN };
await probe('http://payments:9095/api/admin/finance?email=admin@example.invalid', 401, { headers: serviceOnly });
await probe('http://withdrawals:9097/api/admin/withdrawals?email=admin@example.invalid', 401, { headers: serviceOnly });
const { token } = await (await fetch('http://identity:8081/token')).json();
const headers = { ...serviceOnly, 'X-VP-Id-Token': token };
for (const route of ['/api/admin/finance', '/api/admin/tree/roots', '/api/admin/network/health']) {
  await (await probe(`http://payments:9095${route}?email=admin@example.invalid`, 200, { headers })).json();
}
await probe('http://withdrawals:9097/api/admin/withdrawals?email=admin@example.invalid', 200, { headers });
await probe('http://payments:9095/api/webhooks/stripe', 400, { method: 'POST', body: '{}' });

function grpc(options) {
  return new Promise((resolve, reject) => {
    const session = connect('https://engine:50051', options);
    const timer = setTimeout(() => { session.destroy(); reject(new Error('mTLS timeout')); }, 5000);
    const fail = error => { clearTimeout(timer); session.destroy(); reject(error); };
    session.on('error', fail);
    const stream = session.request({ ':path': '/' });
    stream.on('error', fail);
    stream.on('response', result => {
      clearTimeout(timer); stream.close(); session.close(); resolve(result[':status']);
    });
    stream.resume(); stream.end();
  });
}
const tls = { ca: process.env.VP_ENGINE_TLS_CA_PEM, cert: process.env.VP_ENGINE_TLS_CERT_PEM,
  key: process.env.VP_ENGINE_TLS_KEY_PEM, rejectUnauthorized: true };
assert.equal(await grpc(tls), 404); checks++;
await assert.rejects(grpc({ ca: tls.ca, rejectUnauthorized: true })); checks++;
await assert.rejects(grpc({ ...tls, servername: 'wrong.example.invalid' })); checks++;
console.log(JSON.stringify({ passed: checks, environment: process.env.TARGET_ENV, synthetic: true }));
