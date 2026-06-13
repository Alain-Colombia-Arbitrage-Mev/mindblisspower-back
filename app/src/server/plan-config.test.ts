import { test, expect } from 'bun:test';
import { NON_EDITABLE_FIELDS, isEditable, buildDraft, validateOverrides, candadosPass } from './plan-config';

const active = { id: '7', bonus_per_block: '10', daily_cap_factor: '3', treasury_alpha: '0.4', block_size: '100', version_label: 'v2' };

test('buildDraft applies any non-managed override over the active row', () => {
  const draft = buildDraft(active, { bonus_per_block: '8', block_size: '120' });
  expect(draft.bonus_per_block).toBe('8');
  expect(draft.block_size).toBe('120');
  expect(draft.treasury_alpha).toBe('0.4');
});

test('validateOverrides rejects managed columns and non-numeric values', () => {
  expect(() => validateOverrides({ id: '9' })).toThrow();
  expect(() => validateOverrides({ effective_from: 'x' })).toThrow();
  expect(() => validateOverrides({ bonus_per_block: 'abc' })).toThrow();
  expect(validateOverrides({ bonus_per_block: '8', treasury_alpha: '0.45' }))
    .toEqual({ bonus_per_block: '8', treasury_alpha: '0.45' });
});

test('pause_mode may be non-numeric text', () => {
  expect(validateOverrides({ pause_mode: 'P-C' })).toEqual({ pause_mode: 'P-C' });
});

test('candadosPass requires solvency and theta floor', () => {
  expect(candadosPass({ worst_theta: 0.9, solvent: true }, 0.85)).toBe(true);
  expect(candadosPass({ worst_theta: 0.8, solvent: true }, 0.85)).toBe(false);
  expect(candadosPass({ worst_theta: 0.9, solvent: false }, 0.85)).toBe(false);
});

test('isEditable blocks managed columns only', () => {
  expect(isEditable('treasury_alpha')).toBe(true);
  expect(isEditable('block_size')).toBe(true);
  expect(isEditable('id')).toBe(false);
  expect(NON_EDITABLE_FIELDS).toContain('approval_request_id');
});
