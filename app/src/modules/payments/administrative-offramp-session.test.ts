import { expect, test } from 'bun:test';
import { administrativeOfframpInput, administrativeOfframpQuote, administrativeOfframpWidgetUrl, prepareAdministrativeOfframp } from './administrative-offramp-session';
import { sandboxMeldJson, sandboxOperationScope } from './meld-sandbox-http';
import { offAddress, offCustomer, offDatabase, offEnvironment, offId, offInput, offQuote, offRoutes } from './administrative-offramp-fixtures';
const principal = { subject: 'synthetic-owner', nativeSessionId: 'synthetic-native-session', clientIp: '192.0.2.1', environment: offEnvironment };
const hosted = 'https://sb.meldcrypto.com/?token=synthetic.sandbox-token';

test('SELL preparation checks the native-owned intent first, quotes exact units and creates one sandbox widget with server identity', async () => {
  const db = offDatabase(), calls: string[] = [];
  const result = await prepareAdministrativeOfframp(db.database, offInput, { ...principal,
    fetchImpl: (async (target: string | Request | URL, init?: RequestInit) => {
      const url = new URL(String(target)); calls.push(url.pathname); expect(url.origin).toBe('https://api-sb.meld.io');
      expect(new Headers(init?.headers).get('authorization')).toBe('BASIC synthetic-sandbox-key'); expect(init?.redirect).toBe('error'); expect(db.queries).toHaveLength(1);
      if (url.pathname.includes('/supported/routes/')) { expect(init?.method).toBe('GET'); expect(url.pathname).toEndWith('/US/USDT_POLYGON/USD'); return Response.json(offRoutes()); }
      const body = JSON.parse(String(init?.body)); expect(init?.method).toBe('POST');
      if (url.pathname.includes('/crypto/quote')) { expect(body).toEqual({ countryCode: 'US', sourceCurrencyCode: 'USDT_POLYGON', destinationCurrencyCode: 'USD',
        sourceAmount: 100, paymentMethodType: 'PAYOUT_TO_CARD', serviceProviders: ['TRANSAK'] }); return Response.json(offQuote()); }
      expect(body).toMatchObject({ sessionType: 'SELL', externalCustomerId: offCustomer, externalSessionId: offId,
        sessionData: { serviceProvider: 'TRANSAK', countryCode: 'US', clientIpAddress: '192.0.2.1', sourceCurrencyCode: 'USDT_POLYGON', sourceAmount: '100',
          destinationCurrencyCode: 'USD', paymentMethodType: 'PAYOUT_TO_CARD', walletAddress: offAddress, redirectFlow: true,
          redirectUrl: `https://wallet.mindblisspower.com/dashboard/wallet-administrative?offrampReference=${offId}` } });
      return Response.json({ id: 'synthetic-session', externalSessionId: offId, externalCustomerId: offCustomer, widgetUrl: hosted, token: 'private-provider-token' });
    }) as unknown as typeof fetch });
  expect(calls).toHaveLength(3); expect(db.queries).toHaveLength(2);
  expect(db.queries[0]!.params).toEqual([principal.subject, principal.nativeSessionId, offId, 'US', 'USD', '100', 'TRANSAK', 'PAYOUT_TO_CARD', 'synthetic-account']);
  expect(db.queries[1]!.params).toEqual([principal.subject, principal.nativeSessionId, offId, 'session_created', 'synthetic-session', 95.01]);
  expect(result).toMatchObject({ flow: 'administrative_offramp', walletKind: 'administrative', environment: 'sandbox', reference: offId,
    sourceAmount: '100', source: { address: offAddress, asset: 'USDT', network: 'polygon', chainId: 137 }, checkoutUrl: hosted,
    execution: { canBroadcast: false, canFund: false, mode: 'sandbox_no_funds' } });
  expect(JSON.stringify(db.queries)).not.toMatch(/token=|private-provider-token|commission|wallet_movement|eth_send|depositWallet/);
});

