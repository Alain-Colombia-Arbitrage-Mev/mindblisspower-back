import { expect, test } from 'bun:test';
import { Interface, TypedDataEncoder, Wallet } from 'ethers';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from '../identity/model';
import { COMPANY_PAYMENT_RECIPIENT, LEGACY_POLYGON_TOKEN, POLYGON_USDC_TOKEN, companyPaymentCalldata } from './personal-company-rpc';
import { POLYGON_RELAY_DOMAIN, POLYGON_RELAY_ENTRY_POINT, POLYGON_RELAY_IMPLEMENTATION, polygonRelayTypedData,
  polygonRelayAuthorizationDigest, verifyPolygonRelayAuthorization, POLYGON_RELAY_ABI } from './polygon-relay-policy';
import { encryptPolygonRelayJson } from './polygon-relay-crypto';
import { preparePersonalPolygonRelay, submitPersonalPolygonRelay, verifyPersonalPolygonRelay, readPersonalPolygonRelay,
  readPersonalPolygonRelayHistory, abandonPersonalPolygonRelay, authorizePersonalPolygonRelay } from './polygon-relay-payment';
import { inspectPolygonRelayReceipt } from './polygon-relay-proof';
import { createPolygonAaRelayer, prepareSignedPolygonRelayOperation } from './polygon-relay-aa';
import { POLYGON_USDC_DOMAIN, POLYGON_USDC_IMPLEMENTATION, polygonUsdcTypedData } from './polygon-usdc-authorization';
import { runAppPagarAccounting, runAppPagarInvestment } from './app-pagar-accounting';

export const id = '11111111-1111-4111-8111-111111111111', attempt = '22222222-2222-4222-8222-222222222222';
const lease = '33333333-3333-4333-8333-333333333333', wallet = new Wallet(`0x${'2'.repeat(64)}`);
export const sender = wallet.address.toLowerCase(), aa = `0x${'4'.repeat(40)}`, paymaster = `0x${'5'.repeat(40)}`, blockHash = `0x${'6'.repeat(64)}`;
const created = new Date('2026-11-11T20:00:00Z'), amount = '30000000';
export const relayEnvironment = { POLYGON_RELAY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  POLYGON_RELAYER_PRIVATE_KEY: `0x${'1'.repeat(64)}`, REOWN_PROJECT_ID: 'a'.repeat(32), PIMLICO_API_KEY: 'synthetic-pimlico-secret',
  PERSONAL_POLYGON_RELAY_ENABLED: 'true', PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED: 'true' };
export const relayBase = { id, subject: 'owner', wallet_address: sender, amount_atomic: amount, execution_mode: 'polygon_native_meta_aa', chain_id: 137,
  token_address: LEGACY_POLYGON_TOKEN, token_decimals: 6, recipient_address: COMPANY_PAYMENT_RECIPIENT,
  authorization_nonce: '7', authorization_digest: polygonRelayAuthorizationDigest(sender, amount, '7'), domain_separator: TypedDataEncoder.hashDomain(POLYGON_RELAY_DOMAIN),
  implementation_address: POLYGON_RELAY_IMPLEMENTATION, relayer_address: aa, entry_point: POLYGON_RELAY_ENTRY_POINT,
  max_fee_wei: '1000000000000000000', owner_daily_cap_wei: '2000000000000000000', global_daily_cap_wei: '10000000000000000000',
  created_at: created, expires_at: new Date(created.getTime() + 300_000), authorized_at: null, authorization_ciphertext: null, authorization_key_id: null,
  status: 'prepared', attempt_id: null, user_operation_hash: null, transaction_hash: null, block_number: null, block_hash: null, confirmations: 0,
  confirmed_at: null, failure_reason: null, entry_point_nonce: null, lease_token: null, lease_expires_at: null,
  operation_ciphertext: null, operation_key_id: null, quoted_max_fee_wei: null, operation_valid_after: null, operation_valid_until: null };
