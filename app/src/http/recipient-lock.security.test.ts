import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { Interface, Signature, TypedDataEncoder, Wallet, verifyTypedData } from 'ethers';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import type { Address } from 'viem';
import type { IdentityDatabase } from '../modules/identity/model';
import type { ApiEnvironment } from './types';
import { registerPersonalPolygonRelayRoutes } from './personal-polygon-relay-routes';
import { registerPersonalCompanyPaymentRoutes } from './personal-company-payment-routes';
import { COMPANY_PAYMENT_RECIPIENT, LEGACY_POLYGON_TOKEN } from '../modules/payments/personal-company-rpc';
import { POLYGON_RELAY_DOMAIN, POLYGON_RELAY_ENTRY_POINT, POLYGON_RELAY_IMPLEMENTATION, POLYGON_RELAY_ABI,
  polygonRelayTypedData, polygonRelayAuthorizationDigest } from '../modules/payments/polygon-relay-policy';
import { polygonRelayDispatchCalldata, polygonRelayOperationTag } from '../modules/payments/polygon-relay-operation-tag';
import { validateSavedPolygonRelayOperation } from '../modules/payments/polygon-relay-proof';
import { polygonOperationMaximumCost } from '../modules/payments/polygon-relay-aa';

const paymentId = '11111111-1111-4111-8111-111111111111', attemptId = '22222222-2222-4222-8222-222222222222';
const secret = 'synthetic-recipient-lock-bff-secret'.repeat(2), attacker = `0x${'8'.repeat(40)}`;
const wallet = new Wallet(`0x${'2'.repeat(64)}`), sender = wallet.address.toLowerCase();
const environment = { AUTH_BFF_SHARED_SECRET: secret, PERSONAL_COMPANY_PAYMENTS_ENABLED: 'true', PERSONAL_POLYGON_RELAY_ENABLED: 'true',
  PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED: 'true', REOWN_PROJECT_ID: 'a'.repeat(32), PIMLICO_API_KEY: 'synthetic-provider-key',
  POLYGON_RELAYER_PRIVATE_KEY: `0x${'1'.repeat(64)}`, POLYGON_RELAY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
const created = new Date('2026-11-11T00:00:00Z');
const row = { id: paymentId, subject: 'owner', wallet_address: sender, amount_atomic: '1000000', execution_mode: 'polygon_native_meta_aa', chain_id: 137,
  token_address: LEGACY_POLYGON_TOKEN, token_decimals: 6, recipient_address: COMPANY_PAYMENT_RECIPIENT, authorization_nonce: '0',
  authorization_digest: polygonRelayAuthorizationDigest(sender, '1000000', '0'), domain_separator: TypedDataEncoder.hashDomain(POLYGON_RELAY_DOMAIN),
  implementation_address: POLYGON_RELAY_IMPLEMENTATION, relayer_address: `0x${'4'.repeat(40)}`, entry_point: POLYGON_RELAY_ENTRY_POINT,
  max_fee_wei: '1000000000000000000', owner_daily_cap_wei: '2000000000000000000', global_daily_cap_wei: '10000000000000000000',
  created_at: created, expires_at: new Date(created.getTime() + 300000), authorized_at: null, authorization_ciphertext: null, authorization_key_id: null,
  status: 'prepared', attempt_id: null, user_operation_hash: null, transaction_hash: null, block_number: null, block_hash: null, confirmations: 0,
  confirmed_at: null, failure_reason: null, entry_point_nonce: null, lease_token: null, lease_expires_at: null,
  operation_ciphertext: null, operation_key_id: null, quoted_max_fee_wei: null, operation_valid_after: null, operation_valid_until: null };
function signed(path: string, method = 'POST', raw = '') {
  const timestamp = String(Math.floor(Date.now() / 1000)), ip = '192.0.2.1', cookie = 'better-auth.session_token=synthetic';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  return { method, headers: { cookie, origin: 'https://app.mindblisspower.com', 'content-type': 'application/json',
    'x-vp-auth-client-ip': ip, 'x-vp-auth-timestamp': timestamp,
    'x-vp-auth-signature': createHmac('sha256', secret).update([method, path.split('?')[0], timestamp, ip, hash(cookie), hash(raw)].join('\n')).digest('hex') },
    ...(method === 'POST' ? { body: raw } : {}) };
}
function application(rows: unknown[] = []) {
  let databaseCalls = 0, providerCalls = 0;
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => { context.set('session', { user: { id: 'owner' } } as never); await next(); });
  const database = { execute: async () => { databaseCalls++; return rows; } } as unknown as Pick<IdentityDatabase, 'execute'>;
  const fetchImpl = (async () => { providerCalls++; throw Error('Recipient attack reached external transport'); }) as unknown as typeof fetch;
  registerPersonalPolygonRelayRoutes(app, { database, environment, fetchImpl });
  registerPersonalCompanyPaymentRoutes(app, { database, environment, fetchImpl });
  return { app, calls: () => ({ databaseCalls, providerCalls }) };
}

