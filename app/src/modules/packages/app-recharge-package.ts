import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { productionOperation, productionScope } from '../payments/meld-production-http';

const ceilings = [5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 1_000_000, 2_500_000];
const minor = z.union([z.string().regex(/^[1-9][0-9]{0,6}$/), z.number().int()])
  .transform(Number).pipe(z.number().int().positive().max(2_500_000));
const cumulativeMinor = z.union([z.string().regex(/^[1-9][0-9]{0,15}$/), z.number().int()])
  .transform(Number).pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
const tier = z.object({
  level: z.number().int().min(1).max(8),
  ceiling_usd_minor: minor,
  gross_usd_minor: cumulativeMinor,
  confirmed_at: z.coerce.date(),
}).strict().refine(value => ceilings[value.level - 1] === value.ceiling_usd_minor
  && (value.level === 8 || value.gross_usd_minor <= value.ceiling_usd_minor)
  && (value.level === 1 || value.gross_usd_minor > ceilings[value.level - 2]!));

/** Display-only projection for the current native member. */
export async function readAppRechargePackage(database: Pick<IdentityDatabase, 'execute'>, subject: string,
  nativeSessionId: string, signal?: AbortSignal) {
  const scope = productionScope(signal);
  try {
    const rows = await productionOperation(() => database.execute(sql`
      SELECT * FROM payments.read_app_recharge_package_v1(${subject},${nativeSessionId})
    `), scope.signal);
    if (rows.length === 0) return { package: null };
    const result = tier.safeParse(rows[0]);
    if (rows.length !== 1 || !result.success) throw Error('member_recharge_package_unavailable');
    const value = result.data;
    return { package: { level: value.level, ceilingUsdMinor: value.ceiling_usd_minor,
      grossUsdMinor: value.gross_usd_minor, confirmedAt: value.confirmed_at.toISOString() } };
  } finally { scope.close(); }
}