function databaseFor(execute: (query: { sql: string; params: unknown[] }) => unknown[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  return { queries, database: { execute: async (input: unknown) => { const query = new PgDialect().sqlToQuery(input as SQL); queries.push(query); return execute(query); } } as Pick<IdentityDatabase, 'execute'> };
}
const noFetch = (async () => { throw Error('unexpected external call'); }) as unknown as typeof fetch;
async function authorized() {
  const typed = polygonRelayTypedData(sender, amount, '7'), signature = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  const encrypted = encryptPolygonRelayJson(relayEnvironment, `polygon-relay:owner:${id}:authorization`, { signature, authorizationDigest: relayBase.authorization_digest });
  return { ...relayBase, status: 'authorized', authorized_at: created, authorization_ciphertext: encrypted.ciphertext, authorization_key_id: encrypted.keyId };
}
function readFetch(methods: string[], onSend?: () => void): typeof fetch {
  return (async (target, init) => {
    const request = JSON.parse(String(init?.body)); methods.push(request.method);
    let result: unknown;
    if (request.method === 'eth_chainId') result = '0x89';
    else if (request.method === 'eth_call') {
      const data = request.params[0].data;
      result = data === '0x313ce567' ? `0x${'6'.padStart(64, '0')}` : data.startsWith('0x70a08231') ? `0x${BigInt(amount).toString(16).padStart(64, '0')}`
        : data === POLYGON_RELAY_ABI.encodeFunctionData('getNonce', [sender]) ? `0x${'7'.padStart(64, '0')}`
        : data === POLYGON_RELAY_ABI.encodeFunctionData('implementation') ? `0x${POLYGON_RELAY_IMPLEMENTATION.slice(2).padStart(64, '0')}`
        : data === POLYGON_RELAY_ABI.encodeFunctionData('getDomainSeperator') ? relayBase.domain_separator : undefined;
    } else if (request.method === 'eth_sendUserOperation') { onSend?.(); result = (request.params[0] as Record<string, string>).__expectedHash; }
    if (result === undefined) throw Error('unapproved RPC method');
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  }) as typeof fetch;
}
function fakeRelayer(counter: { quotes: number; signs: number }) {
  const safe = new Interface(['function executeUserOpWithErrorString(address,uint256,bytes,uint8)']);
  return (async () => ({ relayerAddress: aa, operationValidAfter: 1000, operationValidUntil: 1330,
    account: { getNonce: async () => 0n, getFactoryArgs: async () => ({}), encodeCalls: async (calls: { data: string }[]) => safe.encodeFunctionData('executeUserOpWithErrorString', [LEGACY_POLYGON_TOKEN, 0n, calls[0]!.data, 0]),
      signUserOperation: async () => { counter.signs++; return `0x${(1000).toString(16).padStart(12, '0')}${(1330).toString(16).padStart(12, '0')}${'a'.repeat(130)}`; } },
    client: { prepareUserOperation: async ({ callData }: { callData: string }) => { counter.quotes++; return { sender: aa, nonce: 0n,
      callData,
      callGasLimit: 1000n, verificationGasLimit: 1000n, preVerificationGas: 1000n, paymasterVerificationGasLimit: 1000n, paymasterPostOpGasLimit: 1000n,
      maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, paymaster, paymasterData: '0x1234' }; } },
  })) as unknown as typeof createPolygonAaRelayer;
}

test('relay projections are owner-bound, never leak ciphertext/lease/signatures and immutable UUID replays never re-quote', async () => {
  const stored = await authorized(), db = databaseFor(() => [stored]);
  const result = await readPersonalPolygonRelay(db.database, 'owner', id);
  expect(result).toMatchObject({ paymentId: id, status: 'authorized', authorizationHasOnchainExpiry: false, chainId: 137, membershipAssignment: 'pending' });
  expect(JSON.stringify(result)).not.toMatch(/cipher|signature|lease|subject/);
  expect((await preparePersonalPolygonRelay(db.database, { requestId: id, amountAtomic: amount }, 'owner', { environment: relayEnvironment, fetchImpl: noFetch })).status).toBe('authorized');
  await expect(preparePersonalPolygonRelay(db.database, { requestId: id, amountAtomic: '1' }, 'owner', { environment: relayEnvironment, fetchImpl: noFetch })).rejects.toThrow('polygon_relay_request_already_used');
  await expect(readPersonalPolygonRelay(databaseFor(() => [stored]).database, 'other', id)).rejects.toThrow('polygon_relay_unavailable');
  expect((await readPersonalPolygonRelayHistory(databaseFor(() => [stored]).database, 'owner')).payments).toHaveLength(1);
  expect(db.queries.every(query => !/ledger|membership|administrative|company_payment_v3/.test(query.sql))).toBe(true);
});

test('only fresh production App preparations bind an accounting intent inside the prepare statement', async () => {
  for (const [env, allowUsdc, bind] of [
    ['production', true, true], ['production', false, false], ['staging', true, false],
  ] as const) {
    const db = databaseFor(({ sql }) => {
      if (sql.includes('FROM auth.user')) return [{ subject: 'owner', user_id: 'owner',
        auth_email: 'owner@example.invalid', person_email: 'owner@example.invalid',
        email_verified: true, person_id: '1', public_id: '1', blacklisted: false, access_restricted: false, person_status: 'active' }];
      if (sql.includes('FROM identity.wallet_binding')) return [{ address: sender, chain_id: 1, verified_at: created }];
      return sql.includes('prepare_personal_polygon_relay') ? [{ ...relayBase, accounting_intent: bind }] : [];
    });
    const counter = { quotes: 0, signs: 0 };
    const prepared = await preparePersonalPolygonRelay(db.database, { requestId: id, amountAtomic: amount }, 'owner', {
      environment: { ...relayEnvironment, ENV: env, APP_PAGAR_ACCOUNTING_ENABLED: 'true' },
      fetchImpl: readFetch([]), createRelayer: fakeRelayer(counter), allowUsdc,
    });
    const statements = db.queries.filter(query => query.sql.includes('register_app_pagar_intent_v1'));
    expect(statements).toHaveLength(bind ? 1 : 0);
    if (bind) expect(statements[0]!.sql).toContain('WITH draft AS MATERIALIZED');
    expect(prepared.status).toBe('prepared');
    expect(Object.hasOwn(prepared, 'accounting_intent')).toBeFalse();
    expect(counter).toEqual({ quotes: 0, signs: 0 });
  }
});

test('Pagar accounting verifies finality and the original MELD lot before recording the real gross', async () => {
  const inboundHash = '0x' + 'f'.repeat(64), outboundHash = '0x' + 'e'.repeat(64);
  const inboundBlockHash = '0x' + 'c'.repeat(64), externalCustomerId = '55555555-5555-4555-8555-555555555555';
  const amountReceived = 30_000_000, providerId = 'fixture-settlement';
  const deposit = { id: attempt, subject: 'owner', wallet_address: sender, customer_reference: externalCustomerId,
    country_code: 'MX', source_currency: 'MXN', destination_currency: 'USDT_POLYGON', chain_id: 137,
    requested_amount: '1000.00', payment_method: 'CREDIT_DEBIT_CARD', service_provider: 'MERCURYO',
    account_id: 'fixture-account', status: 'session_created', provider_session_id: 'fixture-session',
    provider_customer_id: 'fixture-customer', created_at: created };
  const base = { ...await authorized(), status: 'confirmed', attempt_id: lease, user_operation_hash: '0x' + 'b'.repeat(64),
    transaction_hash: outboundHash, block_number: '272', block_hash: blockHash, confirmations: 12, confirmed_at: created };
  const confirmedMeld = { id: providerId, accountId: deposit.account_id, sessionId: deposit.provider_session_id, externalSessionId: attempt,
    customer: { id: deposit.provider_customer_id }, externalCustomerId, transactionType: 'CRYPTO_PURCHASE', serviceProvider: 'MERCURYO',
    countryCode: 'MX', sourceCurrencyCode: 'MXN', sourceAmount: 1000, destinationCurrencyCode: 'USDT_POLYGON',
    destinationAmount: 30, paymentMethodType: 'CREDIT_DEBIT_CARD', fiatAmountInUsd: 50, updatedAt: created.toISOString(),
    cryptoDetails: { destinationWalletAddress: sender, chainId: '137', blockchainTransactionId: inboundHash } };
  for (const [latest, providerStatus, records] of [
    ['0x111', 'SETTLED', 1], ['0x10f', 'SETTLED', 0], ['0x111', 'REFUNDED', 0],
  ] as const) {
    const db = databaseFor(({ sql }) => {
      if (sql.includes('read_app_pagar_pending_v1')) return [{ subject: 'owner', payment_id: id }];
      if (sql.includes('read_app_pagar_candidates_v1')) return [{ attempt_id: attempt, meld_transaction_id: providerId,
        gross_usd_minor: '5000', received_atomic: String(amountReceived), blockchain_tx_hash: inboundHash,
        block_number: '256', block_hash: inboundBlockHash, transfer_log_index: 0 }];
      if (sql.includes('read_personal_polygon_relay')) return [base];
      if (sql.includes('read_app_meld_funding_v3')) return [deposit];
      if (sql.includes('record_app_pagar_accounting_v1')) return [{ recorded: true }];
      throw Error('unexpected SQL');
    });
    const fetchImpl = (async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://api.meld.io') {
        expect(init?.method).toBe('GET');
        return url.pathname === '/payments/transactions'
          ? Response.json({ transactions: [{ id: providerId }] })
          : Response.json({ transaction: { ...confirmedMeld, status: providerStatus } });
      }
      expect(url.origin).toBe('https://rpc.walletconnect.org');
      const request = JSON.parse(String(init?.body));
      let result: unknown;
      if (request.method === 'eth_chainId') result = '0x89';
      else if (request.method === 'eth_getBlockByNumber') {
        const number = request.params[0] === 'finalized' ? latest : request.params[0];
        result = { number, hash: number === '0x100' ? inboundBlockHash : blockHash };
      } else if (request.method === 'eth_getTransactionReceipt') {
        expect(request.params).toEqual([inboundHash]);
        result = { transactionHash: inboundHash, blockHash: inboundBlockHash, blockNumber: '0x100', status: '0x1',
          logs: [{ address: LEGACY_POLYGON_TOKEN, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            '0x' + '0'.repeat(64), '0x' + sender.slice(2).padStart(64, '0')], logIndex: '0x0',
          data: '0x' + amountReceived.toString(16).padStart(64, '0') }] };
      } else throw Error('unexpected RPC method');
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }) as typeof fetch;
    const env = { ...relayEnvironment, ENV: 'production', APP_PAGAR_ACCOUNTING_ENABLED: 'true',
      PERSONAL_COMPANY_PAYMENTS_ENABLED: 'true',
      MELD_PRODUCTION_API_KEYS: 'fixture', MELD_PRODUCTION_ACCOUNT_ID: deposit.account_id };
    const result = await runAppPagarAccounting(db.database, { environment: env, fetchImpl });
    expect(result).toEqual({ recorded: records });
    const postings = db.queries.filter(query => query.sql.includes('record_app_pagar_accounting_v1'));
    expect(postings).toHaveLength(records);
    if (records) expect(postings[0]!.params).toEqual(['owner', id, '273', attempt]);
  }
});

