import { Interface, Signature, TypedDataEncoder, verifyTypedData, toBeHex, zeroPadValue } from 'ethers';
import { checkCompanyPaymentBalance, companyPaymentCalldata, createCompanyPaymentRpc, COMPANY_PAYMENT_RECIPIENT, LEGACY_POLYGON_TOKEN } from './personal-company-rpc';
import { polygonRelayEncryptionReady } from './polygon-relay-crypto';
export const POLYGON_RELAY_ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
export const POLYGON_RELAY_IMPLEMENTATION = '0x90040487a6c9f949c4f07cadcfb0f3b8eeab4229';
export const POLYGON_RELAY_DOMAIN = Object.freeze({ name: 'USDT0', version: '1', verifyingContract: LEGACY_POLYGON_TOKEN, salt: zeroPadValue(toBeHex(137), 32) });
export const POLYGON_RELAY_TYPES = { MetaTransaction: [{ name: 'nonce', type: 'uint256' }, { name: 'from', type: 'address' }, { name: 'functionSignature', type: 'bytes' }] };
export const POLYGON_RELAY_ABI = new Interface(['function getNonce(address) view returns(uint256)', 'function getDomainSeperator() view returns(bytes32)',
  'function implementation() view returns(address)', 'function executeMetaTransaction(address userAddress,bytes functionSignature,bytes32 sigR,bytes32 sigS,uint8 sigV) returns(bytes)']);
const ADDRESS = /^0x[0-9a-f]{40}$/, WORD = /^0x[0-9a-f]{64}$/i;
type Environment = Record<string, string | undefined>;
export function polygonRelayPolicy(environment: Environment) {
  const maximum = environment.PERSONAL_POLYGON_RELAY_MAX_FEE_WEI ?? '1000000000000000000';
  const owner = environment.PERSONAL_POLYGON_RELAY_OWNER_DAILY_BUDGET_WEI ?? '2000000000000000000';
  const global = environment.PERSONAL_POLYGON_RELAY_DAILY_BUDGET_WEI ?? '10000000000000000000';
  if (![maximum, owner, global].every(value => /^[1-9][0-9]{0,19}$/.test(value)) || BigInt(maximum) > 10n ** 18n
    || BigInt(owner) < BigInt(maximum) || BigInt(owner) > 2n * 10n ** 18n
    || BigInt(global) < BigInt(owner) || BigInt(global) > 10n ** 19n) throw new Error('polygon_relay_unconfigured');
  return { maxFeeWei: maximum, ownerDailyCapWei: owner, globalDailyCapWei: global };
}
export function polygonRelayCapabilities(environment: Environment) {
  let transferEnabled = false;
  try {
    polygonRelayPolicy(environment);
    const raw = environment.POLYGON_RELAYER_PRIVATE_KEY || '', key = environment.PIMLICO_API_KEY || '';
    transferEnabled = environment.PERSONAL_POLYGON_RELAY_ENABLED === 'true' && environment.PERSONAL_POLYGON_RELAY_BROADCAST_ENABLED === 'true'
      && /^0x[0-9a-f]{64}$/i.test(raw) && BigInt(raw) > 0n && BigInt(raw) < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
      && /^[a-f0-9]{32}$/i.test(environment.REOWN_PROJECT_ID || '') && key.length >= 16 && key.length <= 512 && /^[\x21-\x7e]+$/.test(key)
      && polygonRelayEncryptionReady(environment);
  } catch { /* never advertise sponsorship from malformed configuration */ }
  return { walletKind: 'personal' as const, executionMode: 'polygon_native_meta_aa' as const, chainId: 137 as const, transferEnabled,
    sponsorship: transferEnabled ? 'mindbliss' as const : 'unavailable' as const, authorizationHasOnchainExpiry: false as const };
}
export function polygonRelayTypedData(sender: string, amountAtomic: string, nonce: string) {
  if (!ADDRESS.test(sender) || !/^(?:0|[1-9][0-9]{0,77})$/.test(nonce) || BigInt(nonce) >= (1n << 256n)) throw new Error('polygon_relay_unavailable');
  return { domain: POLYGON_RELAY_DOMAIN, types: POLYGON_RELAY_TYPES, primaryType: 'MetaTransaction' as const,
    message: { nonce, from: sender, functionSignature: companyPaymentCalldata(amountAtomic) } };
}
export function polygonRelayAuthorizationDigest(sender: string, amountAtomic: string, nonce: string) {
  const typed = polygonRelayTypedData(sender, amountAtomic, nonce);
  return TypedDataEncoder.hash(typed.domain, typed.types, typed.message).toLowerCase();
}
export function verifyPolygonRelayAuthorization(sender: string, amountAtomic: string, nonce: string, rawSignature: string) {
  try {
    if (!/^0x[0-9a-f]{130}$/i.test(rawSignature)) throw new Error();
    const signature = Signature.from(rawSignature), typed = polygonRelayTypedData(sender, amountAtomic, nonce);
    if (verifyTypedData(typed.domain, typed.types, typed.message, signature).toLowerCase() !== sender) throw new Error();
    return { signature: signature.serialized, authorizationDigest: polygonRelayAuthorizationDigest(sender, amountAtomic, nonce),
      calldata: POLYGON_RELAY_ABI.encodeFunctionData('executeMetaTransaction', [sender, typed.message.functionSignature, signature.r, signature.s, signature.v]) };
  } catch { throw new Error('polygon_relay_signature_invalid'); }
}
export async function readPolygonRelayAuthorization(environment: Environment, sender: string, amountAtomic: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
  const rpc = createCompanyPaymentRpc({ ...environment, PERSONAL_COMPANY_PAYMENTS_ENABLED: 'true' }, fetchImpl, signal, 137);
  try {
    await checkCompanyPaymentBalance(rpc, sender, amountAtomic);
    const [nonce, separator, implementation] = await Promise.all(['getNonce', 'getDomainSeperator', 'implementation'].map(name => rpc.call('eth_call',
      [{ to: LEGACY_POLYGON_TOKEN, data: POLYGON_RELAY_ABI.encodeFunctionData(name, name === 'getNonce' ? [sender] : []) }, 'latest'])));
    if (![nonce, separator, implementation].every(value => typeof value === 'string' && WORD.test(value))) throw new Error('polygon_relay_unavailable');
    if (String(POLYGON_RELAY_ABI.decodeFunctionResult('implementation', implementation as string)[0]).toLowerCase() !== POLYGON_RELAY_IMPLEMENTATION
      || separator !== TypedDataEncoder.hashDomain(POLYGON_RELAY_DOMAIN)) throw new Error('polygon_relay_contract_changed');
    const authorizationNonce = BigInt(nonce as string).toString();
    return { authorizationNonce, authorizationDigest: polygonRelayAuthorizationDigest(sender, amountAtomic, authorizationNonce),
      domainSeparator: separator as string, implementationAddress: POLYGON_RELAY_IMPLEMENTATION,
      tokenAddress: LEGACY_POLYGON_TOKEN, recipientAddress: COMPANY_PAYMENT_RECIPIENT, typedData: polygonRelayTypedData(sender, amountAtomic, authorizationNonce) };
  } finally { rpc.dispose(); }
}
