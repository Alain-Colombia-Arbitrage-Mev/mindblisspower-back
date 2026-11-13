import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createSandboxWalletChallenge, readSandboxWallet, sandboxWalletCapabilities, sandboxWalletOwnershipMessage,
  verifySandboxWallet, type SandboxWalletDatabase } from './sandbox-wallet';

const signer = new Wallet(`0x${'1'.repeat(64)}`), other = new Wallet(`0x${'2'.repeat(64)}`), address = signer.address.toLowerCase();
const subject = 'synthetic-owner', nativeSessionId = 'synthetic-native-session', principal = { subject, nativeSessionId };
const id = '6d492c47-80be-4e14-bc5f-54afaa56fc23', nonce = 'a'.repeat(64), current = Date.parse('2026-11-13T12:00:00.000Z');
const environment = { WALLET_SANDBOX_REOWN_ENABLED: 'true', MELD_ADMIN_SANDBOX_ENABLED: 'true', MELD_API_SANDBOX: 'synthetic-sandbox-key', MELD_ACCOUNT_ID: 'synthetic-account' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const options = { environment, now: () => current };
function challenge(change = {}) {
  const issuedAt = new Date(current), expiresAt = new Date(current + 300000), sessionContextHash = hash(`${subject}\n${nativeSessionId}`);
  const message = sandboxWalletOwnershipMessage({ address, challengeId: id, nonce, issuedAt, expiresAt, sessionContextHash });
  return { id, address, chain_id: 137, nonce, message, message_hash: hash(message), session_context_hash: sessionContextHash,
    issued_at: issuedAt, expires_at: expiresAt, ...change };
}
const binding = { address, verified: true, binding_reference: id, verified_at: new Date(current), expires_at: new Date(current + 3600000) };
function database(outputs: unknown[][]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  return { queries, database: { execute: async (query: SQL) => { queries.push(new PgDialect().sqlToQuery(query));
    const value = outputs.shift(); if (!value) throw Error('unexpected query'); return value; } } as unknown as SandboxWalletDatabase };
}
test('sandbox capability fails closed before DB with no public key, production onramp or broadcast dependency', async () => {
  expect(sandboxWalletCapabilities(environment)).toMatchObject({ configured: true, canBroadcast: false, serviceProvider: 'TRANSAK', environment: 'sandbox' });
  for (const env of [{}, { ...environment, WALLET_SANDBOX_REOWN_ENABLED: 'false' }, { ...environment, MELD_API_SANDBOX: '' }, { ...environment, MELD_ACCOUNT_ID: '' }]) {
    const db = database([]); expect(sandboxWalletCapabilities(env).configured).toBe(false);
    await expect(readSandboxWallet(db.database, principal, { environment: env })).rejects.toThrow('sandbox_wallet_unconfigured'); expect(db.queries).toHaveLength(0);
  }
});
test('challenge is canonical session-bound EIP191 ownership only and never accepts a browser message or owner', async () => {
  const db = database([[challenge()]]), result = await createSandboxWalletChallenge(db.database, { address: signer.address }, principal,
    { ...options, id: () => id, nonce: () => nonce });
  expect(result).toMatchObject({ challengeId: id, address, chainId: 137, nonce, method: 'personal_sign', message: challenge().message });
  expect(db.queries[0]!.params).toEqual([subject, nativeSessionId, address, id, nonce]);
  expect(result.message).not.toContain(nativeSessionId); expect(result.message).not.toContain(subject);
  for (const raw of [{ address, owner: 'foreign' }, { address, message: 'replace' }, { address: `0x${'0'.repeat(40)}` }, { address, chainId: 1 }]) {
    const denied = database([]); await expect(createSandboxWalletChallenge(denied.database, raw, principal, options)).rejects.toThrow(); expect(denied.queries).toHaveLength(0);
  }
});
test('offline signature binds exact address and native session; refresh projects persisted proof without signatures', async () => {
  const signature = await signer.signMessage(challenge().message), db = database([[challenge()], [binding], [binding]]);
  const result = await verifySandboxWallet(db.database, { challengeId: id, signature }, principal, options);
  expect(result).toMatchObject({ status: 'linked', address, verified: true, canBroadcast: false });
  expect(db.queries[1]!.params).toEqual([subject, nativeSessionId, id, address, hash(challenge().message), hash(signature)]);
  expect(JSON.stringify(db.queries)).not.toContain(signature);
  expect(await readSandboxWallet(db.database, principal, options)).toEqual(result);
});
test('wrong owner, changed native session, expired and mutated messages never consume the challenge', async () => {
  const signature = await signer.signMessage(challenge().message), wrong = await other.signMessage(challenge().message);
  for (const [row, p, signed] of [[challenge(), principal, wrong], [challenge(), { subject, nativeSessionId: 'foreign' }, signature],
    [challenge({ expires_at: new Date(current) }), principal, signature], [challenge({ message: 'untrusted message' }), principal, signature],
    [challenge({ address: other.address.toLowerCase() }), principal, signature]] as const) {
    const db = database([[row]]); await expect(verifySandboxWallet(db.database, { challengeId: id, signature: signed }, p, options)).rejects.toThrow();
    expect(db.queries).toHaveLength(1);
  }
});
test('new login can display existing immutable binding but cannot reuse a prior native-session authorization', async () => {
  const db = database([[{ ...binding, verified: false, expires_at: null }], [{ address: null, verified: false, binding_reference: null, verified_at: null, expires_at: null }]]);
  expect(await readSandboxWallet(db.database, principal, options)).toMatchObject({ status: 'linked', address, verified: false });
  expect(await readSandboxWallet(db.database, principal, options)).toMatchObject({ status: 'unlinked', verified: false });
});
