import { sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getCompanyFund, getNetworkSummary, getProjectedOutflows, getRankAvalancheCount } from './reporting';

type Executor = Pick<DB, 'execute'>;

export type AlertThresholds = {
  thetaWarn: number;
  thetaCrit: number;
  ratioWarn: number;
  ratioCrit: number;
  avalancheWarn: number;
  avalancheCrit: number;
  legSkewWarn: number;
  legSkewCrit: number;
  rankNearPct: number;
};

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  thetaWarn: Number(process.env.ALERT_THETA_WARN ?? 1.05),
  thetaCrit: Number(process.env.ALERT_THETA_CRIT ?? 1.0),
  ratioWarn: Number(process.env.ALERT_RATIO_WARN ?? 0.8),
  ratioCrit: Number(process.env.ALERT_RATIO_CRIT ?? 1.0),
  avalancheWarn: Number(process.env.ALERT_AVALANCHE_WARN ?? 25),
  avalancheCrit: Number(process.env.ALERT_AVALANCHE_CRIT ?? 75),
  legSkewWarn: Number(process.env.ALERT_LEGSKEW_WARN ?? 0.7),
  legSkewCrit: Number(process.env.ALERT_LEGSKEW_CRIT ?? 0.85),
  rankNearPct: Number(process.env.ALERT_RANK_NEAR_PCT ?? 0.9),
};

export type AlertInputs = {
  companyFund: number;
  projectedOutflows: number;
  rankAvalancheCount: number;
  leftVolume: number;
  rightVolume: number;
};

export type DetectedAlert = {
  signal: 'theta' | 'outflows_vs_fund' | 'rank_avalanche' | 'leg_skew';
  severity: 'warning' | 'critical';
  metricValue: number;
  threshold: number;
  detail: string;
};

/** Pure: turn metrics into discrete alerts. No DB, no IO. */
export function evaluateSignals(i: AlertInputs, t: AlertThresholds): DetectedAlert[] {
  const out: DetectedAlert[] = [];

  if (i.projectedOutflows > 0) {
    const theta = i.companyFund / i.projectedOutflows;
    if (theta < t.thetaCrit) {
      out.push({
        signal: 'theta',
        severity: 'critical',
        metricValue: round(theta),
        threshold: t.thetaCrit,
        detail: `θ=${round(theta)} < ${t.thetaCrit}: el fondo no cubre el desembolso proyectado.`,
      });
    } else if (theta < t.thetaWarn) {
      out.push({
        signal: 'theta',
        severity: 'warning',
        metricValue: round(theta),
        threshold: t.thetaWarn,
        detail: `θ=${round(theta)} < ${t.thetaWarn}: margen de solvencia ajustado.`,
      });
    }
  }

  if (i.projectedOutflows > 0) {
    const ratio = i.companyFund > 0 ? i.projectedOutflows / i.companyFund : Infinity;
    if (i.companyFund <= 0 || ratio > t.ratioCrit) {
      out.push({
        signal: 'outflows_vs_fund',
        severity: 'critical',
        metricValue: round(Number.isFinite(ratio) ? ratio : 0),
        threshold: t.ratioCrit,
        detail: `Desembolsos proyectados superan el fondo (ratio ${round(ratio)}).`,
      });
    } else if (ratio > t.ratioWarn) {
      out.push({
        signal: 'outflows_vs_fund',
        severity: 'warning',
        metricValue: round(ratio),
        threshold: t.ratioWarn,
        detail: `Desembolsos proyectados son ${Math.round(ratio * 100)}% del fondo.`,
      });
    }
  }

  if (i.rankAvalancheCount > t.avalancheCrit) {
    out.push({
      signal: 'rank_avalanche',
      severity: 'critical',
      metricValue: i.rankAvalancheCount,
      threshold: t.avalancheCrit,
      detail: `${i.rankAvalancheCount} afiliados a punto de calificar a rango (avalancha).`,
    });
  } else if (i.rankAvalancheCount > t.avalancheWarn) {
    out.push({
      signal: 'rank_avalanche',
      severity: 'warning',
      metricValue: i.rankAvalancheCount,
      threshold: t.avalancheWarn,
      detail: `${i.rankAvalancheCount} afiliados próximos a calificar a rango.`,
    });
  }

  const totalVol = i.leftVolume + i.rightVolume;
  if (totalVol > 0) {
    const skew = Math.max(i.leftVolume, i.rightVolume) / totalVol;
    if (skew > t.legSkewCrit) {
      out.push({
        signal: 'leg_skew',
        severity: 'critical',
        metricValue: round(skew),
        threshold: t.legSkewCrit,
        detail: `Pierna fuerte concentra ${Math.round(skew * 100)}% del volumen (derrame severo).`,
      });
    } else if (skew > t.legSkewWarn) {
      out.push({
        signal: 'leg_skew',
        severity: 'warning',
        metricValue: round(skew),
        threshold: t.legSkewWarn,
        detail: `Desbalance de piernas: ${Math.round(skew * 100)}% en la pierna fuerte.`,
      });
    }
  }

  return out;
}

