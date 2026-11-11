import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { readReownProductionOptions } from './reown-funding-options';
import { createPersonalFundingIntent, readWalletFundingHistory, readWalletFundingStatus } from './wallet-funding';
import { preparePersonalCompanyPayment, submitPersonalCompanyPayment, verifyPersonalCompanyPayment, readPersonalCompanyPaymentHistory } from './personal-company-payment';
import { COMPANY_PAYMENT_TOKEN, COMPANY_PAYMENT_RECIPIENT, COMPANY_PAYMENT_TRANSFER_TOPIC, companyPaymentCalldata } from './personal-company-rpc';

// Opt-in only: the Docker-only runner supplies this dedicated role and a marked
// disposable database. Never inherit DATABASE_URL, AUTH_DATABASE_URL or .env.
const enabled = process.env.PERSONAL_WALLET_FLOW_SYNTHETIC_DOCKER === '1';
function syntheticTarget(value: string | undefined) {
  const url = new URL(value || 'postgres://invalid');
  if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' || url.port !== '5432'
    || url.pathname !== '/mindbliss_curated_20261025' || url.username !== 'personal_flow_fixture'
    || url.password || url.search || url.hash) throw Error('Personal wallet flow requires its isolated Docker fixture');
  return url.href;
}
if (!enabled) test.skip('joined personal funding and MAX payment requires the explicit disposable Docker flow harness', () => {});
else describe('joined personal flow with real isolated SQL and synthetic providers', () => {
  const client = postgres(syntheticTarget(process.env.PERSONAL_WALLET_FLOW_DATABASE_URL), { max: 1, prepare: false,
    connection: { statement_timeout: 3000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000 }, onnotice() {} });
  const database = drizzle(client), previousFetch = globalThis.fetch;
  let blockedExternalCalls = 0;
  const environment = { PERSONAL_COMPANY_PAYMENTS_ENABLED: 'true', REOWN_PROJECT_ID: 'a'.repeat(32) };
  beforeAll(async () => {
    expect(Bun.version).toBe('1.4.4');
    globalThis.fetch = (() => { blockedExternalCalls++; throw Error('Synthetic wallet flow forbids real provider calls'); }) as unknown as typeof fetch;
    const [identity] = await client`SELECT current_user AS role,current_setting('mindbliss.personal_wallet_flow_fixture',true) AS marker`;
    expect(identity).toEqual({ role: 'personal_flow_fixture', marker: 'isolated-v1' });
    const [privileges] = await client`SELECT has_table_privilege(current_user,'payments.personal_company_payment','SELECT,INSERT,UPDATE,DELETE')
      OR has_table_privilege(current_user,'payments.reown_funding_intent','SELECT,INSERT,UPDATE,DELETE') AS unsafe`;
    expect(privileges!.unsafe).toBe(false);
  });
  afterAll(async () => { globalThis.fetch = previousFetch; await client.end({ timeout: 2 }); expect(blockedExternalCalls).toBe(0); });

  for (const scenario of [
    { name: 'USD card', owner: 'flow-card', sender: `0x${'56'.repeat(20)}`, country: 'US', currency: 'USD', method: 'CREDIT_DEBIT_CARD', sourceAmount: 100, fundedAtomic: 98_640_123n, hash: `0x${'a1'.repeat(32)}` },
    { name: 'Mexico SPEI', owner: 'flow-spei', sender: `0x${'78'.repeat(20)}`, country: 'MX', currency: 'MXN', method: 'SPEI', sourceAmount: 931, fundedAtomic: 46_560_000n, hash: `0x${'b2'.repeat(32)}` },
  ]) test(`${scenario.name}: zero balance → simulated funding → exact MAX → registered receipt, with funding still unconfirmed`, async () => {
    const fundingId = randomUUID(), paymentId = randomUUID(), blockHash = `0x${'c3'.repeat(32)}`;
    let balance = 0n, dispatched = false, head = 110n, providerGets = 0;
    const rpcMethods: string[] = [];
    const word = (value: string) => `0x${value.replace(/^0x/, '').padStart(64, '0')}`;
    const fakeProvider = (async (target, init) => {
      const url = new URL(String(target));
      if (url.hostname === 'api.meld.io') {
        expect(init?.method).toBe('GET'); expect(url.pathname).toContain(`/${scenario.country}/${scenario.currency}/USDT_POLYGON`);
        expect(url.searchParams.get('partners')).toBe('SWAPPED,MERCURYO'); providerGets++;
        return Response.json([{ partner: 'SWAPPED', source: scenario.currency, destination: 'USDT_POLYGON', paymentMethods: [
          { name: scenario.method, limits: { currencyCode: scenario.currency, min: scenario.currency === 'MXN' ? 148.66 : 7.81, max: 200_000 } },
        ] }]);
      }
      expect(url.origin + url.pathname).toBe('https://rpc.walletconnect.org/v1');
      expect(init?.method).toBe('POST');
      const request = JSON.parse(String(init?.body)); rpcMethods.push(request.method);
      const transaction = { hash: scenario.hash, from: scenario.sender, to: COMPANY_PAYMENT_TOKEN, input: companyPaymentCalldata(scenario.fundedAtomic.toString()),
        value: '0x0', chainId: '0x89', blockNumber: '0x64', blockHash };
      const results: Record<string, unknown> = { eth_chainId: '0x89', eth_getTransactionByHash: dispatched ? transaction : null,
        eth_getTransactionReceipt: dispatched ? { transactionHash: scenario.hash, from: scenario.sender, to: COMPANY_PAYMENT_TOKEN,
          blockNumber: '0x64', blockHash, status: '0x1', logs: [{ address: COMPANY_PAYMENT_TOKEN,
            topics: [COMPANY_PAYMENT_TRANSFER_TOPIC, word(scenario.sender), word(COMPANY_PAYMENT_RECIPIENT)], data: word(scenario.fundedAtomic.toString(16)), removed: false }] } : null,
        eth_blockNumber: `0x${head.toString(16)}`, eth_getBlockByNumber: { number: '0x64', hash: blockHash } };
      if (request.method === 'eth_call') {
        const input = request.params[0]; expect(input.to).toBe(COMPANY_PAYMENT_TOKEN);
        if (input.data === '0x313ce567') return Response.json({ jsonrpc: '2.0', id: request.id, result: word('6') });
        expect(input.data).toBe(`0x70a08231${scenario.sender.slice(2).padStart(64, '0')}`);
        return Response.json({ jsonrpc: '2.0', id: request.id, result: word(balance.toString(16)) });
      }
      expect(Object.hasOwn(results, request.method)).toBe(true);
      return Response.json({ jsonrpc: '2.0', id: request.id, result: results[request.method] });
    }) as typeof fetch;
    const options = { environment, fetchImpl: fakeProvider };
    if (scenario.currency === 'USD') {
      await expect(createPersonalFundingIntent(database, { requestId: randomUUID(), walletAddress: scenario.sender, country: scenario.country,
        sourceCurrencyCode: 'USD', paymentMethodType: scenario.method, amount: 20 }, scenario.owner, {
        fetchImpl: (async () => { throw new Error('USD20 cannot bypass the public minimum even in this synthetic flow'); }) as unknown as typeof fetch,
      })).rejects.toThrow('wallet_funding_amount_unavailable');
    }
    const available = await readReownProductionOptions(scenario.country, { sourceCurrencyCode: scenario.currency, fetchImpl: fakeProvider });
    expect(available.paymentMethods).toContain(scenario.method);
    if (scenario.currency === 'USD') expect(available.routes[0]!.paymentMethods[0]).toMatchObject({ minimumAmount: 100, maximumAmount: 15000 });
    if (scenario.currency === 'MXN') expect(available.routes[0]!.paymentMethods[0]!.minimumAmount).toBe(931);
    const funding = await createPersonalFundingIntent(database, { requestId: fundingId, walletAddress: scenario.sender, country: scenario.country,
      sourceCurrencyCode: scenario.currency, paymentMethodType: scenario.method, amount: scenario.sourceAmount }, scenario.owner, { fetchImpl: fakeProvider });
    expect(funding.status).toBe('initiated'); expect(funding.requestedAmount).toBe(scenario.sourceAmount); expect(balance).toBe(0n);
    await expect(preparePersonalCompanyPayment(database, { requestId: paymentId, amountAtomic: scenario.fundedAtomic.toString() }, scenario.owner, options))
      .rejects.toThrow('company_payment_insufficient_balance');
    expect((await readPersonalCompanyPaymentHistory(database, scenario.owner)).records).toHaveLength(0);

    // Deliberate simulation boundary: a test fixture supplies an observed token
    // balance. Neither an onramp purchase nor fiat/USDT valuation is inferred.
    balance = scenario.fundedAtomic;
    const prepared = await preparePersonalCompanyPayment(database, { requestId: paymentId, amountAtomic: balance.toString() }, scenario.owner, options);
    expect(prepared.amountAtomic).toBe(scenario.fundedAtomic.toString()); expect(prepared.status).toBe('prepared');
    expect(prepared.walletAddress).toBe(scenario.sender); expect(prepared.membershipAssignment).toBe('pending');
    await expect(submitPersonalCompanyPayment(database, { paymentId, transactionHash: scenario.hash }, scenario.owner, options))
      .rejects.toThrow('company_payment_transaction_pending');

    // No wallet RPC is sent. Only the fake read provider now exposes the fixture
    // transaction/receipt and the post-MAX zero balance.
    dispatched = true; balance = 0n;
    const submitted = await submitPersonalCompanyPayment(database, { paymentId, transactionHash: scenario.hash }, scenario.owner, options);
    expect(submitted.status).toBe('submitted'); expect(submitted.transactionHash).toBe(scenario.hash);
    const waiting = await verifyPersonalCompanyPayment(database, { paymentId }, scenario.owner, options);
    expect(waiting.status).toBe('submitted'); expect(waiting.confirmations).toBe(11);
    head = 111n;
    const confirmed = await verifyPersonalCompanyPayment(database, { paymentId }, scenario.owner, options);
    expect(confirmed.status).toBe('confirmed'); expect(confirmed.confirmations).toBe(12); expect(confirmed.membershipAssignment).toBe('pending');
    const callsAfterConfirmation = rpcMethods.length;
    expect(await submitPersonalCompanyPayment(database, { paymentId, transactionHash: scenario.hash }, scenario.owner, options)).toEqual(confirmed);
    expect(await verifyPersonalCompanyPayment(database, { paymentId }, scenario.owner, options)).toEqual(confirmed);
    expect(await preparePersonalCompanyPayment(database, { requestId: paymentId, amountAtomic: scenario.fundedAtomic.toString() }, scenario.owner, options)).toEqual(confirmed);
    expect(rpcMethods).toHaveLength(callsAfterConfirmation);
    await expect(preparePersonalCompanyPayment(database, { requestId: randomUUID(), amountAtomic: '1' }, scenario.owner, options))
      .rejects.toThrow('company_payment_insufficient_balance');
    const persisted = await readPersonalCompanyPaymentHistory(database, scenario.owner);
    expect(persisted.records).toHaveLength(1); expect(persisted.records[0]!.amountAtomic).toBe(scenario.fundedAtomic.toString());
    const originalFunding = await readWalletFundingStatus(database, scenario.owner, 'personal', fundingId);
    expect(originalFunding.requestStatus).toBe('initiated');
    expect(originalFunding.confirmation).toEqual({ state: 'unconfirmed', source: 'none', testMode: false });
    expect((await readWalletFundingHistory(database, scenario.owner, 'personal')).settlement).toBe('unconfirmed');
    expect((await readWalletFundingHistory(database, scenario.owner, 'administrative')).records).toHaveLength(0);
    expect(providerGets).toBe(2);
    expect(rpcMethods.every(method => ['eth_chainId', 'eth_call', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_blockNumber', 'eth_getBlockByNumber'].includes(method))).toBe(true);
    expect(balance).toBe(0n);
    const written = await database.execute(sql`SELECT * FROM payments.read_personal_company_payment(${scenario.owner},${paymentId}::uuid)`);
    expect(written).toHaveLength(1);
  }, 20_000);
});
