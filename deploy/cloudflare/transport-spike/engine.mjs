import http2 from 'node:http2';
import http from 'node:http';
const pems = JSON.parse(process.env.SYNTHETIC_PEMS);
const server = http2.createSecureServer({ key: pems.serverKey, cert: pems.serverCert, ca: pems.caCert, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
server.on('tlsClientError', () => {});
server.on('sessionError', () => {});
server.on('stream', stream => {
  stream.on('error', () => {});
  const chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  stream.on('end', () => {
    if (stream.destroyed) return;
    stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-encoding': 'identity' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.end(Buffer.concat(chunks));
  });
});
server.listen(50051, '0.0.0.0');
http.createServer((_, response) => response.end('synthetic only')).listen(8080, '0.0.0.0');