test('all transfer routes reject injected destinations, calldata, raw operations and prototype keys before any database or provider access', async () => {
  const fixture = application();
  const cases: [string, Record<string, unknown>][] = [
    ['/api/member/polygon-relay/prepare', { requestId: paymentId, amountAtomic: '1000000' }],
    ['/api/member/polygon-relay/authorize', { paymentId, signature: `0x${'2'.repeat(130)}` }],
    ...['submit', 'verify', 'abandon'].map(action => [`/api/member/polygon-relay/${action}`, { paymentId }] as [string, Record<string, unknown>]),
    ['/api/member/company-payments/prepare', { requestId: paymentId, amountAtomic: '1000000', chainId: 137 }],
    ['/api/member/company-payments/submit', { paymentId, transactionHash: `0x${'3'.repeat(64)}` }],
  ];
  for (const [path, body] of cases) for (const key of ['recipient', 'recipientAddress', 'to', 'destination', 'destinationAddress', 'callData', 'calldata', 'functionSignature', 'userOperation', 'transaction', 'typedData', 'constructor', 'prototype', '__proto__']) {
    // String construction retains an OWN __proto__ property; object literals
    // would silently omit it and provide a meaningless pollution test.
    const raw = `${JSON.stringify(body).slice(0, -1)},${JSON.stringify(key)}:${JSON.stringify({ recipientAddress: attacker, polluted: true })}}`;
    const response = await fixture.app.request(path, signed(path, 'POST', raw));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  }
  expect(Object.prototype).not.toHaveProperty('polluted');
  expect(fixture.calls()).toEqual({ databaseCalls: 0, providerCalls: 0 });
});

test('URL query injection cannot override any transfer recipient or choose a raw operation', async () => {
  const fixture = application();
  for (const action of ['prepare', 'authorize', 'submit', 'verify', 'abandon']) {
    const body = action === 'prepare' ? { requestId: paymentId, amountAtomic: '1000000' }
      : action === 'authorize' ? { paymentId, signature: `0x${'2'.repeat(130)}` } : { paymentId };
    for (const query of [`to=${attacker}`, `recipientAddress=${attacker}`, `destination=${attacker}`, 'calldata=0x1234']) {
      const path = `/api/member/polygon-relay/${action}?${query}`;
      expect((await fixture.app.request(path, signed(path, 'POST', JSON.stringify(body)))).status).toBe(400);
    }
  }
  for (const query of [`paymentId=${paymentId}&to=${attacker}`, `paymentId=${paymentId}&recipient=${attacker}`]) {
    const path = `/api/member/polygon-relay/status?${query}`; expect((await fixture.app.request(path, signed(path, 'GET'))).status).toBe(400);
  }
  expect(fixture.calls()).toEqual({ databaseCalls: 0, providerCalls: 0 });
});

test('a cryptographically valid user signature for a different recipient, amount, nonce or EIP712 domain never authorizes the fixed company payment', async () => {
  const typed = polygonRelayTypedData(sender, '1000000', '0'), transfer = new Interface(['function transfer(address,uint256)']);
  const variants = [
    { domain: typed.domain, message: { ...typed.message, functionSignature: transfer.encodeFunctionData('transfer', [attacker, '1000000']) } },
    { domain: typed.domain, message: { ...typed.message, functionSignature: transfer.encodeFunctionData('transfer', [COMPANY_PAYMENT_RECIPIENT, '2000000']) } },
    { domain: typed.domain, message: { ...typed.message, nonce: '1' } },
    { domain: { ...typed.domain, verifyingContract: attacker }, message: typed.message },
    { domain: { ...typed.domain, name: 'OtherToken' }, message: typed.message },
    { domain: { ...typed.domain, salt: `0x${'0'.repeat(63)}1` }, message: typed.message },
  ];
  for (const variant of variants) {
    const signature = await wallet.signTypedData(variant.domain, typed.types, variant.message);
    expect(verifyTypedData(variant.domain, typed.types, variant.message, signature).toLowerCase()).toBe(sender);
    const fixture = application([row]), path = '/api/member/polygon-relay/authorize';
    const response = await fixture.app.request(path, signed(path, 'POST', JSON.stringify({ paymentId, signature })));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'polygon_relay_signature_invalid' });
    expect(fixture.calls()).toEqual({ databaseCalls: 1, providerCalls: 0 });
  }
});

