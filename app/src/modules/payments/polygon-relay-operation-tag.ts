import { Interface, keccak256, toUtf8Bytes } from 'ethers';
import { LEGACY_POLYGON_TOKEN } from './personal-company-rpc';
import { verifyPolygonRelayAuthorization } from './polygon-relay-policy';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safe = new Interface(['function executeUserOpWithErrorString(address to,uint256 value,bytes data,uint8 operation)']);
/** ERC4337 hashes exclude signatures (including Safe validity). Distinguish
 * explicit attempts even with identical nonce, gas and paymaster quote. This
 * fixed trailing identifier is the Safe SDK's supported onchainIdentifier
 * mechanism; it never changes the inner token call or user authorization. */
export function polygonRelayOperationTag(paymentId: string, attemptId: string) {
  if (!uuid.test(paymentId) || !uuid.test(attemptId)) throw new Error('polygon_relay_invalid_request');
  return keccak256(toUtf8Bytes(`mindbliss:polygon-relay:137:v1:${paymentId}:${attemptId}`));
}
export function polygonRelayDispatchCalldata(walletAddress: string, amountAtomic: string, authorizationNonce: string,
  signature: string, paymentId: string, attemptId: string) {
  const native = verifyPolygonRelayAuthorization(walletAddress, amountAtomic, authorizationNonce, signature);
  const base = safe.encodeFunctionData('executeUserOpWithErrorString', [LEGACY_POLYGON_TOKEN, 0n, native.calldata, 0]);
  return `${base}${polygonRelayOperationTag(paymentId, attemptId).slice(2)}` as `0x${string}`;
}
