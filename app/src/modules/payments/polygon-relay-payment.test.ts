import { expect, test } from 'bun:test';
import { Interface, TypedDataEncoder, Wallet } from 'ethers';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from '../identity/model';
import { COMPANY_PAYMENT_RECIPIENT, LEGACY_POLYGON_TOKEN, companyPaymentCalldata } from './personal-company-rpc';
import { POLYGON_RELAY_DOMAIN, POLYGON_RELAY_ENTRY_POINT, POLYGON_RELAY_IMPLEMENTATION, polygonRelayTypedData,
  polygonRelayAuthorizationDigest, verifyPolygonRelayAuthorization, POLYGON_RELAY_ABI } from './polygon-relay-policy';
import { encryptPolygonRelayJson } from './polygon-relay-crypto';
import { preparePersonalPolygonRelay, submitPersonalPolygonRelay, verifyPersonalPolygonRelay, readPersonalPolygonRelay,
  readPersonalPolygonRelayHistory, abandonPersonalPolygonRelay } from './polygon-relay-payment';
import { inspectPolygonRelayReceipt } from './polygon-relay-proof';
import type { createPolygonAaRelayer } from './polygon-relay-aa';

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
