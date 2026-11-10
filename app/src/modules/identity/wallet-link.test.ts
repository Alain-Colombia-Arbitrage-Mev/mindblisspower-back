import { describe, expect, test } from 'bun:test';
import { Wallet } from 'ethers';
import { canonicalWalletAddress, verifyWalletLinkProof, walletLinkMessage } from './wallet-link';

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
