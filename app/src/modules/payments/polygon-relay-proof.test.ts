import { expect, test } from 'bun:test';
import { Interface } from 'ethers';
import { readPolygonRelayProof } from './polygon-relay-proof';
import { POLYGON_RELAY_ENTRY_POINT, POLYGON_RELAY_ABI } from './polygon-relay-policy';
import { COMPANY_PAYMENT_RECIPIENT, LEGACY_POLYGON_TOKEN, companyPaymentCalldata } from './personal-company-rpc';
const environment = { REOWN_PROJECT_ID: 'a'.repeat(32), PIMLICO_API_KEY: 'synthetic-provider-secret' };
const sender = `0x${'2'.repeat(40)}`, aa = `0x${'3'.repeat(40)}`, paymaster = `0x${'4'.repeat(40)}`;
const opHash = `0x${'5'.repeat(64)}`, txHash = `0x${'6'.repeat(64)}`, blockHash = `0x${'7'.repeat(64)}`;
const context = { paymentId: '11111111-1111-4111-8111-111111111111', attemptId: '22222222-2222-4222-8222-222222222222', walletAddress: sender, amountAtomic: '30000000', authorizationNonce: '7', relayerAddress: aa,
  entryPointNonce: '0', userOperationHash: opHash, maxFeeWei: '1000000', operationValidAfter: 1000, operationValidUntil: 1330 };
const saved = { userOperationHash: opHash as `0x${string}`, rpcOperation: { paymaster }, operationValidAfter: 1000, operationValidUntil: 1330, maxCostWei: '1000' };
const ep = new Interface(['event BeforeExecution()', 'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)', 'function getNonce(address,uint192) view returns(uint256)']);
const erc = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)', 'event MetaTransactionExecuted(address userAddress,address relayerAddress,bytes functionSignature)']);
const event = (abi: Interface, name: string, args: unknown[], address = POLYGON_RELAY_ENTRY_POINT) => ({ address, ...abi.encodeEventLog(abi.getEvent(name)!, args), removed: false });
function provider({ receiptMissing = false, success = true, matched = true, nonce = '0', nativeNonce = '7', chain = '0x89', head = '0x6f', timestamp = '0x600', reorg = false, providerError = false } = {}) {
  const seen: string[] = [];
  return { seen, fetch: (async (_url, init) => {
    const request = JSON.parse(String(init?.body)); seen.push(request.method); let result: unknown;
    if (request.method === 'eth_chainId') result = chain;
    else if (request.method === 'eth_getUserOperationReceipt') {
      if (providerError) return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'private upstream data' } });
      result = receiptMissing ? null : { userOpHash: opHash, receipt: { transactionHash: txHash } };
    } else if (request.method === 'eth_blockNumber') result = head;
    else if (request.method === 'eth_getBlockByNumber') result = { hash: reorg ? `0x${'8'.repeat(64)}` : blockHash,
      number: receiptMissing ? `0x${(BigInt(head) - 11n).toString(16)}` : '0x64', timestamp };
    else if (request.method === 'eth_getTransactionByHash') result = { hash: txHash, to: POLYGON_RELAY_ENTRY_POINT, value: '0x0', chainId: chain, blockNumber: '0x64', blockHash };
    else if (request.method === 'eth_getTransactionReceipt') result = { transactionHash: txHash, to: POLYGON_RELAY_ENTRY_POINT, status: '0x1', blockNumber: '0x64', blockHash, logs: [
      event(ep, 'BeforeExecution', []), ...(success && matched ? [event(erc, 'Transfer', [sender, COMPANY_PAYMENT_RECIPIENT, '30000000'], LEGACY_POLYGON_TOKEN),
        event(erc, 'MetaTransactionExecuted', [sender, aa, companyPaymentCalldata('30000000')], LEGACY_POLYGON_TOKEN)] : []),
      event(ep, 'UserOperationEvent', [opHash, aa, paymaster, 0n, success, 1000n, 100n]),
    ] };
    else if (request.method === 'eth_call') {
      const data = request.params[0].data;
      if (data === ep.encodeFunctionData('getNonce', [aa, 0])) result = `0x${BigInt(nonce).toString(16).padStart(64, '0')}`;
      else if (data === POLYGON_RELAY_ABI.encodeFunctionData('getNonce', [sender])) result = `0x${BigInt(nativeNonce).toString(16).padStart(64, '0')}`;
    }
    if (result === undefined) throw Error('unexpected synthetic RPC method');
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  }) as typeof fetch };
}
test('sponsored payment proof needs canonical12 confirmations plus scoped token logs; reorgs, short finality and inconsistent success cannot mutate accounting', async () => {
  const good = provider();
  expect(await readPolygonRelayProof(environment, context, saved, good.fetch)).toMatchObject({ state: 'confirmed', transactionHash: txHash,
    blockNumber: '100', blockHash, confirmations: 12, actualGasCostWei: '1000' });
  expect(await readPolygonRelayProof(environment, context, saved, provider({ head: '0x6e' }).fetch)).toEqual({ state: 'pending', confirmations: 11 });
  expect(await readPolygonRelayProof(environment, context, saved, provider({ reorg: true }).fetch)).toEqual({ state: 'pending', confirmations: 0 });
  await expect(readPolygonRelayProof(environment, context, saved, provider({ success: true, matched: false }).fetch)).rejects.toThrow('polygon_relay_proof_unavailable');
  const wrong = provider({ chain: '0x1' });
  await expect(readPolygonRelayProof(environment, context, saved, wrong.fetch)).rejects.toThrow('polygon_relay_proof_unavailable');
  expect(wrong.seen).toEqual(['eth_chainId']);
});
test('a genuinely reverted UserOp returns canonical evidence and observed native nonce without claiming external nonpayment', async () => {
  const reverted = await readPolygonRelayProof(environment, context, saved, provider({ success: false, nativeNonce: '8' }).fetch);
  expect(reverted).toMatchObject({ state: 'failed', reason: 'user_operation_reverted', observedNativeNonce: '8', confirmations: 12 });
  // SQL uses this unequal nonce as reconciliation_required, never a fresh
  // authorization or a claim that an external payment could not have happened.
});
test('dispatch expiration needs actual absence, Safe validity elapsed and unchanged AA nonce; transport errors never become expiry proofs', async () => {
  expect(await readPolygonRelayProof(environment, context, saved, provider({ receiptMissing: true }).fetch)).toMatchObject({ state: 'expired',
    confirmations: 12, observedEntryPointNonce: '0', observedNativeNonce: '7', canonicalTimestamp: '1536' });
  expect(await readPolygonRelayProof(environment, context, saved, provider({ receiptMissing: true, timestamp: '0x500' }).fetch)).toEqual({ state: 'pending', confirmations: 0 });
  expect(await readPolygonRelayProof(environment, context, saved, provider({ receiptMissing: true, nonce: '1' }).fetch)).toEqual({ state: 'pending', confirmations: 0 });
  await expect(readPolygonRelayProof(environment, context, saved, provider({ receiptMissing: true, providerError: true }).fetch)).rejects.toThrow();
});
