import { describe, expect, test } from 'bun:test';
import { administrativeWalletInventory, ensureAdministrativeWallet, readAdministrativeWallet } from './administrative-wallet';

const address = '0xf27949e891e0ad892d94729c8c065b8190a07d9a';
const checkout = 'd8a4c010-cc33-44da-a297-8b3c6440f491';

describe('administrative wallet projection', () => {
  test('returns one checksummed assignment without exposing pool inventory', async () => {
    const database = { execute: async () => [{ status: 'assigned', address, address_family: 'EVM', asset: 'USDT',
      checkout_reference: checkout, assigned_at: new Date('2026-11-10T12:00:00.000Z') }] } as any;
    const result = await ensureAdministrativeWallet(database, { userId: 'member-1' });
    expect(result).toEqual({ status: 'assigned', address: '0xF27949E891e0ad892D94729C8c065B8190A07d9A',
      addressFamily: 'EVM', asset: 'USDT', checkoutReference: checkout, assignedAt: '2026-11-10T12:00:00.000Z' });
    expect(Object.hasOwn(result, 'remaining')).toBe(false);
  });

  test('keeps pending and exhausted states address-free', async () => {
    for (const status of ['pending', 'exhausted'] as const) {
      const database = { execute: async () => [{ status, address: null, address_family: 'EVM', asset: 'USDT',
        checkout_reference: null, assigned_at: null }] } as any;
      expect(await readAdministrativeWallet(database, { userId: 'member-1' })).toEqual({ status, addressFamily: 'EVM', asset: 'USDT' });
    }
  });

  test('validates operator inventory invariants', async () => {
    const database = { execute: async () => [{ total: 28, assigned: 3, remaining: 24, disabled: 1 }] } as any;
    expect(await administrativeWalletInventory(database)).toEqual({ total: 28, assigned: 3, remaining: 24, disabled: 1 });
    const broken = { execute: async () => [{ total: 2, assigned: 2, remaining: 1, disabled: 0 }] } as any;
    await expect(administrativeWalletInventory(broken)).rejects.toThrow('administrative_wallet_inventory_invalid');
  });
});
