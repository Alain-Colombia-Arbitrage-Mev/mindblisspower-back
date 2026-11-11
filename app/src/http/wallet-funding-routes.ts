import { z } from 'zod';
import { createAdministrativeSandboxSession, createPersonalFundingIntent, fundingKindInput,
  readAdministrativeSandboxOptions, readWalletFundingHistory, readWalletFundingStatus } from '../modules/payments/wallet-funding';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiApplication } from './types';
import { authProxyContext } from './auth-proxy-context';
import { readReownProductionOptions } from '../modules/payments/reown-funding-options';

type Dependencies = { database: Pick<IdentityDatabase, 'execute'>;
  environment?: Record<string, string | undefined>; fetchImpl?: typeof fetch };
const noStore = { 'Cache-Control': 'private, no-store' };

const PERSONAL_FUNDING_ORIGINS = new Set(['https://mindblisspower.com', 'https://app.mindblisspower.com', 'https://mindbliss-portal-rewon.devfidubit.workers.dev']);
const ADMINISTRATIVE_FUNDING_ORIGIN = 'https://wallet.mindblisspower.com';

function allowedOrigin(kind: 'personal' | 'administrative', value: string, environment: Record<string, string | undefined>) {
  if (kind === 'personal' ? !PERSONAL_FUNDING_ORIGINS.has(value) : value !== ADMINISTRATIVE_FUNDING_ORIGIN) return false;
  return [environment.BETTER_AUTH_URL, ...(environment.BETTER_AUTH_TRUSTED_ORIGINS || '').split(',')]
    .filter(Boolean).some(candidate => { try { return new URL(candidate!.trim()).origin === value; } catch { return false; } });
}

function failure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { error: 'invalid_request', status: 400 as const };
  let current: unknown = error, code = '';
  // Drizzle wraps PostgreSQL failures. Inspect only bounded canonical codes;
  // query text, parameters and provider messages never enter an HTTP response.
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const wrapped = current as { message?: unknown; cause?: unknown };
    if (typeof wrapped.message === 'string' && /^wallet_funding_[a-z_]{1,80}$/.test(wrapped.message)) { code = wrapped.message; break; }
    current = wrapped.cause;
  }
  if (['wallet_funding_invalid_country', 'wallet_funding_invalid_currency'].includes(code)) return { error: 'invalid_request', status: 400 as const };
  if (code === 'wallet_funding_not_found') return { error: code, status: 404 as const };
  if (['wallet_funding_forbidden', 'wallet_funding_wallet_not_linked', 'wallet_funding_wallet_not_assigned'].includes(code)) {
    return { error: 'wallet_funding_forbidden', status: 403 as const };
  }
  if (['wallet_funding_request_already_used', 'wallet_funding_network_changed'].includes(code)) return { error: code, status: 409 as const };
  if (code === 'wallet_funding_rate_limited') return { error: code, status: 429 as const };
  if (code === 'wallet_funding_unconfigured') return { error: code, status: 503 as const };
  if (code === 'wallet_funding_method_unavailable') return { error: code, status: 409 as const };
  if (code === 'wallet_funding_amount_unavailable') return { error: code, status: 409 as const };
  if (code === 'wallet_funding_provider_unavailable') return { error: code, status: 503 as const };
  if (['wallet_funding_provider_authentication_unavailable', 'wallet_funding_valuation_unavailable'].includes(code)) return { error: code, status: 503 as const };
  return { error: 'wallet_funding_unavailable', status: 503 as const };
}