test('the Pagar investment job only reaches its own writer under both explicit production flags', async () => {
  const db = databaseFor(({ sql }) => {
    expect(sql).toContain('payments.run_app_pagar_roi_v1()');
    return [{ activated: 1, accrued_days: 0 }];
  });
  const flag = { ENV: 'production', APP_PAGAR_ACCOUNTING_ENABLED: 'true', APP_PAGAR_INVESTMENT_ENABLED: 'true' };
  for (const environment of [{ ...flag, ENV: 'staging' }, { ...flag, APP_PAGAR_ACCOUNTING_ENABLED: 'false' },
    { ...flag, APP_PAGAR_INVESTMENT_ENABLED: 'false' }]) {
    await expect(runAppPagarInvestment(db.database, { environment })).resolves.toEqual({ activated: 0, accrued_days: 0 });
  }
  expect(db.queries).toHaveLength(0);
  await expect(runAppPagarInvestment(db.database, { environment: flag })).resolves.toEqual({ activated: 1, accrued_days: 0 });
  expect(db.queries).toHaveLength(1);
});

test('no signed operation or sponsorship occurs without first SQL lease; persisted replay cannot trigger a send', async () => {
  const base = await authorized(), counter = { quotes: 0, signs: 0 }, methods: string[] = [];
  const busy = databaseFor(query => query.sql.includes('begin_personal') ? [{ ...base, should_prepare: false }] : [base]);
  expect((await submitPersonalPolygonRelay(busy.database, { paymentId: id }, 'owner', { environment: relayEnvironment, fetchImpl: readFetch(methods), createRelayer: fakeRelayer(counter) })).status).toBe('authorized');
  expect(counter).toEqual({ quotes: 0, signs: 0 }); expect(methods).not.toContain('eth_sendUserOperation');
  let leasedRow: Record<string, unknown>;
  const replay = databaseFor(query => {
    if (query.sql.includes('begin_personal')) { leasedRow = { ...base, status: 'broadcasting', attempt_id: attempt, entry_point_nonce: '0', lease_token: lease, lease_expires_at: new Date(Date.now() + 90000), should_prepare: true }; return [leasedRow]; }
    if (query.sql.includes('persist_personal')) return [{ ...leasedRow, user_operation_hash: query.params[4], operation_ciphertext: query.params[5], operation_key_id: 'v1', operation_valid_after: 1000, operation_valid_until: 1330, should_send: false }];
    return [base];
  });
  expect((await submitPersonalPolygonRelay(replay.database, { paymentId: id }, 'owner', { environment: relayEnvironment, fetchImpl: readFetch(methods), createRelayer: fakeRelayer(counter) })).status).toBe('broadcasting');
  expect(counter).toEqual({ quotes: 1, signs: 1 }); expect(methods).not.toContain('eth_sendUserOperation');
});

