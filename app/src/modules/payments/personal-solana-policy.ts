import { PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { decodeBase58, encodeBase58, getBytes, toBeHex, zeroPadValue } from 'ethers';

export const SOLANA_CLUSTER = 'mainnet-beta' as const;
export const SOLANA_CAIP_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as const;
export const SOLANA_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const SOLANA_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const SOLANA_USDT_DECIMALS = 6 as const;
export const SOLANA_COMPANY_RECIPIENT = '8U6UD6UmRkYvpubEUg3GG9LBobH5J2c9871mryh1TA5k';
export const SOLANA_COMPANY_TOKEN_ACCOUNT = 'FJjjX9wMpDtGuymv5WRsDxGay2zjDPECWCiNmyJ2tnMz';
export const SOLANA_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SOLANA_MAX_TRANSACTION_BYTES = 1232;
const U64_MAX = (1n << 64n) - 1n;

/** Public keys are case-sensitive. Never reuse EVM address normalization. */
export function canonicalSolanaAddress(value: unknown, requireSigner = false): string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new Error('invalid_wallet_address');
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error('invalid_wallet_address');
    if (requireSigner) {
      const point = ed25519.Point.fromHex(key.toBytes(), false);
      if (!PublicKey.isOnCurve(key.toBytes()) || point.isSmallOrder() || !point.isTorsionFree()) throw new Error('invalid_wallet_address');
    }
    return value;
  } catch { throw new Error('invalid_wallet_address'); }
}
export function solanaAtomic(value: unknown, allowZero = false): value is string {
  return typeof value === 'string' && (allowZero ? /^(?:0|[1-9][0-9]{0,19})$/ : /^[1-9][0-9]{0,19}$/).test(value) && BigInt(value) <= U64_MAX;
}
export function canonicalBase64Bytes(value: unknown, maximum: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maximum / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('invalid_solana_transaction');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== value) throw new Error('invalid_solana_transaction');
  return bytes;
}
export function canonicalSolanaSignature(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) throw new Error('invalid_solana_signature');
  try {
    const bytes = getBytes(zeroPadValue(toBeHex(decodeBase58(value)), 64));
    if (encodeBase58(bytes) !== value) throw new Error('invalid_solana_signature');
    return value;
  } catch { throw new Error('invalid_solana_signature'); }
}
