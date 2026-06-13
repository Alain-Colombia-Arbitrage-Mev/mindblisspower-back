import { test, expect, mock } from 'bun:test';
import { simulateDraft } from './engineSimulate';

test('simulateDraft POSTs overrides and periods, parses response', async () => {
  const fetchMock = mock(async (url: string, init: any) => {
    expect(url).toContain('/simulate');
    const body = JSON.parse(init.body);
    expect(body.overrides.treasury_alpha).toBe('0.45');
    expect(body.periods).toBe(52);
    return new Response(JSON.stringify({ worst_theta: 0.91, solvent: true, margin: 0.12, periods: 52 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  globalThis.fetch = fetchMock as any;

  const res = await simulateDraft({ treasury_alpha: '0.45' });
  expect(res.worst_theta).toBe(0.91);
  expect(res.solvent).toBe(true);
});