test('first durable persist ACK precedes exactly one send; lost provider acknowledgement remains ambiguous without resend', async () => {
  const base = await authorized(), counter = { quotes: 0, signs: 0 }, methods: string[] = []; let current: Record<string, unknown> = base;
  const db = databaseFor(query => {
    if (query.sql.includes('begin_personal')) current = { ...base, status: 'broadcasting', attempt_id: attempt, entry_point_nonce: '0', lease_token: lease, lease_expires_at: new Date(Date.now() + 90000), should_prepare: true };
    else if (query.sql.includes('persist_personal')) current = { ...current, user_operation_hash: query.params[4], operation_ciphertext: query.params[5], operation_key_id: 'v1', operation_valid_after: 1000, operation_valid_until: 1330, should_send: true };
    else if (query.sql.includes('mark_personal_polygon_relay_ambiguous')) current = { ...current, status: 'ambiguous' };
    return [current];
  });
  const read = readFetch(methods), provider = (async (target, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === 'eth_sendUserOperation') { methods.push(request.method); expect(db.queries.at(-1)!.sql).toContain('persist_personal'); throw Error('synthetic lost upstream ack'); }
    return read(target, init);
  }) as typeof fetch;
  expect((await submitPersonalPolygonRelay(db.database, { paymentId: id }, 'owner', { environment: relayEnvironment, fetchImpl: provider, createRelayer: fakeRelayer(counter) })).status).toBe('ambiguous');
  expect(methods.filter(method => method === 'eth_sendUserOperation')).toHaveLength(1);
  expect((await submitPersonalPolygonRelay(db.database, { paymentId: id }, 'owner', { environment: relayEnvironment, fetchImpl: noFetch, createRelayer: fakeRelayer(counter) })).status).toBe('ambiguous');
  expect(counter).toEqual({ quotes: 1, signs: 1 });
});

