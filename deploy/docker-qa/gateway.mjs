import http from 'node:http';

// Docker's internal networks cannot publish ports. Only this credential-free
// loopback gateway has a second network; application services remain isolated.
const services = new Map([
  [3300, ['client', 3000]], [3301, ['admin', 3000]], [3302, ['api', 3000]],
  [3305, ['payments', 9095]], [3307, ['withdrawals', 9097]],
]);
for (const [port, [hostname, targetPort]] of services) {
  const server = http.createServer((request, response) => {
    const upstream = http.request({
      hostname, port: targetPort, path: request.url, method: request.method,
      headers: { ...request.headers, connection: 'close' }, timeout: 15000,
    }, result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('QA upstream timeout')));
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end('QA upstream unavailable');
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.requestTimeout = 15000;
  server.listen(port, '0.0.0.0');
}
