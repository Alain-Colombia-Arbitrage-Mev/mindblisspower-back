import { test, expect } from 'bun:test';
import { evaluateSignals, DEFAULT_THRESHOLDS } from './alerts';

const base = { companyFund: 10000, projectedOutflows: 5000, rankAvalancheCount: 0, leftVolume: 50, rightVolume: 50 };

test('healthy inputs produce no alerts', () => {
  expect(evaluateSignals(base, DEFAULT_THRESHOLDS)).toEqual([]);
});

test('low theta is critical', () => {
  const out = evaluateSignals({ ...base, companyFund: 9000, projectedOutflows: 10000 }, DEFAULT_THRESHOLDS);
  expect(out.find((a) => a.signal === 'theta')?.severity).toBe('critical');
  expect(out.find((a) => a.signal === 'outflows_vs_fund')?.severity).toBe('critical');
});

test('theta warning band', () => {
  const out = evaluateSignals({ ...base, companyFund: 10000, projectedOutflows: 9700 }, DEFAULT_THRESHOLDS);
  expect(out.find((a) => a.signal === 'theta')?.severity).toBe('warning');
});

test('zero projected outflows means no theta alert', () => {
  const out = evaluateSignals({ ...base, projectedOutflows: 0 }, DEFAULT_THRESHOLDS);
  expect(out.find((a) => a.signal === 'theta')).toBeUndefined();
});

test('rank avalanche thresholds', () => {
  expect(evaluateSignals({ ...base, rankAvalancheCount: 30 }, DEFAULT_THRESHOLDS)
    .find((a) => a.signal === 'rank_avalanche')?.severity).toBe('warning');
  expect(evaluateSignals({ ...base, rankAvalancheCount: 80 }, DEFAULT_THRESHOLDS)
    .find((a) => a.signal === 'rank_avalanche')?.severity).toBe('critical');
});

test('leg skew thresholds', () => {
  expect(evaluateSignals({ ...base, leftVolume: 90, rightVolume: 10 }, DEFAULT_THRESHOLDS)
    .find((a) => a.signal === 'leg_skew')?.severity).toBe('critical');
});