test('expired unsigned fenced lease recovers to the same authorization without any provider, quote or signature', async () => {
  const base = await authorized();
  const db = databaseFor(query => query.sql.includes('release_personal') ? [base] : [{ ...base, status: 'broadcasting', attempt_id: attempt, entry_point_nonce: '0', lease_token: lease, lease_expires_at: new Date(Date.now() - 1000) }]);
  const result = await verifyPersonalPolygonRelay(db.database, { paymentId: id }, 'owner', { environment: relayEnvironment, fetchImpl: noFetch });
  expect(result.status).toBe('authorized'); expect(db.queries.at(-1)!.params).toEqual(['owner', id, attempt, lease, 'preparation_timeout']);
});

test('abandon expires only an unsigned preparation; accepted native authorizations cannot be revoked by UI', async () => {
  const db = databaseFor(() => [{ ...relayBase, status: 'expired', failure_reason: 'preparation_abandoned' }]);
  expect((await abandonPersonalPolygonRelay(db.database, { paymentId: id }, 'owner')).status).toBe('expired');
  expect(db.queries[0]!.params).toEqual(['owner', id]);
  await expect(abandonPersonalPolygonRelay(databaseFor(() => [{ ...relayBase, status: 'expired', authorized_at: created, authorization_ciphertext: 'unsafe' }]).database, { paymentId: id }, 'owner')).rejects.toThrow('polygon_relay_unavailable');
});

