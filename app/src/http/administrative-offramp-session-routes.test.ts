import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { expect, test } from 'bun:test';
import { registerAdministrativeOfframpSessionRoutes } from './administrative-offramp-session-routes';
import type { ApiEnvironment } from './types';
import type { OfframpDatabase } from '../modules/payments/administrative-offramp-session';
import { offContext, offCustomer, offEnvironment, offId, offInput, offQuote, offRoutes, offAddress, offTransaction } from '../modules/payments/administrative-offramp-fixtures';

const path = '/api/member/administrative-wallet/offramp', origin = 'https://wallet.mindblisspower.com', secret = 's'.repeat(48);
const nativeSession = 'synthetic-native-session';
function signed(raw: unknown, extra: Record<string, string> = {}) {
  const body = JSON.stringify(raw), timestamp = String(Math.floor(Date.now() / 1000)), ip = '192.0.2.1', cookie = 'better-auth.session_token=synthetic';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const signature = createHmac('sha256', secret).update(['POST', path + '/prepare', timestamp, ip, hash(cookie), hash(body)].join('\n')).digest('hex');
  return { method: 'POST', body, headers: { origin, cookie, 'content-type': 'application/json', 'x-vp-auth-client-ip': ip,
    'x-vp-auth-timestamp': timestamp, 'x-vp-auth-signature': signature, ...extra } };
}
function application({ authenticated = true, native = true, enabled = true, outputs = [] as (unknown[] | Error)[], fetchImpl }: {
  authenticated?: boolean; native?: boolean; enabled?: boolean; outputs?: (unknown[] | Error)[]; fetchImpl?: typeof fetch;
} = {}) {
  const queries: { sql: string; params: unknown[] }[] = [], app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => { context.set('session', authenticated ? { user: { id: offContext.subject }, ...(native ? { session: { id: nativeSession } } : {}) } as never : null); await next(); });
  const database = { execute: async (query: SQL) => { const value = new PgDialect().sqlToQuery(query); queries.push(value);
    if (value.sql.includes('record_administrative_offramp_proof')) return [{ proof: JSON.parse(String(value.params[1])) }];
    const result = outputs.shift(); if (result instanceof Error) throw result; if (!result) throw Error('unexpected DB work'); return result;
  } } as unknown as OfframpDatabase;
  registerAdministrativeOfframpSessionRoutes(app, { database, environment: { AUTH_BFF_SHARED_SECRET: secret, ...(enabled ? offEnvironment : {}) },
    fetchImpl: fetchImpl || (async () => { throw Error('unexpected provider call'); }) as unknown as typeof fetch });
  return { app, queries };
}

test('hosted SELL routes require native Better Auth session identity, exact wallet origin and signed strict preparation payloads', async () => {
  const { app, queries } = application();
  for (const suffix of ['/status?reference=' + offId, '/history']) {
    expect((await app.request(path + suffix)).status).toBe(403);
    expect((await app.request(path + suffix, { headers: { origin: 'https://app.mindblisspower.com' } })).status).toBe(403);
    expect((await app.request(path + suffix, { headers: { origin, 'x-vp-act-as': '' } })).status).toBe(403);
    expect((await application({ authenticated: false }).app.request(path + suffix, { headers: { origin } })).status).toBe(401);
    expect((await application({ native: false }).app.request(path + suffix, { headers: { origin } })).status).toBe(401);
  }
  expect((await app.request(path + '/prepare', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(offInput) })).status).toBe(403);
  for (const key of ['subject', 'nativeSessionId', 'walletAddress', 'sourceWalletAddress', 'sessionType', 'redirectUrl', 'sourceCurrencyCode']) {
    expect((await app.request(path + '/prepare', signed({ ...offInput, [key]: 'forged' }))).status).toBe(400);
  }
  const changed = signed(offInput); changed.body = JSON.stringify({ ...offInput, amount: '500' });
  expect((await app.request(path + '/prepare', changed)).status).toBe(403);
  expect((await app.request(path + '/status?reference=' + offId + '&transactionId=foreign', { headers: { origin } })).status).toBe(400);
  expect((await app.request(path + '/history?subject=foreign', { headers: { origin } })).status).toBe(400);
  expect(queries).toHaveLength(0);
});

test('disabled SELL and missing/expired verified bindings are actionable before network activity', async () => {
  const inactive = application({ enabled: false });
  for (const suffix of ['/status?reference=' + offId, '/history']) {
    const response = await inactive.app.request(path + suffix, { headers: { origin } }); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'administrative_offramp_unconfigured' });
  }
  expect((await inactive.app.request(path + '/prepare', signed(offInput))).status).toBe(503); expect(inactive.queries).toHaveLength(0);
  for (const code of ['administrative_signing_forbidden', 'administrative_transfer_binding_required']) {
    const denied = application({ outputs: [new Error('private SQL', { cause: new Error(code) })] });
    const response = await denied.app.request(path + '/prepare', signed(offInput)); expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'administrative_operation_forbidden' }); expect(denied.queries).toHaveLength(1);
  }
});

