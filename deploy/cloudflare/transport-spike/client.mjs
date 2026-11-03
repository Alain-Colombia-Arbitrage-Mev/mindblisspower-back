import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { Readable, Writable } from 'node:stream';
import { relayWebSocketToSocket } from './framed-relay.mjs';
const pems = JSON.parse(process.env.SYNTHETIC_PEMS);
const active = new Set();
const proxy = net.createServer({ pauseOnConnect: true }, socket => {
  const ws = new WebSocket('ws://engine.synthetic.internal/tunnel');
  const timeout = setTimeout(() => { socket.destroy(); ws.close(); }, 5000);
  socket.on('error', () => {});
  ws.addEventListener('error', event => { console.error('SYNTHETIC_WS_FAILURE', event.message ?? 'WebSocket failed'); socket.destroy(); });
  ws.addEventListener('open', () => {
    clearTimeout(timeout);
    const relay = relayWebSocketToSocket(ws, { readable: Readable.toWeb(socket), writable: Writable.toWeb(socket), close: () => socket.destroy() });
    active.add(relay); void relay.done.finally(() => active.delete(relay)); socket.resume();
  });
  socket.on('close', () => { clearTimeout(timeout); ws.close(); });
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = proxy.address().port;

async function exchange({ cert = pems.clientCert, key = pems.clientKey, ca = pems.caCert, servername = 'engine.synthetic.internal', bytes = 13 } = {}) {
  const socket = tls.connect({ host: '127.0.0.1', port: proxyPort, servername, ca, ...(cert === null ? {} : { cert, key }), rejectUnauthorized: true, ALPNProtocols: ['h2'] });
  const client = http2.connect('https://engine.synthetic.internal', { createConnection: () => socket });
  client.on('error', () => {});
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic deadline exceeded')), 8000);
      socket.on('error', reject); client.on('error', reject);
      const payload = Buffer.alloc(bytes + 5, 7); payload[0] = 0; payload.writeUInt32BE(bytes, 1);
      const request = client.request({ ':method': 'POST', ':path': '/synthetic.Echo/Run', 'content-type': 'application/grpc', te: 'trailers' });
      const chunks = []; let status;
      request.on('trailers', trailers => { status = trailers['grpc-status']; });
      request.on('data', chunk => chunks.push(chunk)); request.on('error', reject);
      request.on('end', () => {
        clearTimeout(timer);
        if (!Buffer.concat(chunks).equals(payload) || status !== '0' || socket.alpnProtocol !== 'h2') return reject(new Error('No valid authenticated gRPC response'));
        resolve({ sameBytes: true, grpcStatus: status, alpn: socket.alpnProtocol });
      });
      request.end(payload);
    });
  } finally { client.destroy(); socket.destroy(); }
}

http.createServer(async (request, response) => {
  if (request.url !== '/run') return response.end('synthetic only');
  const results = {};
  try {
    const probe = await fetch('http://engine.synthetic.internal/probe', { signal: AbortSignal.timeout(5000) });
    results.privateOutboundHttp = { status: probe.status, matched: (await probe.text()) === 'synthetic private outbound reached' };
    results.valid = await exchange();
    results.large = await exchange({ bytes: 512 * 1024 });
    for (const [name, options] of Object.entries({ missingClient: { cert: null, key: null }, wrongClient: { cert: pems.alienCert, key: pems.alienKey }, wrongServer: { servername: 'wrong.invalid' }, wrongCa: { ca: pems.alienCert } })) {
      try { results[name] = { rejected: false, result: await exchange(options) }; } catch { results[name] = { rejected: true }; }
    }
    results.synthetic = true;
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(results));
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ synthetic: true, failed: true, ...results, reason: String(error?.code ?? error?.message ?? 'unknown') })); }
}).listen(8080, '0.0.0.0');
