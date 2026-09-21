import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERMISSION_CATALOG,
  filterCatalogForRole,
  slugsFromRow,
} from './permissionCatalog.js';

test('filterCatalogForRole employee excludes admin-portal rows', () => {
  const filtered = filterCatalogForRole(PERMISSION_CATALOG, 'employee');
  assert.ok(filtered.every((row) => row.portal === 'Employee' || slugsFromRow(row).some((s) => s.startsWith('account.') || s === 'portal.employee.r')));
  assert.ok(!filtered.some((row) => row.read === 'portal.admin.r'));
  assert.ok(!filtered.some((row) => row.read === 'employees.record.r'));
  assert.equal(filtered.length, 17);
});

test('filterCatalogForRole admin excludes employee-portal rows', () => {
  const filtered = filterCatalogForRole(PERMISSION_CATALOG, 'admin');
  assert.ok(filtered.every((row) => row.portal === 'Admin'));
  assert.ok(!filtered.some((row) => slugsFromRow(row).some((s) => s.startsWith('emp.'))));
  assert.equal(filtered.length, 58);
});

test('filterCatalogForRole hr returns full catalog', () => {
  assert.equal(filterCatalogForRole(PERMISSION_CATALOG, 'hr').length, PERMISSION_CATALOG.length);
  assert.equal(filterCatalogForRole(PERMISSION_CATALOG, 'reporting-manager').length, PERMISSION_CATALOG.length);
  assert.equal(filterCatalogForRole(PERMISSION_CATALOG, 'office-admin').length, PERMISSION_CATALOG.length);
});
