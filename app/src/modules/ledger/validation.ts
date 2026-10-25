import { z } from 'zod';

export const ledgerId = z.bigint().positive().max(9_223_372_036_854_775_807n);
export const externalReference = z.string().min(1).max(255).refine(value => value.trim().length > 0);

// Match PostgreSQL numeric(20,8) without rounding or converting through Number.
export const ledgerAmount = z.string().max(100).regex(/^-?[0-9]+(?:\.[0-9]+)?$/).refine(value => {
  const [integer = '', fraction = ''] = value.replace(/^-/, '').split('.');
  return (integer.replace(/^0+/, '').length || 1) <= 12 && fraction.length <= 8;
});

const minimumDate = new Date('0001-01-01T00:00:00.000Z');
const maximumDate = new Date('9999-12-31T23:59:59.999Z');
export const ledgerDate = z.date().min(minimumDate).max(maximumDate);
export const ledgerTimestamp = z.iso.datetime({ offset: true })
  .refine(value => value.slice(0, 4) !== '0000')
  .transform(value => new Date(value)).pipe(ledgerDate);

export const ledgerTransaction = z.object({
  externalRef: externalReference,
  description: z.string().max(2000),
  initiatedByPersonId: ledgerId,
  actor: z.object({
    userId: z.string().optional(), isAdmin: z.boolean().optional(),
    ipAddress: z.string().optional(), userAgent: z.string().optional(), traceId: z.string().optional(),
  }).optional(),
  movements: z.array(z.object({
    walletId: ledgerId, affiliateId: ledgerId,
    conceptId: z.number().int().positive().max(2_147_483_647),
    amount: ledgerAmount, reference: z.string().max(2000).optional(),
    postedAt: ledgerDate, availableAt: ledgerDate.optional(),
  })).min(1).max(1000),
});

export type LedgerTransactionInput = z.infer<typeof ledgerTransaction>;
