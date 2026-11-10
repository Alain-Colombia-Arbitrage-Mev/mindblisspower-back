import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { principal, principalResult, type IdentityDatabase } from './model';

const CHAIN_ID = 1;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_WINDOW_MS = 10 * 60 * 1000;
const CHALLENGE_LIMIT = 5;

const subjectInput = z.string().min(1).max(255);
const challengeIdInput = z.string().uuid();
const signatureInput = z.string().regex(/^0x[0-9a-f]{130}$/i);

export type WalletLinkClock = { now: () => Date; nonce: () => string; id: () => string };
const defaultClock: WalletLinkClock = {
  now: () => new Date(),
  nonce: () => randomBytes(32).toString('hex'),
  id: () => randomUUID(),
};

export function canonicalWalletAddress(value: string) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value)) throw new Error('invalid_wallet_address');
  return getAddress(value).toLowerCase();
}

export function walletLinkMessage(input: {
  origin: string; address: string; challengeId: string; nonce: string; issuedAt: Date; expiresAt: Date;
}) {
  const origin = new URL(input.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('invalid_wallet_origin');
  }
  const address = getAddress(canonicalWalletAddress(input.address));
  return `${origin.host} wants you to verify ownership of this Ethereum account:\n${address}\n\nVincula esta wallet a tu cuenta Mindbliss. Esta firma no inicia sesión, no realiza transacciones ni mueve fondos.\n\nURI: ${origin.origin}\nVersion: 1\nChain ID: ${CHAIN_ID}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt.toISOString()}\nExpiration Time: ${input.expiresAt.toISOString()}\nRequest ID: ${input.challengeId}`;
}

export function verifyWalletLinkProof(message: string, signature: string, expectedAddress: string) {
  const signatureValue = signatureInput.parse(signature);
  return canonicalWalletAddress(verifyMessage(message, signatureValue)) === canonicalWalletAddress(expectedAddress);
}

async function eligiblePerson(database: Pick<IdentityDatabase, 'execute'>, userId: string) {
  const identity = principalResult(await principal(database, userId));
  if (identity.status !== 'existing' || !identity.personId) throw new Error('wallet_identity_unavailable');
  return identity.personId;
}

export async function readWalletBinding(database: Pick<IdentityDatabase, 'execute'>, input: { userId: string }) {
  const userId = subjectInput.parse(input.userId);
  await eligiblePerson(database, userId);
  const rows = await database.execute<{ address: string; chain_id: number; verified_at: Date }>(sql`
    SELECT address,chain_id,verified_at FROM identity.wallet_binding WHERE subject=${userId}`);
  const binding = rows[0];
  return binding ? { linked: true, address: getAddress(binding.address), chainId: binding.chain_id,
    verifiedAt: new Date(binding.verified_at).toISOString() } : { linked: false };
}

