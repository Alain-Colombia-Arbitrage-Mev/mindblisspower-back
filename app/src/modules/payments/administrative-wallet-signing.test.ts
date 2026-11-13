import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { expect, test } from 'bun:test';
import type { IdentityDatabase } from '../identity/model';
import { administrativeSigningCapabilities, administrativeTransferSnapshot, administrativeWalletOwnershipMessage,
  createAdministrativeSigningChallenge, prepareAdministrativeTransfer, readAdministrativeSigningStatus,
  readAdministrativeTransferHistory, verifyAdministrativeSigningChallenge } from './administrative-wallet-signing';
import { LEGACY_POLYGON_TOKEN } from './personal-company-rpc';

// Public deterministic test keys only. Nothing connects to a chain or sends funds.
const signer = new Wallet(`0x${'1'.repeat(64)}`), other = new Wallet(`0x${'2'.repeat(64)}`);
const address = signer.address.toLowerCase(), recipient = other.address.toLowerCase();
const id = '6d492c47-80be-4e14-bc5f-54afaa56fc23', current = Date.parse('2026-11-13T04:00:00.000Z');
const principal = { subject: 'synthetic-owner', nativeSessionId: 'synthetic-native-session' };
const environment = { ADMINISTRATIVE_WALLET_SIGNING_ENABLED: 'true', MELD_ADMIN_SANDBOX_ENABLED: 'true' };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const nonce = 'a'.repeat(64), issuedAt = new Date(current), expiresAt = new Date(current + 300000);
function challenge(change = {}) {
  const sessionContextHash = sha256(`${principal.subject}\n${principal.nativeSessionId}`);
  const message = administrativeWalletOwnershipMessage({ address, challengeId: id, nonce, issuedAt, expiresAt, sessionContextHash });
  return { id, address, chain_id: 137, nonce, issued_at: issuedAt, expires_at: expiresAt, session_context_hash: sessionContextHash,
    message, message_hash: sha256(message), ...change };
}
function database(outputs: (unknown[] | Error)[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  return { queries, database: { execute: async (query: SQL) => { queries.push(new PgDialect().sqlToQuery(query));
    const value = outputs.shift(); if (value instanceof Error) throw value; if (!value) throw Error('unexpected database call'); return value;
  } } as unknown as Pick<IdentityDatabase, 'execute'> };
}
const options = { environment, now: () => current };
const binding = { wallet_address: address, verified: true, binding_expires_at: new Date(current + 3600000) };
function draftRow(change = {}) {
  const snapshot = administrativeTransferSnapshot(address, recipient, '1');
  return { id, wallet_address: address, recipient_address: recipient, amount_atomic: '1000000', calldata: snapshot.transaction.data,
    preparation_hash: snapshot.preparationHash, created_at: issuedAt, expires_at: new Date(current + 3600000), ...change };
}

test('external signing configuration is independent of Reown/Buy public keys and never enables broadcast', async () => {
  expect(administrativeSigningCapabilities(environment)).toEqual({ flow: 'administrative_signing', configured: true, mode: 'external', environment: 'sandbox',
    chainId: 137, broadcastEnabled: false, canBroadcast: false, canPrepareOfframp: false });
  expect(administrativeSigningCapabilities({ ...environment, ADMINISTRATIVE_WALLET_BROADCAST_ENABLED: 'true' }).canBroadcast).toBe(false);
  expect(administrativeSigningCapabilities({ ...environment, ADMINISTRATIVE_MELD_OFFRAMP_ENABLED: 'true', MELD_API_SANDBOX: 'synthetic-key', MELD_ACCOUNT_ID: 'synthetic-account' }).canPrepareOfframp).toBe(true);
  const db = database([]);
  for (const operation of [() => readAdministrativeSigningStatus(db.database, principal, { environment: {} }),
    () => createAdministrativeSigningChallenge(db.database, {}, principal, { environment: {} }),
    () => verifyAdministrativeSigningChallenge(db.database, { challengeId: id, signature: '0x' + '0'.repeat(130) }, principal, { environment: {} }),
    () => prepareAdministrativeTransfer(db.database, { requestId: id, recipient, amount: '1' }, principal, { environment: {} }),
    () => readAdministrativeTransferHistory(db.database, principal, { environment: {} })]) await expect(operation()).rejects.toThrow('administrative_signing_unconfigured');
  expect(db.queries).toHaveLength(0);
});

test('ownership challenge is backend-generated and pins domain, assigned address, Polygon, nonce, native context and expiry', async () => {
  const db = database([[challenge()]]);
  const value = await createAdministrativeSigningChallenge(db.database, {}, principal, { ...options, id: () => id, nonce: () => nonce });
  expect(value).toEqual({ challengeId: id, address, chainId: 137, message: challenge().message, expiresAt: expiresAt.toISOString(), method: 'personal_sign' });
  expect(db.queries[0]!.params).toEqual([principal.subject, principal.nativeSessionId, id, nonce]);
  expect(value.message).not.toContain(principal.nativeSessionId); expect(value.message).not.toContain(principal.subject);
  for (const raw of [{ address: recipient }, { owner: 'foreign' }, { nativeSessionId: 'foreign' }, { message: 'inject' }]) {
    const denied = database([]); await expect(createAdministrativeSigningChallenge(denied.database, raw, principal, options)).rejects.toThrow(); expect(denied.queries).toHaveLength(0);
  }
});

test('a real offline EIP191 signature consumes exactly the owned challenge and stores only its hash', async () => {
  const row = challenge(), signature = await signer.signMessage(row.message);
  const db = database([[row], [{ verified: true, binding_expires_at: binding.binding_expires_at, address, chain_id: 137 }]]);
  const result = await verifyAdministrativeSigningChallenge(db.database, { challengeId: id, signature }, principal, options);
  expect(result).toMatchObject({ assignedAddress: address, verified: true, expiresAt: binding.binding_expires_at.toISOString(), canBroadcast: false });
  expect(db.queries[1]!.params).toEqual([principal.subject, principal.nativeSessionId, id, address, row.message_hash, sha256(signature)]);
  expect(JSON.stringify(db.queries)).not.toContain(signature);
  expect(JSON.stringify(result)).not.toMatch(/synthetic-native-session|signature|nonce|sessionContextHash/);
});

test('wrong wallet, expired/modified/replayed challenges and crossed native-session proofs cannot establish a binding', async () => {
  const row = challenge(), valid = await signer.signMessage(row.message), wrong = await other.signMessage(row.message);
  const otherWallet = database([[row]]);
  await expect(verifyAdministrativeSigningChallenge(otherWallet.database, { challengeId: id, signature: wrong }, principal, options)).rejects.toThrow('administrative_signing_signature_invalid');
  expect(otherWallet.queries).toHaveLength(1);
  for (const value of [challenge({ expires_at: new Date(current - 1) }), challenge({ message: row.message.replace('137', '1') }),
    challenge({ message_hash: 'b'.repeat(64) }), challenge({ session_context_hash: 'b'.repeat(64) }),
    challenge({ id: '11111111-1111-4111-8111-111111111111' })]) {
    const db = database([[value]]);
    await expect(verifyAdministrativeSigningChallenge(db.database, { challengeId: id, signature: valid }, principal, options)).rejects.toThrow(); expect(db.queries).toHaveLength(1);
  }
  const crossed = database([[row]]);
  await expect(verifyAdministrativeSigningChallenge(crossed.database, { challengeId: id, signature: valid }, { ...principal, nativeSessionId: 'different-session' }, options)).rejects.toThrow('administrative_signing_invalid_challenge');
  const replay = database([[row], new Error('administrative_signing_invalid_challenge')]);
  await expect(verifyAdministrativeSigningChallenge(replay.database, { challengeId: id, signature: valid }, principal, options)).rejects.toThrow('administrative_signing_invalid_challenge');
  expect(replay.queries).toHaveLength(2);
});

test('a USDT draft uses exact integer units, canonical contract/calldata/hash and never calls any network signer', async () => {
  const expected = administrativeTransferSnapshot(address, recipient, '1.000000');
  expect(expected.transaction).toEqual({ chainId: 137, from: address, to: LEGACY_POLYGON_TOKEN, value: '0x0',
    data: '0xa9059cbb' + recipient.slice(2).padStart(64, '0') + 'f4240'.padStart(64, '0') });
  expect(expected.preparationHash).toBe(sha256(JSON.stringify({ version: 1, chainId: 137, from: address, to: LEGACY_POLYGON_TOKEN,
    recipient, amountUnits: '1000000', data: expected.transaction.data, value: '0x0' })));
  const db = database([[binding], [draftRow()]]);
  const result = await prepareAdministrativeTransfer(db.database, { requestId: id, recipient, amount: '1.000000' }, principal, options);
  expect(result).toEqual({ flow: 'administrative_transfer', status: 'draft', mode: 'dry_run', broadcastEnabled: false, canBroadcast: false,
    draftReference: id, source: { address, asset: 'USDT', network: 'polygon', chainId: 137 }, recipient, amount: '1', transaction: expected.transaction,
    preparationHash: expected.preparationHash, createdAt: issuedAt.toISOString(), expiresAt: binding.binding_expires_at.toISOString() });
  expect(db.queries[1]!.params).toEqual([principal.subject, principal.nativeSessionId, id, recipient, '1', expected.transaction.data, expected.preparationHash]);
  expect(JSON.stringify(db.queries)).not.toMatch(/broadcast|commission|balance|wallet_movement|eth_send|meld_checkout/);
});

test('invalid recipients, amounts, client-owned transaction fields and mismatched SQL drafts fail closed', async () => {
  for (const recipientValue of [address, LEGACY_POLYGON_TOKEN, '0x' + '0'.repeat(40), 'https://evil.test']) expect(() => administrativeTransferSnapshot(address, recipientValue, '1')).toThrow('administrative_transfer_invalid_recipient');
  for (const amount of ['0', '-1', '1e6', '1.0000001', '01', ' 1', '1000000000.000001']) expect(() => administrativeTransferSnapshot(address, recipient, amount)).toThrow('administrative_transfer_invalid_amount');
  expect(administrativeTransferSnapshot(address, recipient, '0.000001').amountUnits).toBe('1');
  expect(administrativeTransferSnapshot(address, recipient, '1000000000').amountUnits).toBe('1000000000000000');
  for (const key of ['walletAddress', 'subject', 'nativeSessionId', 'token', 'data', 'chainId', 'preparationHash']) {
    const db = database([]); await expect(prepareAdministrativeTransfer(db.database, { requestId: id, recipient, amount: '1', [key]: 'forged' }, principal, options)).rejects.toThrow(); expect(db.queries).toHaveLength(0);
  }
  const inactive = database([[{ wallet_address: address, verified: false, binding_expires_at: null }]]);
  await expect(prepareAdministrativeTransfer(inactive.database, { requestId: id, recipient, amount: '1' }, principal, options)).rejects.toThrow('administrative_transfer_binding_required');
  expect(inactive.queries).toHaveLength(1);
  for (const change of [{ amount_atomic: '2000000' }, { recipient_address: address }, { preparation_hash: 'b'.repeat(64) }, { calldata: '0xa9059cbb' + '0'.repeat(128) }]) {
    const db = database([[binding], [draftRow(change)]]); await expect(prepareAdministrativeTransfer(db.database, { requestId: id, recipient, amount: '1' }, principal, options)).rejects.toThrow();
  }
});

test('history is owner-scoped and revalidates immutable drafts without pretending they were sent', async () => {
  const db = database([[draftRow()]]);
  const value = await readAdministrativeTransferHistory(db.database, principal, options);
  expect(value.mode).toBe('dry_run'); expect(value.canBroadcast).toBe(false); expect(value.records[0]?.status).toBe('draft');
  expect(db.queries[0]!.params).toEqual([principal.subject, principal.nativeSessionId]);
  const forged = database([[draftRow(), draftRow()]]); await expect(readAdministrativeTransferHistory(forged.database, principal, options)).rejects.toThrow('administrative_transfer_unavailable');
});

test('a stalled or cancelled database lookup is bounded and never proceeds to consume a challenge or prepare a transfer', async () => {
  let pendingReads = 0;
  const pending = { execute: async () => { pendingReads++; return new Promise(() => {}); } } as unknown as Pick<IdentityDatabase, 'execute'>;
  await expect(readAdministrativeSigningStatus(pending, principal, { ...options, timeoutMs: 5 })).rejects.toThrow('administrative_signing_unavailable');
  expect(pendingReads).toBe(1);
  const controller = new AbortController(), row = challenge(), signature = await signer.signMessage(row.message); let reads = 0;
  const cancelled = { execute: async () => { reads++; controller.abort(); return [row]; } } as unknown as Pick<IdentityDatabase, 'execute'>;
  await expect(verifyAdministrativeSigningChallenge(cancelled, { challengeId: id, signature }, principal, { ...options, signal: controller.signal })).rejects.toThrow('administrative_signing_unavailable');
  expect(reads).toBe(1);
  const expired = database([[{ ...binding, binding_expires_at: new Date(current - 1) }]]);
  await expect(prepareAdministrativeTransfer(expired.database, { requestId: id, recipient, amount: '1' }, principal, options)).rejects.toThrow('administrative_signing_unavailable');
  expect(expired.queries).toHaveLength(1);
});