test('receipt confirmation scopes exact native/transfer logs to the target UserOperation, never another bundled operation', () => {
  const ep = new Interface(['event BeforeExecution()', 'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']);
  const erc = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)', 'event MetaTransactionExecuted(address userAddress,address relayerAddress,bytes functionSignature)']);
  const userOpHash = `0x${'7'.repeat(64)}`, other = `0x${'8'.repeat(64)}`;
  const log = (abi: Interface, event: string, args: unknown[], emitter = POLYGON_RELAY_ENTRY_POINT) => ({ address: emitter, ...abi.encodeEventLog(abi.getEvent(event)!, args), removed: false });
  const before = log(ep, 'BeforeExecution', []), transfer = log(erc, 'Transfer', [sender, COMPANY_PAYMENT_RECIPIENT, amount], LEGACY_POLYGON_TOKEN),
    meta = log(erc, 'MetaTransactionExecuted', [sender, aa, companyPaymentCalldata(amount)], LEGACY_POLYGON_TOKEN),
    target = log(ep, 'UserOperationEvent', [userOpHash, aa, paymaster, 0n, true, 1000n, 100n]), previous = log(ep, 'UserOperationEvent', [other, aa, paymaster, 99n, true, 1000n, 100n]);
  const context = { paymentId: id, attemptId: attempt, walletAddress: sender, amountAtomic: amount, authorizationNonce: '7', relayerAddress: aa, entryPointNonce: '0', userOperationHash: userOpHash,
    maxFeeWei: '1000000000', operationValidAfter: 1000, operationValidUntil: 1330 };
  const receipt = (logs: unknown[]) => ({ to: POLYGON_RELAY_ENTRY_POINT, status: '0x1', logs });
  expect(inspectPolygonRelayReceipt(receipt([before, transfer, meta, target]), context, paymaster)).toMatchObject({ success: true, matched: true });
  expect(inspectPolygonRelayReceipt(receipt([before, transfer, meta, previous, target]), context, paymaster).matched).toBe(false);
  expect(inspectPolygonRelayReceipt(receipt([before, transfer, previous, meta, target]), context, paymaster).matched).toBe(false);
  expect(() => inspectPolygonRelayReceipt(receipt([before, transfer, meta, target, target]), context, paymaster)).toThrow('polygon_relay_proof_unavailable');
  expect(() => inspectPolygonRelayReceipt(receipt([before, transfer, meta, target]), { ...context, entryPointNonce: '1' }, paymaster)).toThrow();
});