test('native signer/session denial and disabled or incomplete environment perform no provider requests', async () => {
  let calls = 0; const fetchImpl = (async () => { calls++; throw Error('must not call'); }) as unknown as typeof fetch;
  for (const change of [{ ADMINISTRATIVE_MELD_OFFRAMP_ENABLED: 'false' }, { ADMINISTRATIVE_WALLET_SIGNING_ENABLED: 'false' },
    { MELD_ADMIN_SANDBOX_ENABLED: 'false' }, { MELD_API_SANDBOX: '' }, { MELD_ACCOUNT_ID: '' }]) {
    const db = offDatabase([]); await expect(prepareAdministrativeOfframp(db.database, offInput, { ...principal, environment: { ...offEnvironment, ...change }, fetchImpl })).rejects.toThrow('administrative_offramp_unconfigured'); expect(db.queries).toHaveLength(0);
  }
  for (const code of ['administrative_transfer_binding_required', 'administrative_signing_forbidden']) {
    const db = offDatabase([new Error(code)]); await expect(prepareAdministrativeOfframp(db.database, offInput, { ...principal, fetchImpl })).rejects.toThrow(code); expect(db.queries).toHaveLength(1);
  }
  const replay = offDatabase([[{ id: offId, wallet_address: offAddress, customer_reference: offCustomer, status: 'session_created', created: false, created_at: new Date() }]]);
  await expect(prepareAdministrativeOfframp(replay.database, offInput, { ...principal, fetchImpl })).rejects.toThrow('administrative_operation_already_used'); expect(calls).toBe(0);
});

test('source wallets, owners, callbacks, native sessions and transaction data are never accepted from the browser', async () => {
  for (const key of ['walletAddress', 'sourceWalletAddress', 'subject', 'nativeSessionId', 'callback', 'redirectUrl', 'sessionData', 'chainId', 'token']) {
    const db = offDatabase([]); await expect(prepareAdministrativeOfframp(db.database, { ...offInput, [key]: 'forged' }, principal)).rejects.toThrow(); expect(db.queries).toHaveLength(0);
  }
  for (const amount of ['0', '-1', '1e6', '01', '1.0000001', '1000000000.000001']) expect(administrativeOfframpInput.safeParse({ ...offInput, amount }).success).toBe(false);
});

test('quotes require exact country/provider/asset/method/atomic amount and malformed responses are upstream failures', () => {
  const expected = administrativeOfframpInput.parse(offInput);
  expect(administrativeOfframpQuote(offQuote(), expected).destinationAmount).toBe(95.01);
  for (const change of [{ countryCode: 'MX' }, { serviceProvider: 'BANXA' }, { sourceCurrencyCode: 'USDT' }, { destinationCurrencyCode: 'MXN' },
    { sourceAmount: 99.999999 }, { sourceAmount: 100.00000001 }, { sourceAmount: 100.0000001 }, { destinationAmount: 0 }, { paymentMethodType: 'OTHER' }]) {
    expect(() => administrativeOfframpQuote(offQuote(change), expected)).toThrow('administrative_offramp_unavailable');
  }
  for (const value of [{}, { quotes: [] }, { quotes: [{ private: 'secret' }] }, { quotes: [...offQuote().quotes, ...offQuote().quotes] }]) {
    expect(() => administrativeOfframpQuote(value, expected)).toThrow('administrative_offramp_unavailable');
  }
});

test('route/provider method availability and source-denominated limits prevent widgets; fiat limits never become fake USDT minima', async () => {
  for (const routes of [[], offRoutes().map(route => ({ ...route, paymentMethods: [] })), offRoutes('USD', 'USDT_POLYGON', 101, 2000)]) {
    const db = offDatabase(); let calls = 0;
    await expect(prepareAdministrativeOfframp(db.database, offInput, { ...principal, fetchImpl: (async () => { calls++; return Response.json(routes); }) as unknown as typeof fetch })).rejects.toThrow('administrative_offramp_method_unavailable');
    expect(calls).toBe(1); expect(db.queries[1]!.params[3]).toBe('unavailable');
  }
  const db = offDatabase(); let calls = 0;
  await prepareAdministrativeOfframp(db.database, offInput, { ...principal, fetchImpl: (async (target: string | Request | URL) => {
    calls++; if (String(target).includes('/supported/routes/')) return Response.json(offRoutes('USD', 'USD', 100, 25000));
    if (String(target).includes('/crypto/quote')) return Response.json(offQuote());
    return Response.json({ id: 'synthetic-session', externalSessionId: offId, externalCustomerId: offCustomer, widgetUrl: hosted });
  }) as unknown as typeof fetch });
  expect(calls).toBe(3); // Provider accepted 100 USDT although net payout95.01 is below the gross-reference fiat minimum100.
});

