import { describe, expect, test } from 'bun:test';
import { Wallet } from 'ethers';
import { canonicalWalletAddress, confirmWalletLink, verifyWalletLinkProof, walletLinkMessage } from './wallet-link';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { IdentityDatabase } from './model';

const challenge = {
  origin: 'https://app.mindblisspower.com',
  challengeId: 'd8a4c010-cc33-44da-a297-8b3c6440f491',
  nonce: 'a'.repeat(64),
  issuedAt: new Date('2026-11-09T12:00:00.000Z'),
  expiresAt: new Date('2026-11-09T12:05:00.000Z'),
};

describe('wallet link proof', () => {
  test('accepts only canonical EVM addresses and a signature from that address', async () => {
    const wallet = Wallet.createRandom();
    const message = walletLinkMessage({ ...challenge, address: wallet.address });
    const signature = await wallet.signMessage(message);
    expect(verifyWalletLinkProof(message, signature, wallet.address)).toBe(true);
    expect(verifyWalletLinkProof(message, signature, Wallet.createRandom().address)).toBe(false);
    expect(canonicalWalletAddress(wallet.address)).toBe(wallet.address.toLowerCase());
  });

  test('message binds domain, address, chain, expiry and request id without transaction authority', () => {
    const address = '0x0000000000000000000000000000000000000001';
    const message = walletLinkMessage({ ...challenge, address });
    for (const fragment of ['app.mindblisspower.com wants you to verify ownership', address, 'Chain ID: 1',
      `Nonce: ${challenge.nonce}`, `Request ID: ${challenge.challengeId}`, 'no inicia sesión', 'no realiza transacciones ni mueve fondos']) {
      expect(message).toContain(fragment);
    }
  });

  test('rejects malformed addresses and non-production origins', () => {
    expect(() => canonicalWalletAddress('0x1234')).toThrow('invalid_wallet_address');
    expect(() => walletLinkMessage({ ...challenge, origin: 'http://app.mindblisspower.com', address: '0x0000000000000000000000000000000000000001' }))
      .toThrow('invalid_wallet_origin');
  });
});

test('wallet confirmation rejects another subject, expired or consumed proofs before any transaction', async () => {
  const wallet = Wallet.createRandom();
  const message = walletLinkMessage({ ...challenge, address: wallet.address });
  const signature = await wallet.signMessage(message);
  const now = new Date('2026-11-09T12:01:00Z');
  const preview = { address: wallet.address.toLowerCase(), message, expires_at: challenge.expiresAt, consumed_at: null };
  for (const rows of [[], [{ ...preview, consumed_at: now }], [{ ...preview, expires_at: new Date('2026-11-09T12:00:00Z') }]]) {
    let calls = 0;
    const database = { execute: async (query: SQL) => {
      calls++;
      const parsed = new PgDialect().sqlToQuery(query);
      expect(parsed.sql).toContain('AND subject=');
      expect(parsed.params).toEqual([challenge.challengeId, 'different-subject']);
      return rows;
    }, transaction: async () => { throw new Error('transaction must not start'); } } as unknown as IdentityDatabase;
    await expect(confirmWalletLink(database, { userId: 'different-subject', challengeId: challenge.challengeId, signature }, now)).rejects.toThrow('wallet_challenge_invalid');
    expect(calls).toBe(1);
  }
});

test('a valid signature still cannot reuse a challenge consumed while waiting for its lock', async () => {
  const wallet = Wallet.createRandom();
  const message = walletLinkMessage({ ...challenge, address: wallet.address });
  const signature = await wallet.signMessage(message);
  const now = new Date('2026-11-09T12:01:00Z');
  const preview = { address: wallet.address.toLowerCase(), message, expires_at: challenge.expiresAt, consumed_at: null };
  const results: unknown[][] = [[preview], [{ id: 'member' }], [{ subject: 'member', auth_email: 'synthetic@example.invalid', email_verified: true,
    person_id: '1', public_id: 'synthetic', person_email: 'synthetic@example.invalid', person_status: 'active', blacklisted: false,
    user_id: 'member', access_restricted: false }], [{ ...preview, person_id: '1', consumed_at: now }]];
  const queries: string[] = [];
  const database = { execute: async (query: SQL) => {
    queries.push(new PgDialect().sqlToQuery(query).sql);
    if (!results.length) throw new Error('unexpected write');
    return results.shift();
  }, transaction: async (callback: (value: unknown) => unknown) => callback(database) } as unknown as IdentityDatabase;
  await expect(confirmWalletLink(database, { userId: 'member', challengeId: challenge.challengeId, signature }, now)).rejects.toThrow('wallet_challenge_invalid');
  expect(queries).toHaveLength(4);
  expect(queries.join(' ')).not.toContain('INSERT INTO');
});
