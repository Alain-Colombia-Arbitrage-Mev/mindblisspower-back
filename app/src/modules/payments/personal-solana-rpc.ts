import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { readSolanaWalletBinding } from '../identity/solana-wallet-link';
import type { IdentityDatabase } from '../identity/model';
import { canonicalSolanaAddress, solanaAtomic, SOLANA_CAIP_NETWORK, SOLANA_CLUSTER, SOLANA_GENESIS_HASH,
  SOLANA_TOKEN_PROGRAM, SOLANA_USDT_DECIMALS, SOLANA_USDT_MINT } from './personal-solana-policy';
import { solanaJsonRequest } from './solana-json-transport';

const METHODS = new Set(['getGenesisHash', 'getAccountInfo', 'getBalance', 'getLatestBlockhash', 'getBlockHeight',
  'isBlockhashValid', 'getTransaction', 'getSignaturesForAddress', 'getSignatureStatuses', 'simulateTransaction']);
type Method = 'getGenesisHash' | 'getAccountInfo' | 'getBalance' | 'getLatestBlockhash' | 'getBlockHeight' | 'isBlockhashValid'
  | 'getTransaction' | 'getSignaturesForAddress' | 'getSignatureStatuses' | 'simulateTransaction';
type Environment = Record<string, string | undefined>;
export function solanaSourceTokenAccount(address: string) {
  return getAssociatedTokenAddressSync(new PublicKey(SOLANA_USDT_MINT), new PublicKey(canonicalSolanaAddress(address)), false).toBase58();
}
export function createSolanaReadRpc(environment: Environment, fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
  const project = environment.REOWN_PROJECT_ID;
  if (environment.PERSONAL_SOLANA_ENABLED !== 'true' || !/^[a-f0-9]{32}$/i.test(project || '')) throw new Error('solana_payment_unconfigured');
  let sequence = 0;
  return { async call(method: Method, params: unknown[] = []): Promise<any> {
    if (!METHODS.has(method)) throw new Error('solana_payment_rpc_unavailable');
    const id = ++sequence;
    const data = await solanaJsonRequest(`https://rpc.walletconnect.org/v1?chainId=${SOLANA_CAIP_NETWORK}&projectId=${project}`,
      { jsonrpc: '2.0', id, method, params }, { fetchImpl, signal, headers: { origin: 'https://app.mindblisspower.com' } }) as Record<string, unknown>;
    if (!data || data.jsonrpc !== '2.0' || data.id !== id || !Object.hasOwn(data, 'result') || Object.hasOwn(data, 'error')) throw new Error('solana_payment_rpc_unavailable');
    return data.result;
  } };
}
type Rpc = ReturnType<typeof createSolanaReadRpc>;
export async function assertSolanaMainnet(rpc: Rpc) {
  if (await rpc.call('getGenesisHash') !== SOLANA_GENESIS_HASH) throw new Error('solana_payment_rpc_unavailable');
}
export async function readSolanaUsdtSnapshot(rpc: Rpc, address: string) {
  const owner = canonicalSolanaAddress(address, true), sourceTokenAccount = solanaSourceTokenAccount(owner);
  await assertSolanaMainnet(rpc);
  const [mint, account, native] = await Promise.all([
    rpc.call('getAccountInfo', [SOLANA_USDT_MINT, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    rpc.call('getAccountInfo', [sourceTokenAccount, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    rpc.call('getBalance', [owner, { commitment: 'confirmed' }]),
  ]);
  if (mint?.value?.owner !== SOLANA_TOKEN_PROGRAM || mint?.value?.data?.parsed?.type !== 'mint'
    || mint.value.data.parsed.info?.decimals !== SOLANA_USDT_DECIMALS || !Number.isSafeInteger(native?.value) || native.value < 0) throw new Error('solana_payment_rpc_unavailable');
  let balanceAtomic = '0';
  if (account?.value !== null) {
    const info = account?.value?.data?.parsed?.info;
    if (account?.value?.owner !== SOLANA_TOKEN_PROGRAM || account.value.data.parsed.type !== 'account'
      || info?.mint !== SOLANA_USDT_MINT || info?.owner !== owner || info?.state !== 'initialized'
      || info?.tokenAmount?.decimals !== SOLANA_USDT_DECIMALS || !solanaAtomic(info?.tokenAmount?.amount, true)) throw new Error('solana_payment_rpc_unavailable');
    balanceAtomic = info.tokenAmount.amount;
  }
  return { walletKind: 'personal' as const, network: 'solana' as const, cluster: SOLANA_CLUSTER, walletAddress: owner,
    mintAddress: SOLANA_USDT_MINT, tokenDecimals: SOLANA_USDT_DECIMALS, sourceTokenAccount, scope: 'associated_token_account' as const,
    balanceAtomic, nativeBalanceAtomic: String(native.value), observedAt: new Date().toISOString() };
}
export async function readPersonalSolanaBalance(database: Pick<IdentityDatabase, 'execute'>, userId: string,
  { environment = process.env, fetchImpl = fetch, signal }: { environment?: Environment; fetchImpl?: typeof fetch; signal?: AbortSignal } = {}) {
  const binding = await readSolanaWalletBinding(database, userId);
  if (!binding.linked) throw new Error('solana_payment_wallet_not_linked');
  return readSolanaUsdtSnapshot(createSolanaReadRpc(environment, fetchImpl, signal), binding.address);
}
