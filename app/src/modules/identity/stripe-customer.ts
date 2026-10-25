import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { principal, principalResult, quarantine, userInput, type IdentityDatabase } from './model';

const inputSchema = userInput.extend({ accountId: z.string().regex(/^acct_[A-Za-z0-9]+$/).max(255),
  customerId: z.string().regex(/^cus_[A-Za-z0-9]+$/).max(255), livemode: z.boolean() });

// Server-only: account/mode/customer must come from verified provider evidence,
// not a checkout body or email. This function does not call Stripe or move money.
export async function bindStripeCustomer(database: IdentityDatabase, input: z.input<typeof inputSchema>) {
  const value = inputSchema.parse(input);
  return database.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM auth.user WHERE id=${value.userId} FOR UPDATE`);
    const owner = principalResult(await principal(tx, value.userId));
    if (owner.status !== 'existing') return owner;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'stripe-customer:' + value.accountId + ':' + value.livemode},0))`);
    const previous = await tx.execute<{ person_id: string; customer_id: string }>(sql`
      SELECT person_id::text,customer_id FROM identity.stripe_customer
      WHERE account_id=${value.accountId} AND livemode=${value.livemode}
        AND (customer_id=${value.customerId} OR person_id=${owner.personId!}::bigint) FOR UPDATE`);
    if (previous.length) {
      if (previous.length === 1 && previous[0]!.person_id === owner.personId && previous[0]!.customer_id === value.customerId) return { ...owner, status: 'existing' as const };
      return quarantine(tx, value.userId, 'stripe_customer_collision', owner.personId!);
    }
    await tx.execute(sql`INSERT INTO identity.stripe_customer(account_id,livemode,customer_id,person_id,linked_by_subject)
      VALUES(${value.accountId},${value.livemode},${value.customerId},${owner.personId!}::bigint,${value.userId})`);
    return { ...owner, status: 'created' as const };
  });
}
