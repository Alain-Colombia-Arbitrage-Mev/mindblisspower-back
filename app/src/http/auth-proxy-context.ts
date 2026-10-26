import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { MiddlewareHandler } from 'hono';

// Signed proxy context supplies a trustworthy rate-limit IP, not authentication.
// The backend must not be reachable through an unsigned bypass after BFF cutover.
export function authProxyContext(secret: string | undefined): MiddlewareHandler {
  return async (context, next) => {
    if (!secret) return next(); // legacy direct mode, no custom IP header trusted
    if (secret.length < 32) return context.json({ error: 'auth_proxy_unconfigured' }, 503);
    // Public keys are safe without browser cookies or proxy credentials.
    if (context.req.method === 'GET' && context.req.path === '/api/auth/jwks') return next();
    const ip = context.req.header('x-vp-auth-client-ip') || '';
    const timestamp = context.req.header('x-vp-auth-timestamp') || '';
    const signature = context.req.header('x-vp-auth-signature') || '';
    if (!isIP(ip) || !/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)
      || Math.abs(Date.now() / 1000 - Number(timestamp)) > 30) return context.json({ error: 'invalid_auth_proxy' }, 403);
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const body = ['GET', 'HEAD'].includes(context.req.method) ? '' : await context.req.raw.clone().text();
    const message = [context.req.method, context.req.path, timestamp, ip, hash(context.req.header('cookie') || ''), hash(body)].join('\n');
    const expected = createHmac('sha256', secret).update(message).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return context.json({ error: 'invalid_auth_proxy' }, 403);
    await next();
  };
}
