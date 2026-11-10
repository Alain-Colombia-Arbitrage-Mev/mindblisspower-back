import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { createMeldOnrampQuote, MELD_ONRAMP_CRYPTO } from './meld-onramp';

const providerInput = z.string().regex(/^[A-Z0-9_]{2,40}$/).refine(value => !['BINANCECONNECT', 'BINANCEPAY'].includes(value));
const methodInput = z.string().regex(/^[A-Z0-9_]{2,40}$/);
const addressInput = z.string().regex(/^0x[0-9a-f]{40}$/i);

export const onrampIntentInput = z.object({
  walletKind: z.enum(['personal', 'administrative']),
  walletAddress: addressInput,
  country: z.string().regex(/^[A-Z]{2}$/),
  fiat: z.literal('USD'),
  crypto: z.literal(MELD_ONRAMP_CRYPTO),
  amount: z.number().finite().min(50).max(25_000),
  paymentMethodType: methodInput,
  serviceProvider: providerInput,
}).strict();

export async function createMeldOnrampAttempt(database: Pick<IdentityDatabase, 'execute'>, input: unknown,
  { subject, environment = process.env, fetchImpl = fetch }: {
    subject: string;
    environment?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  }) {
  if (!subject || subject.length > 255) throw new Error('meld_onramp_identity_unavailable');
  const intent = onrampIntentInput.parse(input);
  const verified = await createMeldOnrampQuote({
    country: intent.country, fiat: intent.fiat, crypto: intent.crypto, amount: intent.amount,
    paymentMethodType: intent.paymentMethodType, walletAddress: intent.walletAddress,
  }, { environment, fetchImpl });
  if (!verified.available) throw new Error('meld_onramp_quote_unavailable');
  const quote = verified.quote;
  const rows = await database.execute<{ id: string; mindbliss_fee_usd: string }>(sql`
    SELECT id::text,mindbliss_fee_usd::text FROM payments.create_meld_onramp_attempt(
      ${subject},${intent.walletKind},${intent.walletAddress.toLowerCase()},${intent.country},${quote.serviceProvider},
      ${quote.paymentMethodType},${quote.sourceAmount},${quote.destinationAmount},${quote.totalFee}
    )`);
  const row = rows[0];
  if (!row || !z.string().uuid().safeParse(row.id).success) throw new Error('meld_onramp_capture_unavailable');
  const commissionUsd = Number(row.mindbliss_fee_usd);
  if (!Number.isFinite(commissionUsd) || commissionUsd < 0) throw new Error('meld_onramp_capture_unavailable');
  return {
    checkoutReference: row.id,
    walletKind: intent.walletKind,
    quote,
    commission: { ratePercent: 1, estimatedUsd: commissionUsd, status: 'estimated' as const },
  };
}