function round(n: number) {
  return Math.round(n * 10000) / 10000;
}

export async function gatherAlertInputs(q: Executor, t: AlertThresholds = DEFAULT_THRESHOLDS): Promise<AlertInputs> {
  const [companyFund, projectedOutflows, network, rankAvalancheCount] = await Promise.all([
    getCompanyFund(q),
    getProjectedOutflows(q),
    getNetworkSummary(q),
    getRankAvalancheCount(q, t.rankNearPct),
  ]);
  return {
    companyFund, projectedOutflows, rankAvalancheCount,
    leftVolume: network.leftVolume, rightVolume: network.rightVolume,
  };
}

export type AlertRow = {
  id: string; signal: string; severity: string;
  metric_value: string | null; threshold: string | null;
  detail: string; status: string; created_at: string;
};

/** Evaluate now, persist: upsert open alerts per signal, auto-resolve cleared ones. */
export async function runAlertEvaluation(q: Executor, t: AlertThresholds = DEFAULT_THRESHOLDS): Promise<DetectedAlert[]> {
  const inputs = await gatherAlertInputs(q, t);
  const detected = evaluateSignals(inputs, t);
  const activeSignals = detected.map((d) => d.signal);

  if (activeSignals.length > 0) {
    // sql.join builds a real "$1, $2, ..." list; interpolating a JS array directly
    // produces a record tuple that can't cast to text[] (caught against real PG17).
    const list = sql.join(activeSignals.map((s) => sql`${s}`), sql`, `);
    await q.execute(sql`
      UPDATE mlm.alert_event SET status='resolved', updated_at=now()
       WHERE status='open' AND signal NOT IN (${list})`);
  } else {
    await q.execute(sql`UPDATE mlm.alert_event SET status='resolved', updated_at=now() WHERE status='open'`);
  }

  for (const d of detected) {
    await q.execute(sql`
      INSERT INTO mlm.alert_event (signal, severity, metric_value, threshold, detail, status, updated_at)
      VALUES (${d.signal}, ${d.severity}, ${d.metricValue}, ${d.threshold}, ${d.detail}, 'open', now())
      ON CONFLICT (signal) WHERE status='open'
      DO UPDATE SET severity=EXCLUDED.severity, metric_value=EXCLUDED.metric_value,
                    threshold=EXCLUDED.threshold, detail=EXCLUDED.detail, updated_at=now()`);
  }
  return detected;
}

export async function listOpenAlerts(q: Executor): Promise<AlertRow[]> {
  return await q.execute<AlertRow>(sql`
    SELECT id::text, signal, severity, metric_value::text, threshold::text, detail, status, created_at::text
      FROM mlm.alert_event
     WHERE status IN ('open','acknowledged')
     ORDER BY (severity='critical') DESC, created_at DESC`);
}

export async function acknowledgeAlert(q: Executor, id: string, personId: bigint): Promise<void> {
  await q.execute(sql`
    UPDATE mlm.alert_event
       SET status='acknowledged', acknowledged_by=${personId}, acknowledged_at=now(), updated_at=now()
     WHERE id=${id} AND status='open'`);
}
