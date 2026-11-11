import { expect, test } from 'bun:test';
import { Wallet, Interface } from 'ethers';
import { encryptPolygonRelayJson, decryptPolygonRelayJson } from './polygon-relay-crypto';
import { polygonRelayAuthorizationDigest, polygonRelayTypedData, verifyPolygonRelayAuthorization, polygonRelayCapabilities } from './polygon-relay-policy';
import { polygonOperationMaximumCost, sendPersistedPolygonRelayOperation, prepareSignedPolygonRelayOperation, type createPolygonAaRelayer } from './polygon-relay-aa';
import { COMPANY_PAYMENT_RECIPIENT, LEGACY_POLYGON_TOKEN } from './personal-company-rpc';
import { polygonRelayDispatchCalldata } from './polygon-relay-operation-tag';
const environment = { POLYGON_RELAY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  POLYGON_RELAYER_PRIVATE_KEY: `0x${'1'.repeat(64)}`, REOWN_PROJECT_ID: 'a'.repeat(32), PIMLICO_API_KEY: 'synthetic-pimlico-secret',
  PERSONAL_POLYGON_RELAY_ENABLED: 'true' };
const wallet = new Wallet(`0x${'2'.repeat(64)}`), sender = wallet.address.toLowerCase();

test('native Polygon authorization binds exact owner, salt-domain, nonce, token transfer recipient and amount', async () => {
  const typed = polygonRelayTypedData(sender, '30000000', '7'), signature = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  const verified = verifyPolygonRelayAuthorization(sender, '30000000', '7', signature);
  expect(verified.authorizationDigest).toBe(polygonRelayAuthorizationDigest(sender, '30000000', '7'));
  const abi = new Interface(['function executeMetaTransaction(address,bytes,bytes32,bytes32,uint8)']);
  const data = abi.decodeFunctionData('executeMetaTransaction', verified.calldata);
  expect(String(data[0]).toLowerCase()).toBe(sender);
  const transfer = new Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', data[1]);
  expect(String(transfer[0]).toLowerCase()).toBe(COMPANY_PAYMENT_RECIPIENT); expect(transfer[1]).toBe(30_000_000n);
  expect(typed.domain).toHaveProperty('salt'); expect(typed.domain).not.toHaveProperty('chainId');
  for (const [address, amount, nonce] of [[sender, '30000001', '7'], [sender, '30000000', '8'], [new Wallet(`0x${'3'.repeat(64)}`).address.toLowerCase(), '30000000', '7']]) {
    expect(() => verifyPolygonRelayAuthorization(address!, amount!, nonce!, signature)).toThrow('polygon_relay_signature_invalid');
  }
});

