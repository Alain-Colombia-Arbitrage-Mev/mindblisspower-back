import { sql } from 'drizzle-orm';
import type { DB } from '../db/client';

export class FinancialRecoveryPendingError extends Error {
  constructor() {
    super('stripe_recovery_review_pending');
    this.name = 'FinancialRecoveryPendingError';
  }
}

export async function requireOperationalFinance(database: Pick<DB, 'execute'>) {
  const rows = await database.execute<{ recovery: boolean }>(sql`
    SELECT to_regclass('payments.stripe_sale') IS NOT NULL AS recovery`);
  if (rows[0]?.recovery !== false) throw new FinancialRecoveryPendingError();
}
