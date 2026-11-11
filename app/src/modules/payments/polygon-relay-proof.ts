import { Interface } from 'ethers';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import type { Address } from 'viem';
import { z } from 'zod';
import { polygonRelayClients, polygonOperationMaximumCost, type SignedPolygonRelayOperation } from './polygon-relay-aa';
import { POLYGON_RELAY_ABI, POLYGON_RELAY_ENTRY_POINT } from './polygon-relay-policy';
import { createCompanyPaymentRpc, COMPANY_PAYMENT_RECIPIENT, LEGACY_POLYGON_TOKEN, companyPaymentCalldata } from './personal-company-rpc';
import { polygonRelayDispatchCalldata } from './polygon-relay-operation-tag';

const hash = z.string().regex(/^0x[0-9a-f]{64}$/), address = z.string().regex(/^0x[0-9a-f]{40}$/i);
const hex = z.string().regex(/^0x(?:[0-9a-f]{2})*$/i).max(32768), quantity = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/i).max(66);
const operationSchema = z.object({ sender: address, nonce: quantity, callData: hex, callGasLimit: quantity,
  verificationGasLimit: quantity, preVerificationGas: quantity, maxFeePerGas: quantity, maxPriorityFeePerGas: quantity,
  factory: address.optional(), factoryData: hex.optional(), paymaster: address, paymasterData: hex,
  paymasterVerificationGasLimit: quantity, paymasterPostOpGasLimit: quantity, signature: hex }).strict();
export type PolygonRelayProofContext = { paymentId: string; attemptId: string; walletAddress: string; amountAtomic: string; authorizationNonce: string;
  relayerAddress: string; entryPointNonce: string; userOperationHash: string; maxFeeWei: string;
  operationValidAfter: number; operationValidUntil: number };
const entry = new Interface(['event BeforeExecution()',
  'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
  'function getNonce(address sender,uint192 key) view returns(uint256)']);
const token = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)',
  'event MetaTransactionExecuted(address userAddress,address relayerAddress,bytes functionSignature)']);
const indexedMeta = new Interface(['event MetaTransactionExecuted(address indexed userAddress,address indexed relayerAddress,bytes functionSignature)']);
const fail = () => new Error('polygon_relay_proof_unavailable');
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function q(value: unknown) { const parsed = quantity.safeParse(value); if (!parsed.success) throw fail(); return BigInt(parsed.data); }
function equal(value: unknown, expected: string) { return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase(); }

/** A finalized-enough nonce change invalidates dispatch authority; it does not
 * prove whether the immutable transfer was executed elsewhere. */
export async function readCanonicalPolygonNativeNonce(environment: Record<string, string | undefined>, walletAddress: string,
  fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
  const rpc = createCompanyPaymentRpc({ ...environment, PERSONAL_COMPANY_PAYMENTS_ENABLED: 'true' }, fetchImpl, signal, 137);
  try {
    if (q(await rpc.call('eth_chainId', [])) !== 137n) throw fail();
    const head = q(await rpc.call('eth_blockNumber', [])); if (head < 11n) throw fail();
    const at = `0x${(head - 11n).toString(16)}`, block = await rpc.call('eth_getBlockByNumber', [at, false]);
    if (!object(block) || q(block.number) !== head - 11n || !hash.safeParse(block.hash).success) throw fail();
    const nonce = await rpc.call('eth_call', [{ to: LEGACY_POLYGON_TOKEN, data: POLYGON_RELAY_ABI.encodeFunctionData('getNonce', [walletAddress]) }, at]);
    if (!hash.safeParse(nonce).success) throw fail();
    return { observedNativeNonce: BigInt(nonce as string).toString(), blockNumber: (head - 11n).toString(), blockHash: block.hash as string, confirmations: 12 };
  } finally { rpc.dispose(); }
}

/** Validate again after decrypting; persisted bytes may never choose another call,
 * chain, user, amount, token, sponsor recipient or execution entry point. */
