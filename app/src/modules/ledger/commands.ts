import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { timestampFromDate, timestampDate } from '@bufbuild/protobuf/wkt';
import type { Client } from '@connectrpc/connect';
import type { LedgerService } from '../../gen/proto/vicionpower/v1/ledger_pb';
import type { DB } from '../../db/client';
import { requireOperationalFinance } from '../../server/financial-readiness';
import { externalReference, ledgerId, ledgerTransaction, type LedgerTransactionInput } from './validation';

const pvCreditInput = z.object({
  externalRef: externalReference, affiliateId: ledgerId,
  pv: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
});

type LedgerDependencies = {
  database: Pick<DB, 'execute'>;
  ledger: Pick<Client<typeof LedgerService>, 'postTransaction'>;
};

/** Domain commands; every entry point enforces the same recovery write lock. */
export function createLedgerCommands({ database, ledger }: LedgerDependencies) {
  return {
    async registerPvCredit(input: z.infer<typeof pvCreditInput>) {
      const value = pvCreditInput.parse(input);
      await requireOperationalFinance(database);
      await database.execute(sql`
        INSERT INTO mlm.tree_event (
          external_ref, kind, affiliate_id, pv_delta_left, pv_delta_right
        ) VALUES (
          ${value.externalRef}, 'pv_credit', ${value.affiliateId}, ${value.pv}, 0
        ) ON CONFLICT (external_ref) DO NOTHING
      `);
    },

    // Only vp-engine owns wallet_movement/transaction writes and idempotency.
    async postTransaction(input: LedgerTransactionInput) {
      const value = ledgerTransaction.parse(input);
      await requireOperationalFinance(database);
      const result = await ledger.postTransaction({
        externalRef: value.externalRef, description: value.description,
        actor: {
          personId: value.initiatedByPersonId, userId: value.actor?.userId ?? '',
          isAdmin: value.actor?.isAdmin ?? false, ipAddress: value.actor?.ipAddress ?? '',
          userAgent: value.actor?.userAgent ?? '', traceId: value.actor?.traceId ?? '',
        },
        movements: value.movements.map(movement => ({
          walletId: movement.walletId, affiliateId: movement.affiliateId, conceptId: movement.conceptId,
          amount: movement.amount, reference: movement.reference ?? '',
          postedAt: timestampFromDate(movement.postedAt),
          availableAt: movement.availableAt ? timestampFromDate(movement.availableAt) : undefined,
        })),
      });
      return {
        txnId: result.transactionId, wasIdempotentReplay: result.wasIdempotentReplay,
        postedAt: result.postedAt ? timestampDate(result.postedAt) : null,
      };
    },
  };
}
