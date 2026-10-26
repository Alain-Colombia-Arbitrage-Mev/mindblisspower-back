// Local-only workaround for cloudflare/workers-sdk#15257. No TCP listener,
// daemon reconfiguration, DNS change, runtime TLS change, or production import.
import http from 'node:http';
import net from 'node:net';
import { chmodSync } from 'node:fs';

const SIDECAR = /^workerd-mindbliss-real-core-synthetic-local-only-Fixture(?:Api|Engine|Probe)-[a-f0-9]{64}-proxy$/;

export function rewriteSyntheticSidecarCreate(method, target, body, gateway) {
  if (gateway !== '172.17.0.1') throw new Error('Unsupported synthetic bridge gateway');
  const url = new URL(target, 'http://docker.local');
  if (method !== 'POST' || !/^\/(?:v\d+\.\d+\/)?containers\/create$/.test(url.pathname)
    || !SIDECAR.test(url.searchParams.get('name') || '')) return body;
  const data = JSON.parse(body);
  data.Cmd = [...(data.Cmd || []).filter(value => !value.startsWith('--gateway-ip=')), `--gateway-ip=${gateway}`];
  return Buffer.from(JSON.stringify(data));
}

export async function startSyntheticDockerProxy(socketPath, gateway) {
  if (!/^\/tmp\/mindbliss-synthetic-docker-\d+\.sock$/.test(socketPath)
    || gateway !== '172.17.0.1') throw new Error('Invalid isolated Docker proxy configuration');
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const body = rewriteSyntheticSidecarCreate(req.method, req.url, Buffer.concat(chunks), gateway);
      const headers = { ...req.headers, 'content-length': String(body.length) };
      delete headers['transfer-encoding'];
      const outgoing = http.request({ socketPath: '/var/run/docker.sock', path: req.url, method: req.method, headers }, upstream => {
        res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res);
      });
      outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('aborted', () => outgoing.destroy()); outgoing.end(body);
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  server.on('upgrade', (req, client, head) => {
    const upstream = net.connect('/var/run/docker.sock', () => {
      const headers = req.rawHeaders.reduce((all, value, index) => all + value + (index % 2 ? '\r\n' : ': '), '');
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  return { close: () => new Promise(resolve => server.close(resolve)) };
}
