const baseUrl = process.env.VP_ENGINE_HTTP_URL ?? 'http://localhost:8080';

export type NetworkMetrics = {
  total_members: number; active_members?: number;
  left_members?: number; right_members?: number;
  left_volume?: number; right_volume?: number;
  company_fund?: number; projected_outflows?: number;
  worst_theta?: number; rank?: string;
};

export type AnalysisResponse = {
  provider: string; model?: string; mode: string;
  health_score: number; risk_level: string; weak_leg: string;
  summary: string; warnings?: string[];
};

/** Calls vp-engine POST /network/analyze (existing). Throws on non-2xx. */
export async function analyzeNetwork(metrics: NetworkMetrics): Promise<AnalysisResponse> {
  const resp = await fetch(`${baseUrl}/network/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ generated_at: new Date().toISOString(), metrics }),
  });
  if (!resp.ok) throw new Error(`engine analyze failed: ${resp.status}`);
  return (await resp.json()) as AnalysisResponse;
}
