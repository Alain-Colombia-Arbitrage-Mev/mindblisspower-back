import { Interface, Signature, TypedDataEncoder, toBeHex, verifyTypedData } from 'ethers';
import { checkCompanyPaymentBalance, companyPaymentAtomic, COMPANY_PAYMENT_RECIPIENT, createCompanyPaymentRpc, POLYGON_USDC_TOKEN } from './personal-company-rpc';

export const POLYGON_USDC_IMPLEMENTATION = '0x235ae97b28466db30469b89a9fe4cff0659f82cb';
export const POLYGON_USDC_DOMAIN = Object.freeze({ name: 'USD Coin', version: '2', chainId: 137, verifyingContract: POLYGON_USDC_TOKEN });
export const POLYGON_USDC_TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] };
const abi = new Interface([
  'function authorizationState(address authorizer,bytes32 nonce) view returns(bool)',
  'function DOMAIN_SEPARATOR() view returns(bytes32)', 'function implementation() view returns(address)',
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
]);
const word = /^0x[0-9a-f]{64}$/i;
type Environment = Record<string, string | undefined>;
type Rpc = ReturnType<typeof createCompanyPaymentRpc>;

export function usdcAuthorizationNonce(nonce: string) {
  // A UUID-derived nonce is unique per immutable payment and reversible for replay.
  if (!/^[1-9][0-9]{0,38}$/.test(nonce) || BigInt(nonce) >= (1n << 128n)) throw new Error('polygon_relay_unavailable');
  return toBeHex(BigInt(nonce), 32);
}

export function polygonUsdcTypedData(sender: string, amountAtomic: string, nonce: string, validBefore: number) {
  if (!/^0x[0-9a-f]{40}$/.test(sender) || !companyPaymentAtomic(amountAtomic)
    || !Number.isSafeInteger(validBefore) || validBefore <= 0) throw new Error('polygon_relay_unavailable');
  return { domain: POLYGON_USDC_DOMAIN, types: POLYGON_USDC_TYPES, primaryType: 'TransferWithAuthorization' as const,
    message: { from: sender, to: COMPANY_PAYMENT_RECIPIENT, value: amountAtomic, validAfter: '0',
      validBefore: String(validBefore), nonce: usdcAuthorizationNonce(nonce) } };
}

export function verifyPolygonUsdcAuthorization(sender: string, amountAtomic: string, nonce: string, validBefore: number, rawSignature: string) {
  try {
    if (!/^0x[0-9a-f]{130}$/i.test(rawSignature)) throw new Error();
    const signature = Signature.from(rawSignature), typed = polygonUsdcTypedData(sender, amountAtomic, nonce, validBefore);
    if (verifyTypedData(typed.domain, typed.types, typed.message, signature).toLowerCase() !== sender) throw new Error();
    const { from, to, value, validAfter, validBefore: expires, nonce: nonceBytes } = typed.message;
    return { signature: signature.serialized, authorizationDigest: TypedDataEncoder.hash(typed.domain, typed.types, typed.message).toLowerCase(),
      calldata: abi.encodeFunctionData('transferWithAuthorization', [from, to, value, validAfter, expires, nonceBytes, signature.v, signature.r, signature.s]) };
  } catch { throw new Error('polygon_relay_signature_invalid'); }
}

export async function readUsdcAuthorizationUsed(rpc: Rpc, sender: string, nonce: string, block: string) {
  const state = await rpc.call('eth_call', [{ to: POLYGON_USDC_TOKEN, data: abi.encodeFunctionData('authorizationState', [sender, usdcAuthorizationNonce(nonce)]) }, block]);
  if (typeof state !== 'string' || !word.test(state) || BigInt(state) > 1n) throw new Error('polygon_relay_authorization_unavailable');
  return BigInt(state) === 1n;
}

export async function readPolygonUsdcAuthorization(environment: Environment, sender: string, amountAtomic: string,
  authorizationNonce: string, validBefore: number, fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
  if (validBefore <= Math.floor(Date.now() / 1000)) throw new Error('polygon_relay_expired');
  const typedData = polygonUsdcTypedData(sender, amountAtomic, authorizationNonce, validBefore);
  const rpc = createCompanyPaymentRpc({ ...environment, PERSONAL_COMPANY_PAYMENTS_ENABLED: 'true' }, fetchImpl, signal, 137, 'USDC');
  try {
    const [separator, implementation, used] = await Promise.all([
      ...['DOMAIN_SEPARATOR', 'implementation'].map(name => rpc.call('eth_call', [{ to: POLYGON_USDC_TOKEN, data: abi.encodeFunctionData(name) }, 'latest'])),
      readUsdcAuthorizationUsed(rpc, sender, authorizationNonce, 'latest'),
      checkCompanyPaymentBalance(rpc, sender, amountAtomic),
    ]);
    if (typeof separator !== 'string' || separator.toLowerCase() !== TypedDataEncoder.hashDomain(POLYGON_USDC_DOMAIN)
      || typeof implementation !== 'string' || !word.test(implementation)
      || String(abi.decodeFunctionResult('implementation', implementation)[0]).toLowerCase() !== POLYGON_USDC_IMPLEMENTATION)
      throw new Error('polygon_relay_contract_changed');
    if (used) throw new Error('polygon_relay_authorization_nonce_changed');
    return { authorizationNonce, authorizationDigest: TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message).toLowerCase(),
      domainSeparator: separator.toLowerCase(), implementationAddress: POLYGON_USDC_IMPLEMENTATION,
      tokenAddress: POLYGON_USDC_TOKEN, recipientAddress: COMPANY_PAYMENT_RECIPIENT, typedData };
  } finally { rpc.dispose(); }
}
