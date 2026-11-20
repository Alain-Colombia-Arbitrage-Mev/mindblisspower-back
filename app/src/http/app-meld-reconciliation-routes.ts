import { bodyLimit } from 'hono/body-limit';
import type { IdentityDatabase } from '../modules/identity/model';
import { productionOperation } from '../modules/payments/meld-production-http';
import { readAdministrativeRequestBody } from './administrative-request-body';
import { verifyAuthProxyEnvelope } from './auth-proxy-context';
import type { ApiApplication } from './types';

export const APP_MELD_RECONCILIATION_PATH = '/internal/app-meld-reconcile';
type Environment = Record<string, string | undefined>;
type Database = Pick<IdentityDatabase, 'execute'>;
type Reconcile = (database: Database, options: { environment: Environment; signal: AbortSignal }) => Promise<{ processed: number }>;

export function registerAppMeldReconciliation(app: ApiApplication, {
  database, reconcile, environment = process.env,
}: { database: Database; reconcile: Reconcile; environment?: Environment }) {
  const noStore = { 'Cache-Control': 'private, no-store' };
  app.post(APP_MELD_RECONCILIATION_PATH,
    bodyLimit({ maxSize: 2, onError: c => c.json({ error: 'not_found' }, 404, noStore) }),
    async c => {
      const request = c.req.raw, url = new URL(request.url);
      const secret = environment.AUTH_BFF_SHARED_SECRET;
      const ip = request.headers.get('x-vp-auth-client-ip') ?? '';
      const timestamp = request.headers.get('x-vp-auth-timestamp') ?? '';
      const signature = request.headers.get('x-vp-auth-signature') ?? '';
      // The private Container may terminate TLS before forwarding to Bun.
      if (environment.ENV !== 'production' || environment.APP_MELD_PRODUCTION_ENABLED !== 'true'
        || url.pathname !== APP_MELD_RECONCILIATION_PATH || url.search || url.hash || request.url.endsWith('?')
        || ['cookie', 'authorization', 'origin', 'x-vp-act-as', 'content-encoding'].some(name => request.headers.has(name))
        || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')
        || !secret || secret.length > 4096 || /[\r\n]/.test(secret) || ip !== '127.0.0.1'
        || !verifyAuthProxyEnvelope(secret, { method: 'POST', path: APP_MELD_RECONCILIATION_PATH, ip, timestamp,
          signature, cookie: '', body: '{}' })) return c.json({ error: 'not_found' }, 404, noStore);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
      try {
        if (await readAdministrativeRequestBody(request, 3_000) !== '{}') return c.json({ error: 'not_found' }, 404, noStore);
        const { processed } = await productionOperation(() => reconcile(database, { environment, signal }), signal);
        if (!Number.isSafeInteger(processed) || processed < 0 || processed > 5) throw Error('invalid reconciliation result');
        return c.json({ processed }, 200, noStore);
      } catch { return c.json({ error: 'wallet_funding_unavailable' }, 503, noStore); }
    });
}
