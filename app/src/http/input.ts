import { z } from 'zod';
import { externalReference, ledgerAmount, ledgerTimestamp } from '../modules/ledger/validation';

// PostgreSQL bigint identifiers must not pass through an unsafe JS number.
const maxId = 9_223_372_036_854_775_807n;
export const positiveId = z.union([
  z.string().regex(/^[1-9][0-9]{0,18}$/),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
]).transform(value => BigInt(value)).refine(value => value <= maxId);

export const autoPlacementInput = z.object({
  personId: positiveId,
  sponsorAffiliateId: positiveId,
  preferredSide: z.enum(['L', 'R']).optional(),
});

export const placementInput = z.object({
  personId: positiveId,
  parentAffiliateId: positiveId,
  sponsorAffiliateId: positiveId,
  position: z.enum(['L', 'R']),
});

export const transactionInput = z.object({
  externalRef: externalReference,
  description: z.string().max(2000),
  // Legacy clients may still send it; it is never an authorization/audit input.
  initiatedByPersonId: z.unknown().optional(),
  movements: z.array(z.object({
    walletId: positiveId,
    affiliateId: positiveId,
    conceptId: z.number().int().positive().max(2_147_483_647),
    amount: ledgerAmount,
    reference: z.string().max(2000).optional(),
    postedAt: ledgerTimestamp,
    availableAt: ledgerTimestamp.optional(),
  })).min(1).max(1000),
}).transform(({ initiatedByPersonId: _untrustedInitiator, ...input }) => input);

const calendarDate = z.iso.date().refine(value => value.slice(0, 4) !== '0000');
export const reportingRange = z.object({ from: calendarDate, to: calendarDate })
  .refine(value => value.from <= value.to);

export const alertId = positiveId.transform(value => value.toString());
