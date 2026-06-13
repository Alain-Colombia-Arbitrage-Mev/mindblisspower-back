import { db } from '../db/client';
import { getPeriodKpis, getCompanyFund, getNetworkSummary } from './reporting';
import { analyzeNetwork } from '../clients/engineHttp';
import { runAlertEvaluation, listOpenAlerts, acknowledgeAlert } from './alerts';

/** KPIs for the finance section. */
export async function commandCenterSummary(from: string, to: string) {
  const [kpis, companyFund, network] = await Promise.all([
    getPeriodKpis(db, from, to),
    getCompanyFund(db),
    getNetworkSummary(db),
  ]);
  return { kpis, companyFund, network };
}

/** Evaluate now (persist) then return the current open/acknowledged alerts. */
export async function commandCenterAlerts() {
  await runAlertEvaluation(db);
  const alerts = await listOpenAlerts(db);
  return { alerts };
}

export async function commandCenterAckAlert(id: string, personId: bigint) {
  await acknowledgeAlert(db, id, personId);
  return { ok: true };
}

/** Health section: feed current real metrics to the engine. Degrades gracefully. */
export async function commandCenterHealth() {
  const network = await getNetworkSummary(db);
  const companyFund = await getCompanyFund(db);
  try {
    const analysis = await analyzeNetwork({
      total_members: network.totalMembers,
      active_members: network.activeMembers,
      left_volume: network.leftVolume,
      right_volume: network.rightVolume,
      company_fund: companyFund,
    });
    return { ok: true as const, analysis };
  } catch (e) {
    return { ok: false as const, error: String(e), network, companyFund };
  }
}