test('durable relay authorization and signed operations are encrypted and bound to immutable owner/payment/purpose', () => {
  const payload = { signature: `0x${'4'.repeat(130)}`, userOperation: { signature: `0x${'5'.repeat(130)}`, calldata: '0x1234' } };
  const context = 'polygon-relay:owner:11111111-1111-4111-8111-111111111111:authorization';
  const saved = encryptPolygonRelayJson(environment, context, payload);
  expect(saved.keyId).toBe('v1'); expect(saved.ciphertext).not.toContain(payload.signature);
  expect(decryptPolygonRelayJson(environment, context, saved.ciphertext)).toEqual(payload);
  expect(() => decryptPolygonRelayJson(environment, context + ':other-owner', saved.ciphertext)).toThrow('polygon_relay_authorization_unavailable');
  expect(() => decryptPolygonRelayJson({ ...environment, POLYGON_RELAY_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64') }, context, saved.ciphertext)).toThrow('polygon_relay_authorization_unavailable');
  expect(() => decryptPolygonRelayJson(environment, context, saved.ciphertext.slice(0, -4) + 'AAAA')).toThrow('polygon_relay_authorization_unavailable');
});

test('AA sponsor ceiling includes every v0.7 gas component and cannot silently coerce strings, negatives or oversized quantities', () => {
  const operation = { callGasLimit: 100000n, verificationGasLimit: 50000n, preVerificationGas: 20000n,
    paymasterVerificationGasLimit: 10000n, paymasterPostOpGasLimit: 10000n, maxFeePerGas: 100000000000n };
  expect(polygonOperationMaximumCost(operation)).toBe(19_000_000_000_000_000n);
  for (const extra of [{ callGasLimit: -1n }, { maxFeePerGas: 0n }, { paymasterPostOpGasLimit: '1000' }, { verificationGasLimit: 1n << 128n }]) {
    expect(() => polygonOperationMaximumCost({ ...operation, ...extra })).toThrow('polygon_relay_fee_unavailable');
  }
});

test('AA send requires explicit production gate, sends only one persisted operation and never retries ambiguous upstream results', async () => {
  let calls = 0;
  const hash = `0x${'6'.repeat(64)}` as const, saved = { userOperationHash: hash, rpcOperation: { sender: `0x${'7'.repeat(40)}` }, operationValidAfter: 1, operationValidUntil: 2, maxCostWei: '1' };
  const fake = (async (target, init) => { calls++; expect(String(target)).toBe('https://api.pimlico.io/v2/137/rpc');
    expect(new Headers(init?.headers).get('origin')).toBe('https://app.mindblisspower.com');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${environment.PIMLICO_API_KEY}`);
    const body = JSON.parse(String(init?.body)); expect(body.method).toBe('eth_sendUserOperation');
    return Response.json({ jsonrpc: '2.0', id: body.id, result: hash }); }) as typeof fetch;
  expect(polygonRelayCapabilities(environment).transferEnabled).toBe(false);
  await expect(sendPersistedPolygonRelayOperation(environment, saved, fake)).rejects.toThrow('polygon_relay_broadcast_disabled'); expect(calls).toBe(0);
  expect(await sendPersistedPolygonRelayOperation({ ...environment, PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED: 'true' }, saved, fake)).toEqual({ userOperationHash: hash });
  expect(calls).toBe(1);
  calls = 0;
  await expect(sendPersistedPolygonRelayOperation({ ...environment, PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED: 'true' }, saved,
    (async () => { calls++; throw Error('private provider reply'); }) as unknown as typeof fetch)).rejects.toThrow('polygon_relay_broadcast_ambiguous');
  expect(calls).toBe(1);
});

test('service signer refuses provider-modified execution, factory, nonce and excessive sponsorship quotes before signing', async () => {
  const typed = polygonRelayTypedData(sender, '30000000', '7'), signature = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  const native = verifyPolygonRelayAuthorization(sender, '30000000', '7', signature), aa = `0x${'4'.repeat(40)}`;
  const safe = new Interface(['function executeUserOpWithErrorString(address,uint256,bytes,uint8)']);
  const paymentId = '11111111-1111-4111-8111-111111111111', attemptId = '22222222-2222-4222-8222-222222222222';
  const expected = polygonRelayDispatchCalldata(sender, '30000000', '7', signature, paymentId, attemptId);
  const operation = { sender: aa, nonce: 0n, callData: expected, callGasLimit: 1000n, verificationGasLimit: 1000n, preVerificationGas: 1000n,
    paymasterVerificationGasLimit: 1000n, paymasterPostOpGasLimit: 1000n, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n,
    paymaster: `0x${'5'.repeat(40)}`, paymasterData: '0x1234' };
  for (const changed of [{ sender: sender }, { nonce: 1n }, { callData: '0x1234' }, { factory: sender, factoryData: '0x1234' },
    { authorization: {} }, { maxFeePerGas: 10n ** 18n }, { maxPriorityFeePerGas: 1001n }]) {
    let signs = 0;
    const relayer = { relayerAddress: aa, operationValidAfter: 1000, operationValidUntil: 1330,
      account: { encodeCalls: async () => expected, getFactoryArgs: async () => ({}), signUserOperation: async () => { signs++; throw Error('signer must remain untouched'); } },
      client: { prepareUserOperation: async () => ({ ...operation, ...changed }) } } as unknown as Awaited<ReturnType<typeof createPolygonAaRelayer>>;
    await expect(prepareSignedPolygonRelayOperation(relayer, { paymentId, attemptId, walletAddress: sender, amountAtomic: '30000000', authorizationNonce: '7', signature,
      entryPointNonce: '0', maxFeeWei: '1000000000000000000' }, environment)).rejects.toThrow();
    expect(signs).toBe(0);
  }
});

test('identical sponsorship quote and unchanged AA nonce still produce distinct exact-call UserOp hashes on explicit attempts', async () => {
  const typed = polygonRelayTypedData(sender, '30000000', '7'), signature = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  const paymentId = '11111111-1111-4111-8111-111111111111', first = '22222222-2222-4222-8222-222222222222', second = '33333333-3333-4333-8333-333333333333';
  const aa = `0x${'4'.repeat(40)}`;
  const relayer = { relayerAddress: aa, operationValidAfter: 1000, operationValidUntil: 1330,
    account: { getFactoryArgs: async () => ({}), signUserOperation: async () => `0x${(1000).toString(16).padStart(12, '0')}${(1330).toString(16).padStart(12, '0')}${'a'.repeat(130)}` },
    client: { prepareUserOperation: async ({ callData }: { callData: string }) => ({ sender: aa, nonce: 0n, callData,
      callGasLimit: 1000n, verificationGasLimit: 1000n, preVerificationGas: 1000n, paymasterVerificationGasLimit: 1000n, paymasterPostOpGasLimit: 1000n,
      maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, paymaster: `0x${'5'.repeat(40)}`, paymasterData: '0x1234' }) },
  } as unknown as Awaited<ReturnType<typeof createPolygonAaRelayer>>;
  const input = { paymentId, walletAddress: sender, amountAtomic: '30000000', authorizationNonce: '7', signature, entryPointNonce: '0', maxFeeWei: '1000000000000000000' };
  const a = await prepareSignedPolygonRelayOperation(relayer, { ...input, attemptId: first }, environment),
    b = await prepareSignedPolygonRelayOperation(relayer, { ...input, attemptId: second }, environment);
  expect(a.userOperationHash).not.toBe(b.userOperationHash);
  expect(a.rpcOperation.signature).toBe(b.rpcOperation.signature); expect(a.rpcOperation.nonce).toBe(b.rpcOperation.nonce); expect(a.maxCostWei).toBe(b.maxCostWei);
  const safe = new Interface(['function executeUserOpWithErrorString(address,uint256,bytes,uint8)']);
  expect(safe.decodeFunctionData('executeUserOpWithErrorString', a.rpcOperation.callData as string)).toEqual(safe.decodeFunctionData('executeUserOpWithErrorString', b.rpcOperation.callData as string));
  expect((a.rpcOperation.callData as string).slice(0, -64)).toBe((b.rpcOperation.callData as string).slice(0, -64));
});