test('native Polygon USDC is scoped to App and commits the signed wallet, destination, amount and expiry across preparation and sponsorship', async () => {
  const environment = { ...relayEnvironment, PERSONAL_POLYGON_USDC_ENABLED: 'true' };
  const domain = TypedDataEncoder.hashDomain(POLYGON_USDC_DOMAIN);
  const abi = new Interface([
    'function DOMAIN_SEPARATOR() view returns(bytes32)', 'function implementation() view returns(address)',
    'function authorizationState(address,bytes32) view returns(bool)',
    'function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
  ]);
  const safe = new Interface(['function executeUserOpWithErrorString(address,uint256,bytes,uint8)']);
  const methods: string[] = [];
  const fetchImpl = (async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    methods.push(request.method);
    let result: string;
    if (request.method === 'eth_chainId') result = '0x89';
    else {
      expect(request.method).toBe('eth_call');
      expect(request.params[0].to).toBe(POLYGON_USDC_TOKEN);
      const data = request.params[0].data;
      if (data === abi.encodeFunctionData('DOMAIN_SEPARATOR')) result = domain;
      else if (data === abi.encodeFunctionData('implementation')) result = '0x' + POLYGON_USDC_IMPLEMENTATION.slice(2).padStart(64, '0');
      else if (data === '0x313ce567') result = '0x' + '6'.padStart(64, '0');
      else if (data.startsWith('0x70a08231')) result = '0x' + BigInt(amount).toString(16).padStart(64, '0');
      else {
        expect(abi.decodeFunctionData('authorizationState', data)[0].toLowerCase()).toBe(sender);
        result = '0x' + '0'.repeat(64);
      }
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  }) as typeof fetch;
  let current: typeof relayBase | undefined;
  const db = databaseFor(({ sql, params }) => {
    if (sql.includes('FROM auth.user')) return [{ subject: 'owner', user_id: 'owner', auth_email: 'owner@example.invalid', person_email: 'owner@example.invalid',
      email_verified: true, person_id: '1', public_id: '1', blacklisted: false, access_restricted: false, person_status: 'active' }];
    if (sql.includes('FROM identity.wallet_binding')) return [{ address: sender, chain_id: 1, verified_at: created }];
    if (sql.includes('prepare_personal_polygon_usdc_relay')) current = { ...relayBase, token_address: POLYGON_USDC_TOKEN,
      implementation_address: POLYGON_USDC_IMPLEMENTATION, domain_separator: domain, authorization_nonce: String(params[4]),
      authorization_digest: String(params[5]), created_at: new Date(), expires_at: new Date(Number(params[7]) * 1000) };
    if (sql.includes('authorize_personal_polygon_relay')) current = { ...current!, status: 'authorized',
      authorized_at: new Date(), authorization_ciphertext: String(params[3]), authorization_key_id: String(params[4]) } as unknown as typeof relayBase;
    if (sql.includes('begin_personal_polygon_relay')) current = { ...current!, status: 'broadcasting', attempt_id: String(params[2]),
      entry_point_nonce: String(params[3]), lease_token: lease, lease_expires_at: new Date(Date.now() + 90_000), should_prepare: true } as unknown as typeof relayBase;
    if (sql.includes('persist_personal_polygon_relay_operation')) current = { ...current!, user_operation_hash: String(params[4]), operation_ciphertext: String(params[5]),
      operation_key_id: String(params[6]), operation_valid_after: Number(params[7]), operation_valid_until: Number(params[8]), should_send: false } as unknown as typeof relayBase;
    return current ? [current] : [];
  });
  const counter = { quotes: 0, signs: 0 }, validity: number[] = [];
  const createRelayer: typeof createPolygonAaRelayer = async (env, request, signal, now = Date.now(), validBefore) => {
    const fake = await fakeRelayer(counter)(env, request, signal, now, validBefore);
    if (validBefore === undefined) throw Error('missing ERC-3009 expiry');
    const after = Math.floor(now / 1000) - 30, until = validBefore - 1;
    validity.push(until);
    const mock = fake.client.prepareUserOperation;
    fake.client.prepareUserOperation = (async input => {
      const [target, nativeValue, calldata] = safe.decodeFunctionData('executeUserOpWithErrorString', input.callData!);
      expect(target.toLowerCase()).toBe(POLYGON_USDC_TOKEN);
      expect(nativeValue).toBe(0n);
      const transfer = abi.decodeFunctionData('transferWithAuthorization', calldata);
      expect(transfer[0].toLowerCase()).toBe(sender);
      expect(transfer[1].toLowerCase()).toBe(COMPANY_PAYMENT_RECIPIENT);
      expect(transfer[2]).toBe(BigInt(amount));
      expect(transfer[4]).toBe(BigInt(validBefore));
      return mock(input);
    }) as typeof mock;
    fake.account.signUserOperation = async () => {
      counter.signs++;
      return ('0x' + after.toString(16).padStart(12, '0') + until.toString(16).padStart(12, '0') + 'a'.repeat(130)) as `0x${string}`;
    };
    return { ...fake, operationValidAfter: after, operationValidUntil: until };
  };
  const options = { environment, fetchImpl, createRelayer, allowUsdc: true };
  const input = { requestId: id, amountAtomic: amount, asset: 'USDC' };
  await expect(preparePersonalPolygonRelay(db.database, input, 'owner', { ...options, allowUsdc: false })).rejects.toThrow('polygon_relay_unconfigured');
  expect(db.queries).toHaveLength(0);
  const prepared = await preparePersonalPolygonRelay(db.database, input, 'owner', options);
  expect(prepared).toMatchObject({ asset: 'USDC', tokenAddress: POLYGON_USDC_TOKEN, authorizationHasOnchainExpiry: true, status: 'prepared' });
  const expiry = Date.parse(prepared.expiresAt) / 1000;
  const typed = polygonUsdcTypedData(sender, amount, prepared.authorizationNonce, expiry);
  expect(prepared.typedData).toEqual(typed);
  const wrongAmount = await wallet.signTypedData(typed.domain, typed.types, { ...typed.message, value: '1' });
  await expect(authorizePersonalPolygonRelay(db.database, { paymentId: id, signature: wrongAmount }, 'owner', options)).rejects.toThrow('polygon_relay_signature_invalid');
  const wrongRecipient = await wallet.signTypedData(typed.domain, typed.types, { ...typed.message, to: aa });
  await expect(authorizePersonalPolygonRelay(db.database, { paymentId: id, signature: wrongRecipient }, 'owner', options)).rejects.toThrow('polygon_relay_signature_invalid');
  const otherWallet = new Wallet('0x' + '6'.repeat(64));
  const wrongWallet = await otherWallet.signTypedData(typed.domain, typed.types, typed.message);
  await expect(authorizePersonalPolygonRelay(db.database, { paymentId: id, signature: wrongWallet }, 'owner', options)).rejects.toThrow('polygon_relay_signature_invalid');
  const correct = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  const authorized = await authorizePersonalPolygonRelay(db.database, { paymentId: id, signature: correct }, 'owner', options);
  expect(authorized).toMatchObject({ asset: 'USDC', status: 'authorized', expiresAt: prepared.expiresAt, authorizationNonce: prepared.authorizationNonce });
  await expect(readPersonalPolygonRelay(db.database, 'owner', id)).rejects.toThrow('polygon_relay_not_found');
  const result = await submitPersonalPolygonRelay(db.database, { paymentId: id }, 'owner', options);
  expect(result).toMatchObject({ asset: 'USDC', status: 'broadcasting', expiresAt: prepared.expiresAt, authorizationNonce: prepared.authorizationNonce });
  expect(validity).toEqual([expiry - 1, expiry - 1]);
  expect(counter).toEqual({ quotes: 1, signs: 1 });
  expect(methods).not.toContain('eth_sendUserOperation');
});

test('USDC cannot start sponsorship once the Safe window reaches the Circle expiry or has under 30 seconds remaining', async () => {
  const now = Date.now(), seconds = Math.floor(now / 1000);
  await expect(createPolygonAaRelayer(relayEnvironment, noFetch, undefined, now, seconds + 30)).rejects.toThrow('polygon_relay_expired');
  const counter = { quotes: 0, signs: 0 }, fake = await fakeRelayer(counter)(relayEnvironment);
  const input = { paymentId: id, attemptId: attempt, walletAddress: sender, amountAtomic: amount, authorizationNonce: '1',
    signature: 'synthetic-unused', entryPointNonce: '0', maxFeeWei: relayBase.max_fee_wei, usdcValidBefore: seconds + 60 };
  await expect(prepareSignedPolygonRelayOperation({ ...fake, operationValidUntil: seconds + 60 }, input, relayEnvironment)).rejects.toThrow('polygon_relay_expired');
  await expect(prepareSignedPolygonRelayOperation({ ...fake, operationValidUntil: seconds + 29 }, input, relayEnvironment)).rejects.toThrow('polygon_relay_expired');
  expect(counter).toEqual({ quotes: 0, signs: 0 });
});
