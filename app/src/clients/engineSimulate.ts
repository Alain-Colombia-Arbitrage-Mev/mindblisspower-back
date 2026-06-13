const baseUrl = process.env.VP_ENGINE_HTTP_URL ?? 'http://localhost:8080';

export type SimResponse = {
  worst_theta: number;
  solvent: boolean;
  margin?: number;
  periods?: number;
  warnings?: string[];
};

/** Calls vp-engine POST /simulate (what-if). Throws on non-2xx. */
export async function simulateDraft(overrides: Record<string, string>, periods = 52): Promise<SimResponse> {
  const resp = await fetch(`${baseUrl}/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ overrides, periods }),
  });
  if (!resp.ok) throw new Error(`engine simulate failed: ${resp.status}`);
  return (await resp.json()) as SimResponse;
}
