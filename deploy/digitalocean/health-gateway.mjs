import { createServer } from 'node:http';

const target = new URL(process.env.HEALTH_TARGET);
if (target.protocol !== 'http:' || target.port !== '3000' || target.pathname !== '/health' || target.search) {
  throw new Error('Only the fixed synthetic API health endpoint is allowed');
}
// A loopback-only health gateway; never a general proxy into the private stack.
createServer(async (request, response) => {
  if (request.method !== 'GET' || request.url !== '/health') {
    response.writeHead(404).end();
    return;
  }
  try {
    const result = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    response.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(await result.text());
  } catch {
    response.writeHead(503, { 'content-type': 'application/json' }).end('{"status":"unavailable"}');
  }
}).listen(3000, '0.0.0.0');
