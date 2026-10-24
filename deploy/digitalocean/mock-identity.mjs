// Synthetic identity provider for isolated Docker tests only. Never deploy this.
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'RS256', use: 'sig' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/.well-known/jwks.json') return res.end(JSON.stringify({ keys: [jwk] }));
  if (req.url === '/token') {
    const now = Math.floor(Date.now() / 1000);
    const value = `${encode({ alg: 'RS256', kid: 'synthetic' })}.${encode({ sub: 'synthetic-admin', email: 'admin@example.invalid', email_verified: true,
      token_use: 'id', iss: 'http://identity:8081', aud: 'synthetic-client', iat: now, exp: now + 900 })}`;
    return res.end(JSON.stringify({ token: `${value}.${sign('RSA-SHA256', Buffer.from(value), privateKey).toString('base64url')}` }));
  }
  res.end(JSON.stringify({ synthetic: true }));
}).listen(8081, '0.0.0.0');
