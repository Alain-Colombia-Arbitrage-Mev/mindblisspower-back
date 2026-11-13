import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from './model';
import { sandboxOperation, sandboxOperationScope } from '../payments/meld-sandbox-http';

export type SandboxWalletDatabase = Pick<IdentityDatabase, 'execute'>;
export type SandboxWalletEnvironment = Record<string, string | undefined>;
export type SandboxWalletPrincipal = { subject: string; nativeSessionId: string };
type Dependencies = { environment?: SandboxWalletEnvironment; signal?: AbortSignal; now?: () => number;
  id?: () => string; nonce?: () => string; timeoutMs?: number };
const identifier = z.string().min(1).max(255), uuid = z.string().uuid(), digest = z.string().regex(/^[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/).refine(value => value !== `0x${'0'.repeat(40)}`);
const signature = z.string().regex(/^0x(?:[0-9a-f]{128}|[0-9a-f]{130})$/i);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function sandboxWalletConfiguration(environment: SandboxWalletEnvironment) {
  const key = environment.MELD_API_SANDBOX, account = environment.MELD_ACCOUNT_ID;
  if (environment.WALLET_SANDBOX_REOWN_ENABLED !== 'true' || environment.MELD_ADMIN_SANDBOX_ENABLED !== 'true'
    || !key || key.length > 2048 || /\s/.test(key) || !account || !/^[A-Za-z0-9_-]{1,128}$/.test(account)) {
    throw Error('sandbox_wallet_unconfigured');
  }
  return { key, account };
}
export function sandboxWalletCapabilities(environment: SandboxWalletEnvironment = process.env) {
  let configured = false; try { sandboxWalletConfiguration(environment); configured = true; } catch { /* No secret metadata. */ }
  return { flow: 'sandbox_wallet' as const, configured, environment: 'sandbox' as const, asset: 'USDT' as const,
    network: 'polygon' as const, chainId: 137 as const, serviceProvider: 'TRANSAK' as const, canBroadcast: false as const };
}
function principal(value: SandboxWalletPrincipal) {
  return { subject: identifier.parse(value.subject), nativeSessionId: identifier.parse(value.nativeSessionId) };
}
export const sandboxWalletBindingRow = z.object({ address: address.nullable(), verified: z.boolean(), binding_reference: uuid.nullable(),
  verified_at: z.coerce.date().nullable(), expires_at: z.coerce.date().nullable() });
function projectBinding(raw: unknown, environment: SandboxWalletEnvironment, now: number) {
  const row = sandboxWalletBindingRow.safeParse(raw);
  if (!row.success || !Number.isFinite(now)) throw Error('sandbox_wallet_unavailable');
  const value = row.data;
  if ((value.address === null) !== (value.binding_reference === null) || value.verified !== (value.expires_at !== null)
    || (value.verified && (!value.address || !value.verified_at || value.expires_at!.getTime() <= now))) throw Error('sandbox_wallet_unavailable');
  return { ...sandboxWalletCapabilities(environment), status: value.address ? 'linked' as const : 'unlinked' as const,
    verified: value.verified, ...(value.address ? { address: value.address } : {}),
    ...(value.verified ? { expiresAt: value.expires_at!.toISOString() } : {}) };
}
function one(rows: unknown[]) { if (rows.length !== 1) throw Error('sandbox_wallet_unavailable'); return rows[0]; }
export async function readSandboxWallet(database: SandboxWalletDatabase, input: SandboxWalletPrincipal,
  { environment = process.env, signal, now = Date.now, timeoutMs }: Dependencies = {}) {
  sandboxWalletConfiguration(environment); const p = principal(input), scope = sandboxOperationScope(signal, timeoutMs);
  try { return projectBinding(one(await sandboxOperation(() => database.execute(sql`SELECT * FROM identity.read_sandbox_wallet_binding(
    ${p.subject},${p.nativeSessionId})`), scope.signal)), environment, now()); } finally { scope.close(); }
}
export function sandboxWalletOwnershipMessage(value: { address: string; challengeId: string; nonce: string; issuedAt: Date;
  expiresAt: Date; sessionContextHash: string }) {
  return `wallet.mindblisspower.com wants you to verify control of this sandbox wallet:\n${value.address}\n\nMindbliss sandbox wallet ownership only. No transaction or transfer of funds.\nSession context: ${value.sessionContextHash}\n\nURI: https://wallet.mindblisspower.com/dashboard/wallet-administrative\nVersion: 1\nChain ID: 137\nNonce: ${value.nonce}\nIssued At: ${value.issuedAt.toISOString()}\nExpiration Time: ${value.expiresAt.toISOString()}\nRequest ID: ${value.challengeId}`;
}
const challengeRow = z.object({ id: uuid, address, chain_id: z.coerce.number().refine(value => value === 137), nonce: digest,
  message: z.string().min(1).max(4096), message_hash: digest, issued_at: z.coerce.date(), expires_at: z.coerce.date(), session_context_hash: digest });
function challenge(raw: unknown, p: SandboxWalletPrincipal, now: number) {
  const parsed = challengeRow.safeParse(raw); if (!parsed.success) throw Error('sandbox_wallet_invalid_challenge');
  const row = parsed.data, sessionContextHash = hash(`${p.subject}\n${p.nativeSessionId}`);
  const message = sandboxWalletOwnershipMessage({ address: row.address, challengeId: row.id, nonce: row.nonce, issuedAt: row.issued_at,
    expiresAt: row.expires_at, sessionContextHash });
  if (!Number.isFinite(now) || row.expires_at.getTime() <= now || row.issued_at.getTime() > now + 30_000
    || row.expires_at.getTime() - row.issued_at.getTime() > 300_000 || row.expires_at <= row.issued_at
    || row.message !== message || row.message_hash !== hash(message) || row.session_context_hash !== sessionContextHash) throw Error('sandbox_wallet_invalid_challenge');
  return row;
}
const gates = new WeakMap<SandboxWalletDatabase, Map<string, { until: number; count: number; active: boolean }>>();
function acquire(database: SandboxWalletDatabase, p: SandboxWalletPrincipal, now: number) {
  let owners = gates.get(database); if (!owners) { owners = new Map(); gates.set(database, owners); }
  for (const [key, entry] of owners) if (!entry.active && entry.until <= now) owners.delete(key);
  const key = `${p.subject}\0${p.nativeSessionId}`; let entry = owners.get(key);
  if (!Number.isFinite(now) || entry?.active || (entry && entry.count >= 20) || (!entry && owners.size >= 10000)) throw Error('sandbox_wallet_rate_limited');
  if (!entry) { entry = { until: now + 600000, count: 0, active: false }; owners.set(key, entry); }
  entry.count++; entry.active = true; return () => { entry.active = false; };
}
export const sandboxWalletChallengeInput = z.object({ address: z.string().regex(/^0x[0-9a-f]{40}$/i).transform(value => getAddress(value).toLowerCase())
  .refine(value => value !== `0x${'0'.repeat(40)}`) }).strict();
export async function createSandboxWalletChallenge(database: SandboxWalletDatabase, raw: unknown, input: SandboxWalletPrincipal,
  { environment = process.env, signal, now = Date.now, id = randomUUID, nonce = () => randomBytes(32).toString('hex'), timeoutMs }: Dependencies = {}) {
  sandboxWalletConfiguration(environment); const value = sandboxWalletChallengeInput.parse(raw), p = principal(input), instant = now();
  const challengeId = uuid.parse(id()).toLowerCase(), nonceValue = digest.parse(nonce()), release = acquire(database, p, instant);
  const scope = sandboxOperationScope(signal, timeoutMs);
  try {
    const row = challenge(one(await sandboxOperation(() => database.execute(sql`SELECT * FROM identity.create_sandbox_wallet_challenge(
      ${p.subject},${p.nativeSessionId},${value.address},${challengeId}::uuid,${nonceValue})`), scope.signal)), p, instant);
    if (row.id !== challengeId || row.nonce !== nonceValue || row.address !== value.address) throw Error('sandbox_wallet_invalid_challenge');
    return { flow: 'sandbox_wallet' as const, challengeId: row.id, address: row.address, chainId: 137 as const, nonce: row.nonce,
      issuedAt: row.issued_at.toISOString(), expiresAt: row.expires_at.toISOString(), sessionContextHash: row.session_context_hash,
      message: row.message, method: 'personal_sign' as const };
  } finally { scope.close(); release(); }
}
export const sandboxWalletVerifyInput = z.object({ challengeId: uuid, signature }).strict();
export async function verifySandboxWallet(database: SandboxWalletDatabase, raw: unknown, input: SandboxWalletPrincipal,
  { environment = process.env, signal, now = Date.now, timeoutMs }: Dependencies = {}) {
  sandboxWalletConfiguration(environment); const value = sandboxWalletVerifyInput.parse(raw), p = principal(input), instant = now();
  const release = acquire(database, p, instant), scope = sandboxOperationScope(signal, timeoutMs);
  try {
    const row = challenge(one(await sandboxOperation(() => database.execute(sql`SELECT * FROM identity.read_sandbox_wallet_challenge(
      ${p.subject},${p.nativeSessionId},${value.challengeId}::uuid)`), scope.signal)), p, instant);
    if (row.id.toLowerCase() !== value.challengeId.toLowerCase()) throw Error('sandbox_wallet_invalid_challenge');
    let recovered: string;
    try { recovered = getAddress(verifyMessage(row.message, value.signature)).toLowerCase(); } catch { throw Error('sandbox_wallet_signature_invalid'); }
    if (recovered !== row.address) throw Error('sandbox_wallet_signature_invalid');
    const result = projectBinding(one(await sandboxOperation(() => database.execute(sql`SELECT * FROM identity.consume_sandbox_wallet_challenge(
      ${p.subject},${p.nativeSessionId},${row.id}::uuid,${recovered},${row.message_hash},${hash(value.signature)})`), scope.signal)), environment, instant);
    if (!result.verified || result.address !== row.address) throw Error('sandbox_wallet_unavailable');
    return result;
  } finally { scope.close(); release(); }
}
