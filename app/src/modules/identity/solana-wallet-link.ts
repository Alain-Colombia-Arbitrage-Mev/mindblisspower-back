import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { principal, principalResult, type IdentityDatabase } from './model';
import { canonicalBase64Bytes, canonicalSolanaAddress, SOLANA_CLUSTER, SOLANA_GENESIS_HASH } from '../payments/personal-solana-policy';

const subject = z.string().min(1).max(255), uuid = z.string().uuid();
type Clock = { now: () => Date; nonce: () => string; id: () => string };
const clock: Clock = { now: () => new Date(), nonce: () => randomBytes(32).toString('hex'), id: randomUUID };
async function eligible(database: Pick<IdentityDatabase, 'execute'>, owner: string) {
  const person = principalResult(await principal(database, owner));
  if (person.status !== 'existing' || !person.personId) throw new Error('wallet_identity_unavailable');
  return person.personId;
}
export function solanaWalletLinkMessage(input: { origin: string; address: string; challengeId: string; nonce: string; issuedAt: Date; expiresAt: Date }) {
  const origin = new URL(input.origin), address = canonicalSolanaAddress(input.address, true);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('invalid_origin');
  return `${origin.host} wants you to verify ownership of this Solana account:\n${address}\n\nLink this wallet to your Mindbliss account. This signature does not sign in, authorize a transaction, transfer tokens or pay a fee.\n\nURI: ${origin.origin}\nVersion: 1\nNetwork: ${SOLANA_CLUSTER}\nGenesis Hash: ${SOLANA_GENESIS_HASH}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt.toISOString()}\nExpiration Time: ${input.expiresAt.toISOString()}\nRequest ID: ${input.challengeId}`;
}
export function verifySolanaWalletProof(message: string, signature: string, address: string) {
  try {
    const bytes = canonicalBase64Bytes(signature, 64);
    if (bytes.length !== 64 || typeof message !== 'string' || message.length > 2048) return false;
    const key = new PublicKey(canonicalSolanaAddress(address, true));
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key.toBytes())]), type: 'spki', format: 'der' });
    return verify(null, Buffer.from(message, 'utf8'), publicKey, bytes)
      && ed25519.verify(bytes, Buffer.from(message, 'utf8'), key.toBytes(), { zip215: false });
  } catch { return false; }
}
export async function readSolanaWalletBinding(database: Pick<IdentityDatabase, 'execute'>, userId: string) {
  const owner = subject.parse(userId); await eligible(database, owner);
  const rows = await database.execute<{ address: string; cluster: string; genesis_hash: string }>(sql`
    SELECT address,cluster,genesis_hash FROM identity.solana_wallet_binding WHERE subject=${owner}`);
  if (rows.length > 1) throw new Error('solana_wallet_unavailable');
  if (!rows.length) return { linked: false, address: '' };
  const binding = rows[0]!;
  if (binding.cluster !== SOLANA_CLUSTER || binding.genesis_hash !== SOLANA_GENESIS_HASH) throw new Error('solana_wallet_unavailable');
  return { linked: true, address: canonicalSolanaAddress(binding.address, true) };
}
export async function createSolanaWalletLinkChallenge(database: IdentityDatabase, input: { userId: string; address: string; origin: string }, time: Clock = clock) {
  const owner = subject.parse(input.userId), address = canonicalSolanaAddress(input.address, true);
  return database.transaction(async transaction => {
    await transaction.execute(sql`SELECT id FROM auth.user WHERE id=${owner} FOR UPDATE`);
    const personId = await eligible(transaction, owner);
    const existing = await transaction.execute<{ address: string }>(sql`SELECT address FROM identity.solana_wallet_binding WHERE subject=${owner}`);
    if (existing[0]) {
      if (existing[0].address !== address) throw new Error('wallet_already_linked');
      return { linked: true, address };
    }
    const issuedAt = time.now(), expiresAt = new Date(issuedAt.getTime() + 300_000), nonce = time.nonce(), challengeId = uuid.parse(time.id());
    if (!Number.isFinite(issuedAt.getTime()) || !/^[0-9a-f]{64}$/.test(nonce)) throw new Error('solana_wallet_unavailable');
    const message = solanaWalletLinkMessage({ origin: input.origin, address, challengeId, nonce, issuedAt, expiresAt });
    const recent = await transaction.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM identity.solana_wallet_link_challenge
      WHERE subject=${owner} AND issued_at >= ${new Date(issuedAt.getTime() - 600_000).toISOString()}`);
    if ((recent[0]?.count ?? 0) >= 5) throw new Error('wallet_link_rate_limited');
    await transaction.execute(sql`UPDATE identity.solana_wallet_link_challenge SET consumed_at=${issuedAt.toISOString()} WHERE subject=${owner} AND consumed_at IS NULL`);
    const digest = createHash('sha256').update(nonce).digest('hex');
    await transaction.execute(sql`INSERT INTO identity.solana_wallet_link_challenge
      (id,subject,person_id,cluster,genesis_hash,address,nonce_hash,message,issued_at,expires_at)
      VALUES(${challengeId}::uuid,${owner},${personId}::bigint,${SOLANA_CLUSTER},${SOLANA_GENESIS_HASH},${address},${digest},${message},${issuedAt.toISOString()},${expiresAt.toISOString()})`);
    return { linked: false, challengeId, address, message, expiresAt: expiresAt.toISOString() };
  });
}
export async function confirmSolanaWalletLink(database: IdentityDatabase, input: { userId: string; challengeId: string; signature: string }, now = () => new Date()) {
  const owner = subject.parse(input.userId), challengeId = uuid.parse(input.challengeId);
  const previewRows = await database.execute<{ address: string; message: string; expires_at: Date; consumed_at: Date | null }>(sql`
    SELECT address,message,expires_at,consumed_at FROM identity.solana_wallet_link_challenge WHERE id=${challengeId}::uuid AND subject=${owner}`);
  const preview = previewRows[0];
  if (!preview || preview.consumed_at || new Date(preview.expires_at) <= now()) throw new Error('wallet_challenge_invalid');
  if (!verifySolanaWalletProof(preview.message, input.signature, preview.address)) throw new Error('wallet_signature_invalid');
  return database.transaction(async transaction => {
    await transaction.execute(sql`SELECT id FROM auth.user WHERE id=${owner} FOR UPDATE`);
    const personId = await eligible(transaction, owner);
    const rows = await transaction.execute<{ person_id: string; address: string; message: string; cluster: string; genesis_hash: string; expires_at: Date; consumed_at: Date | null }>(sql`
      SELECT person_id::text,address,message,cluster,genesis_hash,expires_at,consumed_at FROM identity.solana_wallet_link_challenge
      WHERE id=${challengeId}::uuid AND subject=${owner} FOR UPDATE`);
    const challenge = rows[0], instant = now();
    if (!challenge || challenge.consumed_at || new Date(challenge.expires_at) <= instant || challenge.person_id !== personId
      || challenge.address !== preview.address || challenge.message !== preview.message || challenge.cluster !== SOLANA_CLUSTER || challenge.genesis_hash !== SOLANA_GENESIS_HASH) throw new Error('wallet_challenge_invalid');
    await transaction.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${'solana-wallet-link:' + challenge.address},0))`);
    const owners = await transaction.execute<{ subject: string; address: string }>(sql`SELECT subject,address FROM identity.solana_wallet_binding WHERE subject=${owner} OR address=${challenge.address}`);
    if (owners.some(value => value.subject !== owner)) throw new Error('wallet_address_in_use');
    if (owners.some(value => value.subject === owner && value.address !== challenge.address)) throw new Error('wallet_already_linked');
    if (!owners.length) await transaction.execute(sql`INSERT INTO identity.solana_wallet_binding(subject,person_id,cluster,genesis_hash,address,verified_at,created_at)
      VALUES(${owner},${personId}::bigint,${SOLANA_CLUSTER},${SOLANA_GENESIS_HASH},${challenge.address},${instant.toISOString()},${instant.toISOString()})`);
    await transaction.execute(sql`UPDATE identity.solana_wallet_link_challenge SET consumed_at=${instant.toISOString()} WHERE id=${challengeId}::uuid AND consumed_at IS NULL`);
    return { linked: true, address: challenge.address };
  });
}
