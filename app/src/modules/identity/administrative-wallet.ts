import { getAddress } from 'ethers';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from './model';

const subjectInput = z.string().min(1).max(255);
const rowInput = z.object({
  status: z.enum(['assigned', 'pending', 'exhausted']),
  address: z.string().regex(/^0x[0-9a-f]{40}$/).nullable(),
  address_family: z.literal('EVM'),
  asset: z.literal('USDT'),
  checkout_reference: z.string().uuid().nullable(),
  assigned_at: z.coerce.date().nullable(),
});

export type AdministrativeWalletState = {
  status: 'assigned' | 'pending' | 'exhausted';
  address?: string;
  addressFamily: 'EVM';
  asset: 'USDT';
  checkoutReference?: string;
  assignedAt?: string;
};

function projection(value: unknown): AdministrativeWalletState {
  const row = rowInput.parse(value);
  if (row.status === 'assigned') {
    if (!row.address || !row.checkout_reference || !row.assigned_at) throw new Error('administrative_wallet_invalid');
    return {
      status: row.status,
      address: getAddress(row.address),
      addressFamily: row.address_family,
      asset: row.asset,
      checkoutReference: row.checkout_reference,
      assignedAt: row.assigned_at.toISOString(),
    };
  }
  if (row.address || row.checkout_reference || row.assigned_at) throw new Error('administrative_wallet_invalid');
  return { status: row.status, addressFamily: row.address_family, asset: row.asset };
}

export async function readAdministrativeWallet(database: Pick<IdentityDatabase, 'execute'>, input: { userId: string }) {
  const userId = subjectInput.parse(input.userId);
  const rows = await database.execute(sql`SELECT * FROM identity.read_administrative_wallet(${userId})`);
  if (rows.length !== 1) throw new Error('administrative_wallet_unavailable');
  return projection(rows[0]);
}

export async function ensureAdministrativeWallet(database: Pick<IdentityDatabase, 'execute'>, input: { userId: string }) {
  const userId = subjectInput.parse(input.userId);
  const rows = await database.execute(sql`SELECT * FROM identity.ensure_administrative_wallet(${userId})`);
  if (rows.length !== 1) throw new Error('administrative_wallet_unavailable');
  return projection(rows[0]);
}

export async function administrativeWalletInventory(database: Pick<IdentityDatabase, 'execute'>) {
  const rows = await database.execute(sql`SELECT * FROM identity.administrative_wallet_inventory()`);
  const row = z.object({
    total: z.coerce.number().int().min(0),
    assigned: z.coerce.number().int().min(0),
    remaining: z.coerce.number().int().min(0),
    disabled: z.coerce.number().int().min(0),
  }).parse(rows[0]);
  if (rows.length !== 1 || row.assigned + row.remaining > row.total || row.disabled > row.total) {
    throw new Error('administrative_wallet_inventory_invalid');
  }
  return row;
}
