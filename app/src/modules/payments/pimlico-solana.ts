import { canonicalBase64Bytes, canonicalSolanaAddress, canonicalSolanaSignature, SOLANA_MAX_TRANSACTION_BYTES, SOLANA_USDT_MINT } from './personal-solana-policy';
import { solanaJsonRequest } from './solana-json-transport';
type Environment = Record<string, string | undefined>;
export function solanaSponsorFeeCap(environment: Environment): bigint {
  const value = environment.PERSONAL_SOLANA_MAX_FEE_LAMPORTS ?? '3000000';
  if (!value || !/^[1-9][0-9]{0,8}$/.test(value) || BigInt(value) > 100_000_000n) throw new Error('solana_payment_unconfigured');
  return BigInt(value);
}
export function solanaSponsorPolicy(environment: Environment) {
  const maxFeeLamports = solanaSponsorFeeCap(environment);
  const owner = environment.PERSONAL_SOLANA_OWNER_DAILY_BUDGET_LAMPORTS ?? '6000000';
  const global = environment.PERSONAL_SOLANA_DAILY_BUDGET_LAMPORTS ?? '30000000';
  if (![owner, global].every(value => /^[1-9][0-9]{0,10}$/.test(value)) || BigInt(owner) < maxFeeLamports
    || BigInt(global) < BigInt(owner) || BigInt(global) > 10_000_000_000n) throw new Error('solana_payment_unconfigured');
  return { maxFeeLamports: String(maxFeeLamports), ownerDailyCapLamports: owner, globalDailyCapLamports: global };
}
export function personalSolanaCapabilities(environment: Environment) {
  let transferEnabled = false;
  try {
    solanaSponsorPolicy(environment);
    const key = environment.PIMLICO_API_KEY;
    transferEnabled = environment.PERSONAL_SOLANA_ENABLED === 'true' && environment.PERSONAL_SOLANA_PREPARE_ENABLED === 'true'
      && environment.PERSONAL_SOLANA_BROADCAST_ENABLED === 'true' && typeof key === 'string' && key.length >= 16 && key.length <= 512 && /^[\x21-\x7e]+$/.test(key)
      && /^[a-f0-9]{32}$/i.test(environment.REOWN_PROJECT_ID || '');
  } catch { /* a malformed policy never advertises a usable transfer */ }
  return { walletKind: 'personal' as const, network: 'solana' as const, cluster: 'mainnet-beta' as const, transferEnabled,
    sponsorship: transferEnabled ? 'mindbliss' as const : 'unavailable' as const };
}
/** Server-only fixed-origin client. The API key is never placed in a URL or DTO. */
export function createPimlicoSolanaClient(environment: Environment, fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
  const secret = environment.PIMLICO_API_KEY;
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 512 || !/^[\x21-\x7e]+$/.test(secret)) throw new Error('solana_payment_provider_unconfigured');
  let sequence = 0;
  async function request(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = ++sequence;
    const data = await solanaJsonRequest('https://solana.pimlico.io/v1/mainnet/rpc', { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) },
      { fetchImpl, signal, headers: { authorization: `Bearer ${secret}` }, unavailable: 'solana_payment_provider_unavailable', maxBytes: 32_768 }) as Record<string, unknown>;
    if (!data || data.jsonrpc !== '2.0' || data.id !== id || !Object.hasOwn(data, 'result') || Object.hasOwn(data, 'error')) throw new Error('solana_payment_provider_unavailable');
    return data.result;
  }
  return {
    async getPayerSigner() {
      const result = await request('getPayerSigner');
      try { return { feePayerAddress: canonicalSolanaAddress(result?.signer_address, true),
        paymentAddress: result?.payment_address ? canonicalSolanaAddress(result.payment_address) : null }; }
      catch { throw new Error('solana_payment_provider_unavailable'); }
    },
    async getSupportedTokens() {
      const result = await request('getSupportedTokens');
      if (!Array.isArray(result?.tokens) || result.tokens.length > 100 || !result.tokens.includes(SOLANA_USDT_MINT)) throw new Error('solana_payment_provider_unavailable');
      return { usdtSupported: true as const };
    },
    async estimateTransactionFee(transactionBase64: string, expectedPayer: string) {
      canonicalBase64Bytes(transactionBase64, SOLANA_MAX_TRANSACTION_BYTES);
      const result = await request('estimateTransactionFee', { transaction: transactionBase64, fee_token: SOLANA_USDT_MINT });
      if (!Number.isSafeInteger(result?.fee_in_lamports) || result.fee_in_lamports < 1 || BigInt(result.fee_in_lamports) > solanaSponsorFeeCap(environment)
        || result?.signer_pubkey !== expectedPayer) throw new Error('solana_payment_fee_unavailable');
      return { feeLamports: String(result.fee_in_lamports), feePayerAddress: expectedPayer };
    },
    /** This method broadcasts even when respond_after='signed'. No automatic retry is performed. */
    async signAndSendTransaction(transactionBase64: string, expectedPayer: string) {
      if (environment.PERSONAL_SOLANA_BROADCAST_ENABLED !== 'true') throw new Error('solana_payment_broadcast_disabled');
      canonicalBase64Bytes(transactionBase64, SOLANA_MAX_TRANSACTION_BYTES);
      const result = await request('signAndSendTransaction', { transaction: transactionBase64, respond_after: 'signed' });
      try {
        if (result?.signer_pubkey !== expectedPayer) throw new Error();
        canonicalBase64Bytes(result.signed_transaction, SOLANA_MAX_TRANSACTION_BYTES);
        return { transactionSignature: canonicalSolanaSignature(result.signature), transactionBase64: result.signed_transaction as string,
          feePayerAddress: canonicalSolanaAddress(result.signer_pubkey, true) };
      } catch { throw new Error('solana_payment_broadcast_ambiguous'); }
    },
  };
}
