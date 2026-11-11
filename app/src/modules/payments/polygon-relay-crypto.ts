import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
type Environment = Record<string, string | undefined>;
function encryptionKey(environment: Environment) {
  const raw = environment.POLYGON_RELAY_ENCRYPTION_KEY;
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw new Error('polygon_relay_unconfigured');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== raw) throw new Error('polygon_relay_unconfigured');
  return bytes;
}
function keyId(environment: Environment) {
  const value = environment.POLYGON_RELAY_ENCRYPTION_KEY_ID ?? 'v1';
  if (!/^[a-z0-9_-]{1,16}$/.test(value)) throw new Error('polygon_relay_unconfigured');
  return value;
}
export function polygonRelayEncryptionReady(environment: Environment) {
  try { encryptionKey(environment); keyId(environment); return true; } catch { return false; }
}
/** Authorization and signed operations are encrypted before durable storage.
 * AAD binds ciphertext to its owner/payment/purpose; no signature is logged.
 */
export function encryptPolygonRelayJson(environment: Environment, context: string, value: unknown) {
  const raw = JSON.stringify(value);
  if (!context || context.length > 512 || typeof raw !== 'string' || raw.length > 32_768) throw new Error('polygon_relay_unavailable');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(environment), nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  return { ciphertext: [keyId(environment), nonce.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.'), keyId: keyId(environment) };
}
export function decryptPolygonRelayJson(environment: Environment, context: string, ciphertext: string): unknown {
  try {
    if (!context || context.length > 512 || typeof ciphertext !== 'string' || ciphertext.length > 45_000) throw new Error();
    const parts = ciphertext.split('.');
    if (parts.length !== 4 || parts[0] !== keyId(environment) || parts.slice(1).some(value => !/^[A-Za-z0-9_-]+$/.test(value))) throw new Error();
    const [nonce, encrypted, tag] = parts.slice(1).map(value => Buffer.from(value!, 'base64url'));
    if (nonce!.length !== 12 || tag!.length !== 16 || parts.slice(1).some((value, index) => Buffer.from(value!, 'base64url').toString('base64url') !== value)) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(environment), nonce!);
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag!);
    return JSON.parse(Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString('utf8'));
  } catch { throw new Error('polygon_relay_authorization_unavailable'); }
}