export async function createWalletLinkChallenge(database: IdentityDatabase, input: {
  userId: string; address: string; origin: string;
}, clock: WalletLinkClock = defaultClock) {
  const userId = subjectInput.parse(input.userId);
  const address = canonicalWalletAddress(input.address);
  const issuedAt = clock.now();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const challengeId = challengeIdInput.parse(clock.id());
  const nonce = clock.nonce();
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error('invalid_wallet_nonce');
  const message = walletLinkMessage({ origin: input.origin, address, challengeId, nonce, issuedAt, expiresAt });
  const nonceHash = createHash('sha256').update(nonce, 'utf8').digest('hex');

  return database.transaction(async transaction => {
    await transaction.execute(sql`SELECT id FROM auth.user WHERE id=${userId} FOR UPDATE`);
    const personId = await eligiblePerson(transaction, userId);
    const existing = await transaction.execute<{ address: string }>(sql`
      SELECT address FROM identity.wallet_binding WHERE subject=${userId}`);
    if (existing[0]) {
      if (existing[0].address !== address) throw new Error('wallet_already_linked');
      return { linked: true, address: getAddress(address), chainId: CHAIN_ID };
    }
    // Raw sql parameters have no timestamp column encoder. postgres-js needs
    // ISO strings here; Date objects fail before the challenge can be inserted.
    const recent = await transaction.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM identity.wallet_link_challenge
      WHERE subject=${userId} AND issued_at >= ${new Date(issuedAt.getTime() - CHALLENGE_WINDOW_MS).toISOString()}`);
    if ((recent[0]?.count ?? 0) >= CHALLENGE_LIMIT) throw new Error('wallet_link_rate_limited');
    await transaction.execute(sql`
      UPDATE identity.wallet_link_challenge SET consumed_at=${issuedAt.toISOString()}
      WHERE subject=${userId} AND consumed_at IS NULL`);
    await transaction.execute(sql`
      INSERT INTO identity.wallet_link_challenge
        (id,subject,person_id,chain_id,address,nonce_hash,message,issued_at,expires_at)
      VALUES(${challengeId}::uuid,${userId},${personId}::bigint,${CHAIN_ID},${address},${nonceHash},${message},${issuedAt.toISOString()},${expiresAt.toISOString()})`);
    return { linked: false, challengeId, message, address: getAddress(address), chainId: CHAIN_ID, expiresAt: expiresAt.toISOString() };
  });
}

export async function confirmWalletLink(database: IdentityDatabase, input: {
  userId: string; challengeId: string; signature: string;
}, now = new Date()) {
  const userId = subjectInput.parse(input.userId);
  const challengeId = challengeIdInput.parse(input.challengeId);
  const signature = signatureInput.parse(input.signature);
  const challengeRows = await database.execute<{ address: string; message: string; expires_at: Date; consumed_at: Date | null }>(sql`
    SELECT address,message,expires_at,consumed_at FROM identity.wallet_link_challenge
    WHERE id=${challengeId}::uuid AND subject=${userId}`);
  const preview = challengeRows[0];
  if (!preview || preview.consumed_at || new Date(preview.expires_at) <= now) throw new Error('wallet_challenge_invalid');
  if (!verifyWalletLinkProof(preview.message, signature, preview.address)) throw new Error('wallet_signature_invalid');

  return database.transaction(async transaction => {
    await transaction.execute(sql`SELECT id FROM auth.user WHERE id=${userId} FOR UPDATE`);
    const personId = await eligiblePerson(transaction, userId);
    const rows = await transaction.execute<{ person_id: string; address: string; message: string; expires_at: Date; consumed_at: Date | null }>(sql`
      SELECT person_id::text,address,message,expires_at,consumed_at FROM identity.wallet_link_challenge
      WHERE id=${challengeId}::uuid AND subject=${userId} FOR UPDATE`);
    const challenge = rows[0];
    if (!challenge || challenge.consumed_at || new Date(challenge.expires_at) <= now || challenge.person_id !== personId
      || challenge.message !== preview.message || challenge.address !== preview.address) throw new Error('wallet_challenge_invalid');
    // Serialize claims for the same address without granting UPDATE on the
    // immutable binding table. The unique constraint remains the final guard.
    await transaction.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${'wallet-link:' + challenge.address},0))`);
    const owner = await transaction.execute<{ subject: string; address: string }>(sql`
      SELECT subject,address FROM identity.wallet_binding
      WHERE subject=${userId} OR (chain_id=${CHAIN_ID} AND address=${challenge.address})`);
    const current = owner.find(row => row.subject === userId);
    if (current && current.address !== challenge.address) throw new Error('wallet_already_linked');
    if (owner.some(row => row.subject !== userId)) throw new Error('wallet_address_in_use');
    if (!current) {
      await transaction.execute(sql`
        INSERT INTO identity.wallet_binding(subject,person_id,chain_id,address,verified_at,created_at)
        VALUES(${userId},${personId}::bigint,${CHAIN_ID},${challenge.address},${now.toISOString()},${now.toISOString()})`);
    }
    await transaction.execute(sql`
      UPDATE identity.wallet_link_challenge SET consumed_at=${now.toISOString()}
      WHERE id=${challengeId}::uuid AND consumed_at IS NULL`);
    return { linked: true, address: getAddress(challenge.address), chainId: CHAIN_ID, verifiedAt: now.toISOString() };
  });
}
