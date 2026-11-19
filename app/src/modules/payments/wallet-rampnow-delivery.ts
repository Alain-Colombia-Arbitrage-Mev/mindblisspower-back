import { z } from 'zod';
import { productionOperation, productionScope, readProductionJson } from './wallet-meld-production-http';
import { rampNowAsset, type ProductionAsset } from './wallet-production-coverage';

const networks = {
  USDC_POLYGON: { chainId: '0x89', rpc: 'https://polygon-bor-rpc.publicnode.com', token: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' },
  USDC_ARBITRUM: { chainId: '0xa4b1', rpc: 'https://arb1.arbitrum.io/rpc', token: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
  USDC: { chainId: '0x1', rpc: 'https://ethereum-rpc.publicnode.com', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
} as const;
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const address = z.string().regex(/^0x[0-9a-f]{40}$/i).transform(value => value.toLowerCase());
export const transactionHash = z.string().regex(/^0x[0-9a-f]{64}$/i).transform(value => value.toLowerCase());
const quantity = z.string().regex(/^0x(?:[1-9a-f][0-9a-f]{0,63}|0)$/i);
const log = z.object({ address, topics: z.array(transactionHash).max(4), data: z.string().regex(/^0x[0-9a-f]{64}$/i), removed: z.boolean().optional() });
const receipt = z.object({ transactionHash, blockHash: transactionHash, blockNumber: quantity, status: z.literal('0x1'), logs: z.array(z.unknown()).max(1024) });
const block = z.object({ hash: transactionHash, number: quantity });

/** MELD authenticates the session and supplies the hash. Verify a finalized
 * transfer of native USDC to the bound wallet, even for batched payouts. */
export async function verifyRampNowDelivery(input: { asset: ProductionAsset; address: string; amount: string; hash: string },
  fetchImpl: typeof fetch, signal: AbortSignal): Promise<boolean> {
  const asset = rampNowAsset.safeParse(input.asset);
  if (!asset.success || !/^\d{1,12}(?:\.\d{1,6})?$/.test(input.amount) || !transactionHash.safeParse(input.hash).success
    || !address.safeParse(input.address).success) return false;
  const network = networks[asset.data], scope = productionScope(signal, 7_000);
  let id = 0;
  async function call(method: 'eth_chainId' | 'eth_getTransactionReceipt' | 'eth_getBlockByNumber', params: unknown[]) {
    const requestId = ++id;
    const reply = await productionOperation(() => fetchImpl(network.rpc, { method: 'POST', redirect: 'error', cache: 'no-store',
      credentials: 'omit', signal: scope.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) }), scope.signal,
    late => { void late.body?.cancel().catch(() => {}); });
    if (!reply.ok || reply.redirected) { void reply.body?.cancel().catch(() => {}); return null; }
    const parsed = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(requestId), result: z.unknown(), error: z.never().optional() })
      .safeParse(await readProductionJson(reply, scope.signal));
    return parsed.success ? parsed.data.result : null;
  }
  try {
    const [chain, returnedReceipt, finalizedBlock] = await Promise.all([call('eth_chainId', []),
      call('eth_getTransactionReceipt', [input.hash]), call('eth_getBlockByNumber', ['finalized', false])]);
    const mined = receipt.safeParse(returnedReceipt), finalized = block.safeParse(finalizedBlock);
    if (chain !== network.chainId || !mined.success || !finalized.success || mined.data.transactionHash !== input.hash.toLowerCase()
      || BigInt(mined.data.blockNumber) > BigInt(finalized.data.number)) return false;
    const [whole, fraction = ''] = input.amount.split('.');
    const amountAtomic = BigInt(whole! + fraction.padEnd(6, '0'));
    const recipient = '0x' + input.address.slice(2).toLowerCase().padStart(64, '0');
    if (amountAtomic <= 0n || !mined.data.logs.some(value => {
      const event = log.safeParse(value);
      return event.success && !event.data.removed && event.data.address === network.token && event.data.topics.length === 3
        && event.data.topics[0] === transfer && event.data.topics[2] === recipient && BigInt(event.data.data) === amountAtomic;
    })) return false;
    const canonical = block.safeParse(await call('eth_getBlockByNumber', [mined.data.blockNumber, false]));
    return canonical.success && canonical.data.hash === mined.data.blockHash
      && BigInt(canonical.data.number) === BigInt(mined.data.blockNumber);
  } catch {
    return false;
  } finally {
    scope.close();
  }
}