test('even a consistent recomputed UserOp hash cannot bless an injected Safe destination, token recipient, amount or extra operation', async () => {
  const typed = polygonRelayTypedData(sender, '1000000', '0'), signature = await wallet.signTypedData(typed.domain, typed.types, typed.message), sig = Signature.from(signature);
  const safe = new Interface(['function executeUserOpWithErrorString(address,uint256,bytes,uint8)']), transfer = new Interface(['function transfer(address,uint256)']);
  const baseCall = polygonRelayDispatchCalldata(sender, '1000000', '0', signature, paymentId, attemptId);
  const operation = { sender: row.relayer_address, nonce: 0n, callData: baseCall, callGasLimit: 1000n, verificationGasLimit: 1000n, preVerificationGas: 1000n,
    paymasterVerificationGasLimit: 1000n, paymasterPostOpGasLimit: 1000n, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n,
    paymaster: `0x${'5'.repeat(40)}`, paymasterData: '0x1234', signature: `0x${(1000).toString(16).padStart(12, '0')}${(1330).toString(16).padStart(12, '0')}${'a'.repeat(130)}` };
  const tag = polygonRelayOperationTag(paymentId, attemptId).slice(2), originalMeta = safe.decodeFunctionData('executeUserOpWithErrorString', baseCall)[2];
  const evilMeta = (recipient: string, amount: string) => POLYGON_RELAY_ABI.encodeFunctionData('executeMetaTransaction', [sender,
    transfer.encodeFunctionData('transfer', [recipient, amount]), sig.r, sig.s, sig.v]);
  const calls = [baseCall, `${safe.encodeFunctionData('executeUserOpWithErrorString', [attacker, 0n, originalMeta, 0])}${tag}`,
    `${safe.encodeFunctionData('executeUserOpWithErrorString', [LEGACY_POLYGON_TOKEN, 0n, evilMeta(attacker, '1000000'), 0])}${tag}`,
    `${safe.encodeFunctionData('executeUserOpWithErrorString', [LEGACY_POLYGON_TOKEN, 0n, evilMeta(COMPANY_PAYMENT_RECIPIENT, '2000000'), 0])}${tag}`,
    `${safe.encodeFunctionData('executeUserOpWithErrorString', [LEGACY_POLYGON_TOKEN, 1n, originalMeta, 0])}${tag}`,
    `${safe.encodeFunctionData('executeUserOpWithErrorString', [LEGACY_POLYGON_TOKEN, 0n, originalMeta, 1])}${tag}`,
    `${baseCall}00`, `${baseCall.slice(0, -2)}ff`];
  for (const [index, callData] of calls.entries()) {
    const prepared = { ...operation, callData }, userOperationHash = getUserOperationHash({ chainId: 137, entryPointAddress: POLYGON_RELAY_ENTRY_POINT as Address,
      entryPointVersion: '0.7', userOperation: prepared as UserOperation<'0.7'> });
    const rpcOperation = Object.fromEntries(Object.entries(prepared).map(([key, value]) => [key, typeof value === 'bigint' ? `0x${value.toString(16)}` : value]));
    const saved = { userOperationHash, rpcOperation, operationValidAfter: 1000, operationValidUntil: 1330, maxCostWei: polygonOperationMaximumCost(prepared).toString() };
    const context = { paymentId, attemptId, walletAddress: sender, amountAtomic: '1000000', authorizationNonce: '0', relayerAddress: row.relayer_address,
      entryPointNonce: '0', userOperationHash, maxFeeWei: row.max_fee_wei, operationValidAfter: 1000, operationValidUntil: 1330 };
    if (index === 0) expect(validateSavedPolygonRelayOperation(saved, context, signature).userOperationHash).toBe(userOperationHash);
    else expect(() => validateSavedPolygonRelayOperation(saved, context, signature)).toThrow('polygon_relay_proof_unavailable');
  }
});

test('a corrupt persisted recipient fails closed before any provider or relay access', async () => {
  const fixture = application([{ ...row, recipient_address: attacker }]), path = `/api/member/polygon-relay/status?paymentId=${paymentId}`;
  expect((await fixture.app.request(path, signed(path, 'GET'))).status).toBe(503);
  expect(fixture.calls()).toEqual({ databaseCalls: 1, providerCalls: 0 });
});