test('quote/session failures and crossed external IDs never retry or persist a successful provider session', async () => {
  for (const failure of ['quote401', 'quoteJSON', 'sessionJSON', 'id', 'customer', 'host']) {
    const db = offDatabase(); let calls = 0, widgets = 0;
    await expect(prepareAdministrativeOfframp(db.database, offInput, { ...principal, fetchImpl: (async (target: string | Request | URL) => {
      calls++; if (String(target).includes('/supported/routes/')) return Response.json(offRoutes());
      if (String(target).includes('/crypto/quote')) return failure === 'quote401' ? Response.json({ message: 'private' }, { status: 401 })
        : failure === 'quoteJSON' ? new Response('{invalid', { headers: { 'content-type': 'application/json' } }) : Response.json(offQuote());
      widgets++; if (failure === 'sessionJSON') return Response.json({ widgetUrl: {} });
      return Response.json({ id: 'synthetic-session', externalSessionId: failure === 'id' ? '11111111-1111-4111-8111-111111111111' : offId,
        externalCustomerId: failure === 'customer' ? '11111111-1111-4111-8111-111111111111' : offCustomer,
        widgetUrl: failure === 'host' ? 'https://meldcrypto.com/?token=live' : hosted });
    }) as unknown as typeof fetch })).rejects.toThrow('administrative_offramp_unavailable');
    expect(calls).toBe(failure.startsWith('quote') ? 2 : 3); expect(widgets).toBe(failure.startsWith('quote') ? 0 : 1);
    expect(db.queries).toHaveLength(2); expect(db.queries[1]!.params[3]).toBe('unavailable');
  }
});

test('hosted SELL URLs reject production, alias hosts, ports, added query fields, empty fragments and encoded tokens', () => {
  expect(administrativeOfframpWidgetUrl(hosted.replace('/?', '?'))).toBe(hosted);
  for (const value of [hosted.replace('sb.', ''), hosted.replace('.com/', '.com:443/'), hosted.replace('.com/', '.com.evil.test/'),
    hosted.replace('https://', 'https://name:pass@'), hosted.replace('/?', '/widget?'), hosted + '#', hosted + '&token=another', hosted + '&redirectUrl=https://evil.test',
    hosted.replace('token=', '%74oken='), hosted.replace('token=', 'wt='), hosted + '\n']) expect(() => administrativeOfframpWidgetUrl(value)).toThrow('administrative_offramp_unavailable');
});

test('sandbox metadata transport bounds malformed or endless bodies, aborts and path aliases without retries', async () => {
  for (const response of [new Response('{bad', { headers: { 'content-type': 'application/json' } }), new Response('x'.repeat(131073), { headers: { 'content-type': 'application/json' } })]) {
    const scope = sandboxOperationScope(undefined, 20);
    try { await expect(sandboxMeldJson('/payments/crypto/quote', { key: 'synthetic', signal: scope.signal, fetchImpl: (async () => response) as unknown as typeof fetch })).rejects.toThrow('administrative_offramp_unavailable'); }
    finally { scope.close(); }
  }
  const scope = sandboxOperationScope(undefined, 5); let calls = 0;
  try { await expect(sandboxMeldJson('/payments/crypto/quote', { key: 'synthetic', signal: scope.signal,
    fetchImpl: (async () => { calls++; return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch })).rejects.toThrow('administrative_offramp_unavailable'); }
  finally { scope.close(); }
  expect(calls).toBe(1);
});