export function registerWalletFundingRoutes(app: ApiApplication, {
  database, environment = process.env, fetchImpl = fetch,
}: Dependencies) {
  for (const kind of ['personal', 'administrative'] as const) {
    const path = kind === 'personal' ? '/api/member/wallet-funding/personal/intent'
      : '/api/member/wallet-funding/administrative/session';
    app.post(path, async (context, next) => {
      context.header('Cache-Control', 'private, no-store');
      if (kind !== 'administrative') return next();
      if (!context.get('session')?.user.id) return context.json({ error: 'unauthenticated' }, 401, noStore);
      const secret = environment.AUTH_BFF_SHARED_SECRET;
      if (!secret || secret.length < 32) return context.json({ error: 'wallet_funding_unconfigured' }, 503, noStore);
      return authProxyContext(secret)(context, next);
    }, async context => {
      const subject = context.get('session')?.user.id;
      if (!subject) return context.json({ error: 'unauthenticated' }, 401, noStore);
      if (!allowedOrigin(kind, context.req.header('origin') || '', environment)) return context.json({ error: 'invalid_origin' }, 403, noStore);
      if (context.req.header('content-encoding') || !/^application\/json(?:\s*;|$)/i.test(context.req.header('content-type') || '')) {
        return context.json({ error: 'json_required' }, 415, noStore);
      }
      const declared = context.req.header('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) return context.json({ error: 'request_too_large' }, 413, noStore);
      try {
        const raw = await context.req.text();
        if (Buffer.byteLength(raw, 'utf8') > 4096) return context.json({ error: 'request_too_large' }, 413, noStore);
        const input: unknown = JSON.parse(raw);
        const result = kind === 'personal' ? await createPersonalFundingIntent(database, input, subject, { fetchImpl, signal: context.req.raw.signal })
          : await createAdministrativeSandboxSession(database, input, {
            subject, clientIp: context.req.header('x-vp-auth-client-ip') || '', environment, fetchImpl, signal: context.req.raw.signal,
          });
        return context.json(result, 201, noStore);
      } catch (error) { const next = failure(error); return context.json({ error: next.error }, next.status, noStore); }
    });
  }

  app.get('/api/member/wallet-funding/personal/options', async context => {
    if (!context.get('session')?.user.id) return context.json({ error: 'unauthenticated' }, 401, noStore);
    try {
      const query = new URL(context.req.url).searchParams;
      const country = query.get('country');
      const sourceCurrencyCode = query.get('sourceCurrencyCode') ?? 'USD';
      if ([...query.keys()].some(key => !['country', 'sourceCurrencyCode'].includes(key))
        || query.getAll('country').length !== 1 || query.getAll('sourceCurrencyCode').length > 1
        || !/^[A-Z]{2}$/.test(country || '') || !/^[A-Z]{3}$/.test(sourceCurrencyCode)) {
        return context.json({ error: 'invalid_request' }, 400, noStore);
      }
      return context.json(await readReownProductionOptions(country!, { fetchImpl, signal: context.req.raw.signal, sourceCurrencyCode }), 200, noStore);
    } catch (error) { const next = failure(error); return context.json({ error: next.error }, next.status, noStore); }
  });

  app.get('/api/member/wallet-funding/administrative/options', async context => {
    if (!context.get('session')?.user.id) return context.json({ error: 'unauthenticated' }, 401, noStore);
    try {
      const query = new URL(context.req.url).searchParams;
      if ([...query.keys()].some(key => !['country', 'sourceCurrencyCode', 'serviceProvider'].includes(key))
        || query.getAll('country').length !== 1 || query.getAll('serviceProvider').length !== 1 || query.getAll('sourceCurrencyCode').length > 1) {
        return context.json({ error: 'invalid_request' }, 400, noStore);
      }
      const result = await readAdministrativeSandboxOptions({ country: query.get('country'), serviceProvider: query.get('serviceProvider'),
        sourceCurrencyCode: query.get('sourceCurrencyCode') ?? 'USD' }, { environment, fetchImpl, signal: context.req.raw.signal });
      return context.json(result, 200, noStore);
    } catch (error) { const next = failure(error); return context.json({ error: next.error }, next.status, noStore); }
  });

  app.get('/api/member/wallet-funding/history', async context => {
    const subject = context.get('session')?.user.id;
    if (!subject) return context.json({ error: 'unauthenticated' }, 401, noStore);
    try {
      const query = new URL(context.req.url).searchParams;
      if ([...query.keys()].length !== 1 || !query.has('walletKind')) return context.json({ error: 'invalid_request' }, 400, noStore);
      const walletKind = fundingKindInput.parse(query.get('walletKind'));
      return context.json(await readWalletFundingHistory(database, subject, walletKind), 200, noStore);
    } catch (error) { const next = failure(error); return context.json({ error: next.error }, next.status, noStore); }
  });

  for (const walletKind of ['personal', 'administrative'] as const) {
    app.get(`/api/member/wallet-funding/${walletKind}/status`, async context => {
      const subject = context.get('session')?.user.id;
      if (!subject) return context.json({ error: 'unauthenticated' }, 401, noStore);
      try {
        const query = new URL(context.req.url).searchParams;
        if ([...query.keys()].length !== 1 || query.getAll('checkoutReference').length !== 1) {
          return context.json({ error: 'invalid_request' }, 400, noStore);
        }
        return context.json(await readWalletFundingStatus(database, subject, walletKind, query.get('checkoutReference')), 200, noStore);
      } catch (error) { const result = failure(error); return context.json({ error: result.error }, result.status, noStore); }
    });
  }
}
