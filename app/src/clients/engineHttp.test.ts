import { test, expect, mock } from 'bun:test';
import { analyzeNetwork } from './engineHttp';

test('analyzeNetwork POSTs metrics and returns parsed response', async () => {
  const fetchMock = mock(async (url: string, init: any) => {
    expect(url).toContain('/network/analyze');
    const body = JSON.parse(init.body);
    expect(body.metrics.worst_theta).toBe(0.97);
    return new Response(JSON.stringify({
      provider: 'test', mode: 'heuristic', health_score: 42,
      risk_level: 'high', weak_leg: 'L', summary: 'ok', warnings: ['x'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  globalThis.fetch = fetchMock as any;

  const res = await analyzeNetwork({ total_members: 10, worst_theta: 0.97 } as any);
  expect(res.health_score).toBe(42);
  expect(res.risk_level).toBe('high');
});
