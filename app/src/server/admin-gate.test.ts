import { test, expect } from 'bun:test';
import { isAdminPerson } from './admin-gate';

test('isAdminPerson true only for active admin', () => {
  expect(isAdminPerson({ isAdmin: true, status: 'active' })).toBe(true);
  expect(isAdminPerson({ isAdmin: false, status: 'active' })).toBe(false);
  expect(isAdminPerson({ isAdmin: true, status: 'suspended' })).toBe(false);
  expect(isAdminPerson(null)).toBe(false);
});
