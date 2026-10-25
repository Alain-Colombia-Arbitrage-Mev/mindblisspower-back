import { db } from '../db/client';
import { getPeriodKpis, getCompanyFund, getNetworkSummary } from './reporting';
import { analyzeNetwork } from '../clients/engineHttp';
import { listOpenAlerts, acknowledgeAlert } from './alerts';
import { requireOperationalFinance } from './financial-readiness';

/** KPIs for the finance section. */
export async function commandCenterSummary(from: string, to: string) {
  await requireOperationalFinance(db);
  const [kpis, companyFund, network] = await Promise.all([
    getPeriodKpis(db, from, to),
    getCompanyFund(db),
    getNetworkSummary(db),
  ]);
  return { kpis, companyFund, network };
}

/** GET is a read: alert evaluation belongs to an explicit worker/command. */
export async function commandCenterAlerts() {
  await requireOperationalFinance(db);
  const alerts = await listOpenAlerts(db);
  return { alerts };
}

export async function commandCenterAckAlert(id: string, personId: bigint) {
  await requireOperationalFinance(db);
  await acknowledgeAlert(db, id, personId);
  return { ok: true };
}

/** Health section: feed current real metrics to the engine. Degrades gracefully. */
export async function commandCenterHealth() {
  await requireOperationalFinance(db);
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
  } catch {
    return { ok: false as const, error: 'analysis_unavailable', network, companyFund };
  }
}