test('one hosted SELL preparation uses assigned source and retained native session, without funding a sandbox deposit', async () => {
  let calls = 0;
  const { app, queries } = application({ outputs: [[{ ...offContext, status: 'initiated', created: true }], [{ finished: true }]],
    fetchImpl: (async (target: string | Request | URL, init?: RequestInit) => {
      calls++; if (String(target).includes('/supported/routes/')) return Response.json(offRoutes());
      if (String(target).includes('/crypto/quote')) return Response.json(offQuote());
      const body = JSON.parse(String(init?.body)); expect(body.sessionData.walletAddress).toBe(offAddress);
      expect(body.sessionData.lockFields).toEqual(['sourceCurrencyCode', 'walletAddress', 'destinationCurrencyCode', 'sourceAmount', 'paymentMethodType']);
      return Response.json({ id: 'synthetic-session', externalSessionId: offId, externalCustomerId: offCustomer, widgetUrl: 'https://sb.meldcrypto.com/?token=synthetic.session' });
    }) as unknown as typeof fetch });
  const response = await app.request(path + '/prepare', signed(offInput)); expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toMatchObject({ flow: 'administrative_offramp', environment: 'sandbox', reference: offId, status: 'session_created',
    execution: { canBroadcast: false, canFund: false, mode: 'sandbox_no_funds' } });
  expect(calls).toBe(3); expect(queries).toHaveLength(2); expect(queries[0]!.params.slice(0, 2)).toEqual([offContext.subject, nativeSession]);
});

test('malformed quote or session responses are sanitized HTTP503 upstream errors rather than invalid customer input', async () => {
  for (const step of ['quote', 'session']) {
    let calls = 0;
    const { app, queries } = application({ outputs: [[{ ...offContext, status: 'initiated', created: true }], [{ finished: true }]],
      fetchImpl: (async (target: string | Request | URL) => {
        calls++; if (String(target).includes('/supported/routes/')) return Response.json(offRoutes());
        if (String(target).includes('/crypto/quote')) return step === 'quote'
          ? new Response('{"private-token":', { headers: { 'content-type': 'application/json' } }) : Response.json(offQuote());
        return Response.json({ id: { privateToken: 'do-not-expose' }, widgetUrl: {} });
      }) as unknown as typeof fetch });
    const response = await app.request(path + '/prepare', signed(offInput)); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'administrative_offramp_unavailable' }); expect(queries).toHaveLength(2);
    expect(calls).toBe(step === 'quote' ? 2 : 3); expect(queries[1]!.params[3]).toBe('unavailable');
  }
});

test('native status can confirm sandbox-only proof while history reads cached evidence without provider work', async () => {
  let calls = 0;
  const { app, queries } = application({ outputs: [[offContext]], fetchImpl: (async (target: string | Request | URL) => {
    calls++; return String(target).includes('/payments/transactions?') ? Response.json({ transactions: [{ id: 'synthetic-transaction' }] }) : Response.json({ transaction: offTransaction });
  }) as unknown as typeof fetch });
  const response = await app.request(path + '/status?reference=' + offId, { headers: { origin } }); expect(response.status).toBe(200);
  const body = await response.json(); expect(body).toMatchObject({ confirmation: { state: 'confirmed', testMode: true, source: 'meld_sandbox_api' }, execution: { canFund: false, canBroadcast: false } });
  expect(JSON.stringify(body)).not.toMatch(/depositWallet|private-provider-token|synthetic-account|synthetic-session/);
  expect(calls).toBe(2); expect(queries).toHaveLength(2);
});

test('native preparers reject actual oversized or aborted stream bodies before SQL and provider calls', async () => {
  const { app, queries } = application();
  const oversized = signed(offInput, { 'content-length': '1' }); oversized.body = 'x'.repeat(2049);
  const result = await app.request(path + '/prepare', oversized); expect(result.status).toBe(413); expect(queries).toHaveLength(0);
  const controller = new AbortController(), request = signed(offInput);
  const stream = new ReadableStream<Uint8Array>({ pull() { controller.abort(); return new Promise(() => {}); } });
  const response = await app.request(new Request('https://api.example.invalid' + path + '/prepare', {
    method: 'POST', headers: request.headers, body: stream, signal: controller.signal,
  }));
  expect(response.status).toBe(503); expect(queries).toHaveLength(0);
});
