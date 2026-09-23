import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BULK_IMPORT_PERMISSION_SLUGS,
  PERMISSION_CATALOG,
  buildDefaultRolePermissions,
  migrateLegacyPermissions,
  stripBulkImportPermissions,
} from './permissionCatalog.js';

test('Bulk Import catalog rows deny Reporting Manager (including bulk_export read)', () => {
  const bulkRows = PERMISSION_CATALOG.filter(
    (row) => row.page === 'Bulk Import' && row.navGroup === 'Employees',
  );
  assert.equal(bulkRows.length, 2);
  for (const row of bulkRows) {
    assert.equal(row.reportingManager, 'N', `row ${row.row} must deny RM`);
  }
  assert.ok(BULK_IMPORT_PERMISSION_SLUGS.includes('employees.bulk_export.r'));
  assert.ok(BULK_IMPORT_PERMISSION_SLUGS.includes('employees.bulk_upload.c'));
});

test('Reporting Manager defaults exclude all Bulk Import slugs', () => {
  const defaults = buildDefaultRolePermissions();
  const rmPerms = defaults['reporting-manager'];
  for (const slug of BULK_IMPORT_PERMISSION_SLUGS) {
    assert.ok(!rmPerms.includes(slug), `RM default must not include ${slug}`);
  }
});

test('Admin and HR defaults include Bulk Import slugs', () => {
  const defaults = buildDefaultRolePermissions();
  for (const slug of BULK_IMPORT_PERMISSION_SLUGS) {
    assert.ok(defaults.admin.includes(slug), `admin must include ${slug}`);
    assert.ok(defaults.hr.includes(slug), `hr must include ${slug}`);
  }
});

test('stripBulkImportPermissions removes legacy users.write bulk upload grants', () => {
  const migrated = migrateLegacyPermissions(['users.write']);
  assert.ok(migrated.includes('employees.bulk_upload.c'));
  assert.ok(migrated.includes('employees.bulk_upload.u'));

  const stripped = stripBulkImportPermissions(migrated);
  for (const slug of BULK_IMPORT_PERMISSION_SLUGS) {
    assert.ok(!stripped.includes(slug));
  }
  assert.ok(stripped.includes('employees.register.c'));
});

test('stripBulkImportPermissions removes bulk_export read when present on RM role', () => {
  const withExportRead = [
    ...buildDefaultRolePermissions()['reporting-manager'],
    'employees.bulk_export.r',
    'employees.bulk_export.x0',
  ];
  const stripped = stripBulkImportPermissions(withExportRead);
  assert.ok(!stripped.includes('employees.bulk_export.r'));
  assert.ok(!stripped.includes('employees.bulk_export.x0'));
});

test('stripBulkImportPermissions is idempotent', () => {
  const once = stripBulkImportPermissions([
    'employees.bulk_export.r',
    'employees.bulk_upload.x0',
    'attendance.record.r',
  ]);
  assert.deepEqual(once, ['attendance.record.r']);
  assert.deepEqual(stripBulkImportPermissions(once), once);
});
