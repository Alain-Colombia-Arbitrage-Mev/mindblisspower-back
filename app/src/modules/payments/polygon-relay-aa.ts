import { createPublicClient, http, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { formatUserOperationRequest, getUserOperationHash } from 'viem/account-abstraction';
import { createSmartAccountClient } from 'permissionless';
import { toSafeSmartAccount } from 'permissionless/accounts';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { POLYGON_RELAY_ENTRY_POINT, polygonRelayPolicy } from './polygon-relay-policy';
import { solanaJsonRequest as boundedRpcJson } from './solana-json-transport';
import { polygonRelayDispatchCalldata } from './polygon-relay-operation-tag';
type Environment = Record<string, string | undefined>;
const ORIGIN = 'https://app.mindblisspower.com';
const ENTRY_POINT = { address: POLYGON_RELAY_ENTRY_POINT as Address, version: '0.7' as const };
export type SignedPolygonRelayOperation = { userOperationHash: Hex; rpcOperation: Record<string, unknown>;
  operationValidAfter: number; operationValidUntil: number; maxCostWei: string };

/** No retries: an ambiguous send is recovered by its already persisted UserOp hash. */
export function polygonRelayClients(environment: Environment, fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
  const project = environment.REOWN_PROJECT_ID, key = environment.PIMLICO_API_KEY;
  if (!/^[a-f0-9]{32}$/i.test(project || '') || !key || key.length < 16 || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) throw new Error('polygon_relay_unconfigured');
  const transport = (url: string, secret = false) => http(url, { batch: false, retryCount: 0, timeout: 12_000,
    fetchOptions: { headers: { Origin: ORIGIN, ...(secret ? { Authorization: `Bearer ${key}` } : {}) } },
    fetchFn: async (input, init) => {
      const combined = signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal ?? undefined;
      const result = await boundedRpcJson(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        JSON.parse(String(init?.body)), { fetchImpl, signal: combined, headers: Object.fromEntries(new Headers(init?.headers)),
          unavailable: 'polygon_relay_provider_unavailable', maxBytes: 524_288 });
      return Response.json(result);
    },
  });
  const publicClient = createPublicClient({ chain: polygon, transport: transport(`https://rpc.walletconnect.org/v1?chainId=eip155:137&projectId=${project}`) });
  const pimlicoTransport = transport('https://api.pimlico.io/v2/137/rpc', true);
  const pimlicoClient = createPimlicoClient({ chain: polygon, transport: pimlicoTransport, entryPoint: ENTRY_POINT });
  return { publicClient, pimlicoClient, pimlicoTransport };
}
export async function createPolygonAaRelayer(environment: Environment, fetchImpl: typeof fetch = fetch, signal?: AbortSignal, now = Date.now()) {
  const raw = environment.POLYGON_RELAYER_PRIVATE_KEY;
  if (!/^0x[0-9a-f]{64}$/i.test(raw || '')) throw new Error('polygon_relay_unconfigured');
  try {
    const clients = polygonRelayClients(environment, fetchImpl, signal);
    if (await clients.publicClient.getChainId() !== 137) throw new Error();
    const owner = privateKeyToAccount(raw as Hex);
    const operationValidAfter = Math.max(0, Math.floor(now / 1000) - 30), operationValidUntil = Math.floor(now / 1000) + 300;
    const account = await toSafeSmartAccount({ client: clients.publicClient, owners: [owner], version: '1.4.1', entryPoint: ENTRY_POINT,
      saltNonce: 0n, threshold: 1n, useMultiSendForSetup: true, safeProxyFactoryAddress: '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67',
      safeSingletonAddress: '0x41675c099f32341bf84bfc5382af534df5c7461a',
      safeModuleSetupAddress: '0x2dd68b007b46fbe91b9a7c3eda5a7a1063cb5b47',
      multiSendAddress: '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526', multiSendCallOnlyAddress: '0x9641d764fc13c8b624c04430c7356c1c7c8102e2',
      safe4337ModuleAddress: '0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226', validAfter: operationValidAfter, validUntil: operationValidUntil });
    const client = createSmartAccountClient({ account, chain: polygon, client: clients.publicClient, bundlerTransport: clients.pimlicoTransport,
      paymaster: clients.pimlicoClient, userOperation: { estimateFeesPerGas: async () => (await clients.pimlicoClient.getUserOperationGasPrice()).fast } });
    return { ...clients, account, client, relayerAddress: account.address.toLowerCase(), ownerAddress: owner.address.toLowerCase(), operationValidAfter, operationValidUntil };
  } catch { throw new Error('polygon_relay_unavailable'); }
}
export function polygonOperationMaximumCost(operation: Record<string, unknown>) {
  const quantities = ['callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit'];
  let total = 0n;
  for (const name of quantities) {
    const value = operation[name] ?? 0n;
    if (typeof value !== 'bigint' || value < 0n || value >= (1n << 128n)) throw new Error('polygon_relay_fee_unavailable');
    total += value;
  }
  const price = operation.maxFeePerGas;
  if (typeof price !== 'bigint' || price <= 0n || price >= (1n << 128n) || total <= 0n) throw new Error('polygon_relay_fee_unavailable');
  return total * price;
}
/** May reserve Pimlico sponsorship offchain. Only call AFTER the durable SQL
 * owner/account lease and sponsor budget reservation. Never called on import.
 */
export async function prepareSignedPolygonRelayOperation(relayer: Awaited<ReturnType<typeof createPolygonAaRelayer>>,
  input: { paymentId: string; attemptId: string; walletAddress: string; amountAtomic: string; authorizationNonce: string; signature: string; entryPointNonce: string; maxFeeWei: string },
  environment: Environment): Promise<SignedPolygonRelayOperation> {
  try {
    const expectedCallData = polygonRelayDispatchCalldata(input.walletAddress, input.amountAtomic, input.authorizationNonce, input.signature, input.paymentId, input.attemptId);
    // Include the attempt identifier BEFORE sponsorship, estimation and signing.
    // Never mutate a quote or previously signed operation to create a retry.
    const operation = await relayer.client.prepareUserOperation({ callData: expectedCallData, nonce: BigInt(input.entryPointNonce) });
    const factory = await relayer.account.getFactoryArgs();
    if (operation.sender.toLowerCase() !== relayer.relayerAddress || operation.nonce !== BigInt(input.entryPointNonce)
      || operation.callData !== expectedCallData || !operation.paymaster || !operation.paymasterData || Object.hasOwn(operation, 'authorization')
      || operation.factory?.toLowerCase() !== factory.factory?.toLowerCase() || operation.factoryData !== factory.factoryData) throw new Error();
    const maximum = polygonOperationMaximumCost(operation as unknown as Record<string, unknown>);
    if (typeof operation.maxPriorityFeePerGas !== 'bigint' || operation.maxPriorityFeePerGas < 0n || operation.maxPriorityFeePerGas > operation.maxFeePerGas
      || maximum > BigInt(input.maxFeeWei) || maximum > BigInt(polygonRelayPolicy(environment).maxFeeWei)) throw new Error('polygon_relay_fee_unavailable');
    const signature = await relayer.account.signUserOperation(operation);
    if (!/^0x[0-9a-f]{154}$/i.test(signature) || Number(BigInt(`0x${signature.slice(2, 14)}`)) !== relayer.operationValidAfter
      || Number(BigInt(`0x${signature.slice(14, 26)}`)) !== relayer.operationValidUntil) throw new Error();
    const signed = { ...operation, signature };
    const userOperationHash = getUserOperationHash({ chainId: 137, entryPointAddress: ENTRY_POINT.address, entryPointVersion: '0.7', userOperation: signed });
    return { userOperationHash, rpcOperation: formatUserOperationRequest(signed) as unknown as Record<string, unknown>,
      operationValidAfter: relayer.operationValidAfter, operationValidUntil: relayer.operationValidUntil, maxCostWei: maximum.toString() };
  } catch (error) {
    if (error instanceof Error && error.message === 'polygon_relay_fee_unavailable') throw error;
    throw new Error('polygon_relay_sponsorship_rejected');
  }
}
/** Requires the first durable persist ack (should_send=true). The API owns that
 * fence. No internal retry, regenerated operation or service signing occurs here.
 */
export async function sendPersistedPolygonRelayOperation(environment: Environment, operation: SignedPolygonRelayOperation, fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
  if (environment.PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED !== 'true') throw new Error('polygon_relay_broadcast_disabled');
  try {
    const { pimlicoClient } = polygonRelayClients(environment, fetchImpl, signal);
    const hash: unknown = await pimlicoClient.request({ method: 'eth_sendUserOperation', params: [operation.rpcOperation, ENTRY_POINT.address] } as never);
    if (typeof hash !== 'string' || hash.toLowerCase() !== operation.userOperationHash.toLowerCase()) throw new Error();
    return { userOperationHash: operation.userOperationHash };
  } catch { throw new Error('polygon_relay_broadcast_ambiguous'); }
}
