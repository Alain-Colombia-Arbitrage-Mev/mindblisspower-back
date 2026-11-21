import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { IdentityDatabase } from '../identity/model';
import { productionOperation, productionScope } from '../payments/meld-production-http';

function isWeekEnd(value: string) {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.getUTCDay() === 1 && date.toISOString().slice(0, 10) === value;
}

/** undefined is invalid, null is the initial page. Do not accept encoded aliases. */
export function readPagarCommissionCursor(url: URL) {
  if (url.hash) return undefined;
  if (!url.search) return url.href.endsWith('?') ? undefined : null;
  const before = url.search.slice('?before='.length);
  if (url.search !== `?before=${before}` || !isWeekEnd(before)) return undefined;
  return before;
}

const minor = z.string().regex(/^(0|[1-9]\d{0,15})$/).transform(Number).pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const weekEnd = z.string().refine(isWeekEnd);
const period = z.object({ week_end: weekEnd, binary_usd_minor: minor, rank_usd_minor: minor }).strict()
  .refine(item => item.binary_usd_minor > 0 || item.rank_usd_minor > 0);
const view = z.object({
  virtual_balance_usd_minor: minor,
  periods: z.array(period).max(12),
  next_before: weekEnd.nullable(),
}).strict();

export async function readAppPagarCommissions(database: Pick<IdentityDatabase, 'execute'>, subject: string,
  nativeSessionId: string, before: string | null, signal?: AbortSignal) {
  const scope = productionScope(signal);
  try {
    const rows = await productionOperation(() => database.execute(sql`
      SELECT * FROM payments.read_app_pagar_commissions_v1(${subject},${nativeSessionId},${before}::date)
    `), scope.signal);
    const [result] = z.array(view).length(1).parse(rows);
    const { virtual_balance_usd_minor: virtualBalanceUsdMinor, periods, next_before: nextBefore } = result!;
    if (periods.some((item, index) => (before !== null && item.week_end >= before)
      || (index > 0 && item.week_end >= periods[index - 1]!.week_end))
      || (nextBefore !== null && (periods.length !== 12 || periods.at(-1)?.week_end !== nextBefore))) {
      throw Error('member_pagar_commissions_unavailable');
    }
    return { virtualBalanceUsdMinor, nextBefore, periods: periods.map(item => ({
      weekEnd: item.week_end, binaryUsdMinor: item.binary_usd_minor, rankUsdMinor: item.rank_usd_minor,
    })) };
  } finally { scope.close(); }
}
