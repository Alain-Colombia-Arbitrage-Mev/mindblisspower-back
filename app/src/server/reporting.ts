import { sql } from 'drizzle-orm';
// type-only import: does NOT execute db/client (which throws if DATABASE_URL unset).
import type { DB } from '../db/client';

type Executor = Pick<DB, 'execute'>;

export type KindPaid = { kind: string; paid: number };
export type PeriodKpis = {
  from: string; to: string;
  inflows: number; bonusOutflows: number; withdrawals: number; margin: number;
  byKind: KindPaid[];
};

/** v1 KPI aggregation over [from, to). Money semantics locked in the plan. */
export async function getPeriodKpis(q: Executor, from: string, to: string): Promise<PeriodKpis> {
  const inflowRows = await q.execute<{ v: string }>(sql`
    SELECT COALESCE(SUM(ABS(m.amount)),0)::text AS v
      FROM mlm.wallet_movement m JOIN mlm.concept c ON c.id = m.concept_id
     WHERE c.kind = 'package_purchase'
       AND m.posted_at >= ${from} AND m.posted_at < ${to}`);

  const wRows = await q.execute<{ v: string }>(sql`
    SELECT COALESCE(SUM(ABS(m.amount)),0)::text AS v
      FROM mlm.wallet_movement m JOIN mlm.concept c ON c.id = m.concept_id
     WHERE c.kind = 'withdrawal'
       AND m.posted_at >= ${from} AND m.posted_at < ${to}`);

  const byKindRows = await q.execute<{ kind: string; paid: string }>(sql`
    SELECT kind, COALESCE(SUM(total_paid_usd),0)::text AS paid
      FROM mlm.bonus_run
     WHERE run_date >= ${from} AND run_date < ${to}
     GROUP BY kind ORDER BY kind`);

  const inflows = Number(inflowRows[0]?.v ?? 0);
  const withdrawals = Number(wRows[0]?.v ?? 0);
  const byKind = byKindRows.map((r) => ({ kind: r.kind, paid: Number(r.paid) }));
  const bonusOutflows = byKind.reduce((s, r) => s + r.paid, 0);

  return { from, to, inflows, bonusOutflows, withdrawals, margin: inflows - bonusOutflows, byKind };
}

/** v1 all-time net liquidity estimate. Display-only; flagged for confirmation. */
export async function getCompanyFund(q: Executor): Promise<number> {
  const rows = await q.execute<{ v: string }>(sql`
    SELECT COALESCE(SUM(
      CASE
        WHEN c.kind = 'package_purchase' THEN ABS(m.amount)
        WHEN c.kind = 'platform_fee'     THEN ABS(m.amount)
        WHEN c.kind = 'withdrawal'       THEN -ABS(m.amount)
        ELSE 0
      END), 0)::text AS v
      FROM mlm.wallet_movement m JOIN mlm.concept c ON c.id = m.concept_id`);
  const grossRetained = Number(rows[0]?.v ?? 0);
  const paid = await q.execute<{ v: string }>(sql`
    SELECT COALESCE(SUM(total_paid_usd),0)::text AS v FROM mlm.bonus_run`);
  return grossRetained - Number(paid[0]?.v ?? 0);
}

export type NetworkSummary = {
  totalMembers: number; activeMembers: number;
  leftVolume: number; rightVolume: number; leftCount: number; rightCount: number;
};

export async function getNetworkSummary(q: Executor): Promise<NetworkSummary> {
  const rows = await q.execute<Record<string, string>>(sql`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE status='active')::text AS active,
      COALESCE(SUM(left_pv_current),0)::text  AS lvol,
      COALESCE(SUM(right_pv_current),0)::text AS rvol,
      COALESCE(SUM(left_count),0)::text  AS lcnt,
      COALESCE(SUM(right_count),0)::text AS rcnt
    FROM mlm.affiliate`);
  const r = rows[0]!;
  return {
    totalMembers: Number(r.total), activeMembers: Number(r.active),
    leftVolume: Number(r.lvol), rightVolume: Number(r.rvol),
    leftCount: Number(r.lcnt), rightCount: Number(r.rcnt),
  };
}

/** projectedOutflows proxy = total paid in the most recent bonus_run period. */
export async function getProjectedOutflows(q: Executor): Promise<number> {
  const rows = await q.execute<{ v: string }>(sql`
    SELECT COALESCE(SUM(total_paid_usd),0)::text AS v
      FROM mlm.bonus_run
     WHERE run_date = (SELECT MAX(run_date) FROM mlm.bonus_run)`);
  return Number(rows[0]?.v ?? 0);
}

/** Count active affiliates within `pct` of their NEXT rank's required_points (ADR-0017). */
export async function getRankAvalancheCount(q: Executor, pct: number): Promise<number> {
  const rows = await q.execute<{ v: string }>(sql`
    WITH prog AS (
      SELECT a.id,
             LEAST(a.left_pv_lifetime, a.right_pv_lifetime) + a.rank_points_baseline AS qval
        FROM mlm.affiliate a
       WHERE a.status = 'active'
    ),
    nextrank AS (
      SELECT p.id, p.qval, MIN(r.required_points) AS next_req
        FROM prog p
        JOIN mlm.rank r ON r.required_points > p.qval
       GROUP BY p.id, p.qval
    )
    SELECT COUNT(*)::text AS v
      FROM nextrank
     WHERE qval >= ${pct}::numeric * next_req`);
  return Number(rows[0]?.v ?? 0);
}

/** Global leg skew = stronger leg share of total current PV (0..1). */
export async function getLegSkew(q: Executor): Promise<number> {
  const rows = await q.execute<{ l: string; r: string }>(sql`
    SELECT COALESCE(SUM(left_pv_current),0)::text  AS l,
           COALESCE(SUM(right_pv_current),0)::text AS r
      FROM mlm.affiliate`);
  const l = Number(rows[0]?.l ?? 0);
  const r = Number(rows[0]?.r ?? 0);
  const total = l + r;
  return total > 0 ? Math.max(l, r) / total : 0;
}
