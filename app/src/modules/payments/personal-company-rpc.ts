/** Fixed personal-wallet payment policy. No browser-supplied RPC, chain or destination. */
export const COMPANY_PAYMENT_CHAIN_ID = 1;
export const COMPANY_PAYMENT_TOKEN = '0xdac17f958d2ee523a2206206994597c13d831ec7';
export const LEGACY_POLYGON_TOKEN = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f';
/** Legacy networks are read/receipt recovery only; every new preparation uses Ethereum. */
export function companyPaymentNetwork(chainId: unknown, tokenAddress: unknown) {
  if (chainId === COMPANY_PAYMENT_CHAIN_ID && tokenAddress === COMPANY_PAYMENT_TOKEN) return Object.freeze({ chainId: 1 as const, tokenAddress: COMPANY_PAYMENT_TOKEN });
  if (chainId === 137 && tokenAddress === LEGACY_POLYGON_TOKEN) return Object.freeze({ chainId: 137 as const, tokenAddress: LEGACY_POLYGON_TOKEN });
  return null;
}
export const COMPANY_PAYMENT_RECIPIENT = '0x0a600b03ef5f8e7f3e182b83440c6d292033db0e';
export const COMPANY_PAYMENT_DECIMALS = 6;
export const COMPANY_PAYMENT_CONFIRMATIONS = 12;
export const COMPANY_PAYMENT_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAX_RESPONSE_BYTES = 262_144;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const WORD = /^0x[0-9a-f]{64}$/i;
const unavailable = () => new Error('company_payment_rpc_unavailable');
type Environment = Record<string, string | undefined>;
type RpcMethod = 'eth_chainId' | 'eth_call' | 'eth_getBalance' | 'eth_getTransactionByHash' | 'eth_getTransactionReceipt' | 'eth_blockNumber' | 'eth_getBlockByNumber';
export function companyPaymentAtomic(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < (1n << 256n);
}
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function hexQuantity(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 66 || !QUANTITY.test(value)) throw unavailable();
  return BigInt(value);
}
function same(value: unknown, expected: string) { return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase(); }
function cancelBody(body: { cancel: () => unknown } | null | undefined) {
  try { void Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* cancellation cannot expose provider details */ }
}
function guarded<T>(operation: () => Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(unavailable()); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw unavailable(); return operation(); }).then(value => {
      if (settled) { late?.(value); return; }
      settled = true; signal.removeEventListener('abort', abort); resolve(value);
    }, () => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(unavailable()); });
  });
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (!response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')
    || (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))) {
    cancelBody(response.body); throw unavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const stop = () => cancelBody(reader);
  signal.addEventListener('abort', stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await guarded(() => reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { stop(); throw unavailable(); }
      chunks.push(part.value);
    }
    if (signal.aborted) throw unavailable();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { signal.removeEventListener('abort', stop); try { reader.releaseLock(); } catch { /* already cancelled */ } }
}
export function createCompanyPaymentRpc(environment: Environment, fetchImpl: typeof fetch = fetch, parent?: AbortSignal, chainId: 1 | 137 = COMPANY_PAYMENT_CHAIN_ID) {
  const policy = companyPaymentNetwork(chainId, chainId === 137 ? LEGACY_POLYGON_TOKEN : COMPANY_PAYMENT_TOKEN);
  if (!policy) throw new Error('company_payment_unconfigured');
  const project = environment.REOWN_PROJECT_ID;
  if (environment.PERSONAL_COMPANY_PAYMENTS_ENABLED !== 'true' || typeof project !== 'string' || !/^[a-f0-9]{32}$/i.test(project)) {
    throw new Error('company_payment_unconfigured');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 12_000);
  let sequence = 0;
  return {
    policy,
    signal: controller.signal,
    async call(method: RpcMethod, params: unknown[]): Promise<unknown> {
      const id = ++sequence;
      try {
        const response = await guarded(() => fetchImpl(`https://rpc.walletconnect.org/v1?chainId=eip155:${policy.chainId}&projectId=${project}`, {
          method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: 'https://app.mindblisspower.com' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        }), controller.signal, value => cancelBody(value.body));
        const body = await json(response, controller.signal);
        if (!object(body) || body.jsonrpc !== '2.0' || body.id !== id || !Object.hasOwn(body, 'result') || Object.hasOwn(body, 'error')
          || controller.signal.aborted) throw unavailable();
        return body.result;
      } catch { if (parent?.aborted) throw new DOMException('Aborted', 'AbortError'); throw unavailable(); }
    },
    dispose() { clearTimeout(timer); parent?.removeEventListener('abort', abort); },
  };
}
type Rpc = ReturnType<typeof createCompanyPaymentRpc>;
export async function checkCompanyPaymentChain(rpc: Rpc) {
  if (hexQuantity(await rpc.call('eth_chainId', [])) !== BigInt(rpc.policy.chainId)) throw unavailable();
}
export async function checkCompanyPaymentBalance(rpc: Rpc, address: string, amountAtomic: string) {
  await checkCompanyPaymentChain(rpc);
  const [decimals, balance] = await Promise.all([
    rpc.call('eth_call', [{ to: rpc.policy.tokenAddress, data: '0x313ce567' }, 'latest']),
    rpc.call('eth_call', [{ to: rpc.policy.tokenAddress, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']),
  ]);
  if (typeof decimals !== 'string' || !WORD.test(decimals) || BigInt(decimals) !== BigInt(COMPANY_PAYMENT_DECIMALS)
    || typeof balance !== 'string' || !WORD.test(balance)) throw unavailable();
  if (BigInt(balance) < BigInt(amountAtomic)) throw new Error('company_payment_insufficient_balance');
}
// Display-only reads may include the legacy Polygon balance. New payments stay Ethereum-only.
export async function readPersonalWalletNetworkBalances(rpc: Rpc, address: string) {
  if (!companyPaymentNetwork(rpc.policy.chainId, rpc.policy.tokenAddress) || !ADDRESS.test(address)) throw unavailable();
  await checkCompanyPaymentChain(rpc);
  const [decimals, balance, nativeBalance] = await Promise.all([
    rpc.call('eth_call', [{ to: rpc.policy.tokenAddress, data: '0x313ce567' }, 'latest']),
    rpc.call('eth_call', [{ to: rpc.policy.tokenAddress, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']),
    rpc.call('eth_getBalance', [address.toLowerCase(), 'latest']),
  ]);
  if (typeof decimals !== 'string' || !WORD.test(decimals) || BigInt(decimals) !== BigInt(COMPANY_PAYMENT_DECIMALS)
    || typeof balance !== 'string' || !WORD.test(balance)) throw unavailable();
  return { balanceAtomic: BigInt(balance).toString(), nativeBalanceAtomic: hexQuantity(nativeBalance).toString() };
}

/** Transfer/MAX balance remains Ethereum-only even when the wallet displays both networks. */
export async function readCompanyPaymentBalances(rpc: Rpc, address: string) {
  if (rpc.policy.chainId !== COMPANY_PAYMENT_CHAIN_ID || rpc.policy.tokenAddress !== COMPANY_PAYMENT_TOKEN) throw unavailable();
  return readPersonalWalletNetworkBalances(rpc, address);
}

export function companyPaymentCalldata(amountAtomic: string) {
  return `0xa9059cbb${COMPANY_PAYMENT_RECIPIENT.slice(2).padStart(64, '0')}${BigInt(amountAtomic).toString(16).padStart(64, '0')}`;
}
function matchingTransaction(rpc: Rpc, value: unknown, hash: string, sender: string, amountAtomic: string) {
  if (!object(value)) throw unavailable();
  for (const field of ['hash', 'from', 'to', 'input', 'value', 'chainId']) if (typeof value[field] !== 'string') throw unavailable();
  if (!HASH.test(value.hash as string) || !ADDRESS.test(value.from as string) || !ADDRESS.test(value.to as string)) throw unavailable();
  const matches = same(value.hash, hash) && same(value.from, sender) && same(value.to, rpc.policy.tokenAddress)
    && same(value.input, companyPaymentCalldata(amountAtomic)) && hexQuantity(value.value) === 0n
    && hexQuantity(value.chainId) === BigInt(rpc.policy.chainId);
  return { matches, transaction: value };
}
/** Prove ownership before claiming a globally unique hash; null is safely retryable. */
export async function checkCompanyPaymentSubmission(rpc: Rpc, hash: string, sender: string, amountAtomic: string) {
  await checkCompanyPaymentChain(rpc);
  const value = await rpc.call('eth_getTransactionByHash', [hash]);
  if (value === null) throw new Error('company_payment_transaction_pending');
  if (!matchingTransaction(rpc, value, hash, sender, amountAtomic).matches) throw new Error('company_payment_transaction_mismatch');
}
export type CompanyPaymentProof = { state: 'pending'; confirmations: number } | { state: 'failed'; reason: 'transaction_reverted' | 'transaction_mismatch' }
  | { state: 'confirmed'; confirmations: number; blockNumber: string; blockHash: string };
export async function verifyCompanyPaymentReceipt(rpc: Rpc, hash: string, sender: string, amountAtomic: string): Promise<CompanyPaymentProof> {
  await checkCompanyPaymentChain(rpc);
  const [transaction, receipt] = await Promise.all([rpc.call('eth_getTransactionByHash', [hash]), rpc.call('eth_getTransactionReceipt', [hash])]);
  if (transaction === null || receipt === null) return { state: 'pending', confirmations: 0 };
  const checked = matchingTransaction(rpc, transaction, hash, sender, amountAtomic);
  if (!object(receipt) || typeof receipt.transactionHash !== 'string' || !HASH.test(receipt.transactionHash)
    || typeof receipt.blockHash !== 'string' || !HASH.test(receipt.blockHash) || !Array.isArray(receipt.logs) || receipt.logs.length > 64
    || !ADDRESS.test(String(receipt.from)) || !ADDRESS.test(String(receipt.to))) throw unavailable();
  const blockNumber = hexQuantity(receipt.blockNumber);
  const status = hexQuantity(receipt.status);
  if (status !== 0n && status !== 1n) throw unavailable();
  if (!same(checked.transaction.blockHash, receipt.blockHash) || hexQuantity(checked.transaction.blockNumber) !== blockNumber) {
    return { state: 'pending', confirmations: 0 };
  }
  const [head, block] = await Promise.all([rpc.call('eth_blockNumber', []), rpc.call('eth_getBlockByNumber', [receipt.blockNumber, false])]);
  const latest = hexQuantity(head);
  if (!object(block) || typeof block.hash !== 'string' || !HASH.test(block.hash) || hexQuantity(block.number) !== blockNumber) throw unavailable();
  // A reorg or a lagging provider is not a terminal payment failure.
  if (!same(block.hash, receipt.blockHash) || latest < blockNumber) return { state: 'pending', confirmations: 0 };
  const count = latest - blockNumber + 1n;
  const confirmations = Number(count > 1_000_000_000n ? 1_000_000_000n : count);
  if (confirmations < COMPANY_PAYMENT_CONFIRMATIONS) return { state: 'pending', confirmations };
  if (!checked.matches || !same(receipt.transactionHash, hash) || !same(receipt.from, sender) || !same(receipt.to, rpc.policy.tokenAddress)) {
    return { state: 'failed', reason: 'transaction_mismatch' };
  }
  if (status === 0n) return { state: 'failed', reason: 'transaction_reverted' };
  const from = `0x${sender.slice(2).toLowerCase().padStart(64, '0')}`;
  const to = `0x${COMPANY_PAYMENT_RECIPIENT.slice(2).padStart(64, '0')}`;
  let matchingLogs = 0;
  for (const value of receipt.logs) {
    if (!object(value) || !ADDRESS.test(String(value.address)) || !Array.isArray(value.topics)) throw unavailable();
    if (value.removed === true) return { state: 'pending', confirmations: 0 };
    if (value.removed !== undefined && typeof value.removed !== 'boolean') throw unavailable();
    if (!same(value.address, rpc.policy.tokenAddress) || !same(value.topics[0], COMPANY_PAYMENT_TRANSFER_TOPIC)) continue;
    if (value.topics.length !== 3 || value.topics.some(topic => typeof topic !== 'string' || !WORD.test(topic))
      || typeof value.data !== 'string' || !WORD.test(value.data)
      || (value.transactionHash !== undefined && !same(value.transactionHash, hash))
      || (value.blockHash !== undefined && !same(value.blockHash, receipt.blockHash))) throw unavailable();
    if (!same(value.topics[1], from) || !same(value.topics[2], to) || BigInt(value.data) !== BigInt(amountAtomic)) {
      return { state: 'failed', reason: 'transaction_mismatch' };
    }
    matchingLogs++;
  }
  if (matchingLogs !== 1) return { state: 'failed', reason: 'transaction_mismatch' };
  return { state: 'confirmed', confirmations, blockNumber: blockNumber.toString(), blockHash: receipt.blockHash.toLowerCase() };
}