export function validateSavedPolygonRelayOperation(raw: unknown, context: PolygonRelayProofContext, authorizationSignature: string): SignedPolygonRelayOperation {
  try {
    const envelope = z.object({ userOperationHash: hash, rpcOperation: operationSchema, operationValidAfter: z.number().int().min(0),
      operationValidUntil: z.number().int().positive(), maxCostWei: z.string().regex(/^[1-9][0-9]*$/) }).strict().parse(raw);
    const rpc = envelope.rpcOperation;
    const expectedCall = polygonRelayDispatchCalldata(context.walletAddress, context.amountAtomic, context.authorizationNonce, authorizationSignature, context.paymentId, context.attemptId);
    if (!equal(rpc.sender, context.relayerAddress) || BigInt(rpc.nonce).toString() !== context.entryPointNonce
      || rpc.callData !== expectedCall || !/^0x[0-9a-f]{154}$/i.test(rpc.signature)
      || Number(BigInt(`0x${rpc.signature.slice(2, 14)}`)) !== context.operationValidAfter
      || Number(BigInt(`0x${rpc.signature.slice(14, 26)}`)) !== context.operationValidUntil
      || envelope.operationValidAfter !== context.operationValidAfter || envelope.operationValidUntil !== context.operationValidUntil
      || envelope.operationValidUntil <= envelope.operationValidAfter || envelope.operationValidUntil - envelope.operationValidAfter > 360
      || Boolean(rpc.factory) !== Boolean(rpc.factoryData) || (rpc.factory && !equal(rpc.factory, '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67'))
      || BigInt(rpc.maxPriorityFeePerGas) > BigInt(rpc.maxFeePerGas)) throw fail();
    const operation = Object.fromEntries(Object.entries(rpc).map(([key, value]) => [key,
      ['nonce', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit'].includes(key) ? BigInt(value) : value]));
    const maximum = polygonOperationMaximumCost(operation);
    const computed = getUserOperationHash({ chainId: 137, entryPointAddress: POLYGON_RELAY_ENTRY_POINT as Address,
      entryPointVersion: '0.7', userOperation: operation as unknown as UserOperation<'0.7'> });
    if (computed !== context.userOperationHash || computed !== envelope.userOperationHash || maximum.toString() !== envelope.maxCostWei
      || maximum > BigInt(context.maxFeeWei)) throw fail();
    return { ...envelope, userOperationHash: computed };
  } catch { throw fail(); }
}

type Canonical = { blockNumber: string; blockHash: string; confirmations: number; actualGasCostWei: string; observedNativeNonce: string; transactionHash: string };
export type PolygonRelayProof = { state: 'pending'; confirmations: number }
  | ({ state: 'confirmed' } & Canonical)
  | ({ state: 'failed'; reason: 'user_operation_reverted' | 'transaction_mismatch' } & Canonical)
  | { state: 'expired'; blockNumber: string; blockHash: string; canonicalTimestamp: string; confirmations: number; observedEntryPointNonce: string; observedNativeNonce: string };

/** Receipt logs are bounded to the target UserOperation execution segment. A
 * matching transfer from a different operation in the same bundle is excluded. */
export function inspectPolygonRelayReceipt(receipt: unknown, context: PolygonRelayProofContext, paymaster: string) {
  if (!object(receipt) || !equal(receipt.to, POLYGON_RELAY_ENTRY_POINT) || q(receipt.status) !== 1n || !Array.isArray(receipt.logs)
    || receipt.logs.length > 2048) throw fail();
  let segment = -1, found = false, outcome: { success: boolean; actualGasCostWei: string; matched: boolean } | null = null;
  for (let index = 0; index < receipt.logs.length; index++) {
    const log: unknown = receipt.logs[index];
    if (!object(log) || !address.safeParse(log.address).success || !Array.isArray(log.topics) || log.topics.some(topic => !hash.safeParse(topic).success)
      || !hex.safeParse(log.data).success || log.removed === true) throw fail();
    if (!equal(log.address, POLYGON_RELAY_ENTRY_POINT)) continue;
    let parsed; try { parsed = entry.parseLog({ topics: log.topics as string[], data: log.data as string }); } catch { continue; }
    if (parsed?.name === 'BeforeExecution') { segment = index; continue; }
    if (parsed?.name !== 'UserOperationEvent') continue;
    if (equal(parsed.args.userOpHash, context.userOperationHash)) {
      if (found || segment < 0 || !equal(parsed.args.sender, context.relayerAddress) || !equal(parsed.args.paymaster, paymaster)
        || parsed.args.nonce.toString() !== context.entryPointNonce || parsed.args.actualGasCost <= 0n
        || parsed.args.actualGasCost > BigInt(context.maxFeeWei)) throw fail();
      found = true;
      let transfers = 0, metas = 0;
      for (const candidate of receipt.logs.slice(segment + 1, index)) {
        if (!object(candidate) || !equal(candidate.address, LEGACY_POLYGON_TOKEN)) continue;
        let event; try { event = (candidate.topics as unknown[]).length === 3 && (candidate.topics as string[])[0] === indexedMeta.getEvent('MetaTransactionExecuted')!.topicHash
          ? indexedMeta.parseLog(candidate as { topics: string[]; data: string }) : token.parseLog(candidate as { topics: string[]; data: string }); } catch { continue; }
        if (event?.name === 'Transfer' && equal(event.args.from, context.walletAddress) && equal(event.args.to, COMPANY_PAYMENT_RECIPIENT)
          && event.args.value.toString() === context.amountAtomic) transfers++;
        if (event?.name === 'MetaTransactionExecuted' && equal(event.args.userAddress, context.walletAddress) && equal(event.args.relayerAddress, context.relayerAddress)
          && event.args.functionSignature === companyPaymentCalldata(context.amountAtomic)) metas++;
      }
      outcome = { success: parsed.args.success, actualGasCostWei: parsed.args.actualGasCost.toString(), matched: transfers === 1 && metas === 1 };
      // A reverted operation must not borrow a transfer even from its own
      // surrounding scope. Such a contradictory receipt is never terminalized.
      if (!outcome.success && transfers > 0) throw fail();
    }
    segment = index;
  }
  if (!found || !outcome) throw fail();
  return outcome;
}

export async function readPolygonRelayProof(environment: Record<string, string | undefined>, context: PolygonRelayProofContext,
  saved: SignedPolygonRelayOperation, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<PolygonRelayProof> {
  const rpc = createCompanyPaymentRpc({ ...environment, PERSONAL_COMPANY_PAYMENTS_ENABLED: 'true' }, fetchImpl, signal, 137);
  try {
    if (q(await rpc.call('eth_chainId', [])) !== 137n) throw fail();
    const { pimlicoClient } = polygonRelayClients(environment, fetchImpl, signal);
    const response: unknown = await pimlicoClient.request({ method: 'eth_getUserOperationReceipt', params: [context.userOperationHash] } as never);
    if (response === null) {
      const head = q(await rpc.call('eth_blockNumber', []));
      if (head < 11n) return { state: 'pending', confirmations: 0 };
      const at = `0x${(head - 11n).toString(16)}`;
      const block = await rpc.call('eth_getBlockByNumber', [at, false]);
      if (!object(block) || q(block.number) !== head - 11n || !hash.safeParse(block.hash).success) throw fail();
      if (q(block.timestamp) <= BigInt(context.operationValidUntil)) return { state: 'pending', confirmations: 0 };
      const [aa, native] = await Promise.all([
        rpc.call('eth_call', [{ to: POLYGON_RELAY_ENTRY_POINT, data: entry.encodeFunctionData('getNonce', [context.relayerAddress, 0]) }, at]),
        rpc.call('eth_call', [{ to: LEGACY_POLYGON_TOKEN, data: POLYGON_RELAY_ABI.encodeFunctionData('getNonce', [context.walletAddress]) }, at]),
      ]);
      if (!hash.safeParse(aa).success || !hash.safeParse(native).success) throw fail();
      if (BigInt(aa as string).toString() !== context.entryPointNonce) return { state: 'pending', confirmations: 0 };
      return { state: 'expired', blockNumber: (head - 11n).toString(), blockHash: block.hash as string, canonicalTimestamp: q(block.timestamp).toString(),
        confirmations: 12, observedEntryPointNonce: BigInt(aa as string).toString(), observedNativeNonce: BigInt(native as string).toString() };
    }
    if (!object(response) || !equal(response.userOpHash, context.userOperationHash) || !object(response.receipt)
      || !hash.safeParse(response.receipt.transactionHash).success) throw fail();
    const transactionHash = response.receipt.transactionHash as string;
    const [receipt, transaction, headRaw] = await Promise.all([rpc.call('eth_getTransactionReceipt', [transactionHash]),
      rpc.call('eth_getTransactionByHash', [transactionHash]), rpc.call('eth_blockNumber', [])]);
    if (receipt === null || transaction === null) return { state: 'pending', confirmations: 0 };
    if (!object(receipt) || !object(transaction) || !equal(transaction.hash, transactionHash) || !equal(receipt.transactionHash, transactionHash)
      || !equal(transaction.to, POLYGON_RELAY_ENTRY_POINT) || q(transaction.chainId) !== 137n || q(transaction.value) !== 0n
      || !hash.safeParse(receipt.blockHash).success || !equal(transaction.blockHash, receipt.blockHash as string)
      || q(transaction.blockNumber) !== q(receipt.blockNumber)) throw fail();
    const number = q(receipt.blockNumber), head = q(headRaw), block = await rpc.call('eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (!object(block) || q(block.number) !== number) throw fail();
    if (!equal(block.hash, receipt.blockHash as string) || head < number) return { state: 'pending', confirmations: 0 };
    const confirmations = Number(head - number + 1n);
    if (!Number.isSafeInteger(confirmations) || confirmations > 1_000_000_000) throw fail();
    if (confirmations < 12) return { state: 'pending', confirmations };
    const outcome = inspectPolygonRelayReceipt(receipt, context, String(saved.rpcOperation.paymaster));
    // A successful UserOp with missing/contradictory token evidence is not a
    // failed payment. Retain the known operation for reconciliation and never
    // open another spend authorization from this uncertain outcome.
    if (outcome.success && !outcome.matched) throw fail();
    const native = await rpc.call('eth_call', [{ to: LEGACY_POLYGON_TOKEN, data: POLYGON_RELAY_ABI.encodeFunctionData('getNonce', [context.walletAddress]) }, receipt.blockNumber]);
    if (!hash.safeParse(native).success) throw fail();
    const canonical = { transactionHash, blockNumber: number.toString(), blockHash: receipt.blockHash as string, confirmations,
      actualGasCostWei: outcome.actualGasCostWei, observedNativeNonce: BigInt(native as string).toString() };
    return outcome.success ? { state: 'confirmed', ...canonical }
      : { state: 'failed', reason: 'user_operation_reverted', ...canonical };
  } finally { rpc.dispose(); }
}
