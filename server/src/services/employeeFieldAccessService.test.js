import assert from 'node:assert/strict';
import test from 'node:test';
import { PERMISSIONS } from '../../../shared/permissions.js';
import {
  assertEmployeePatchAllowed,
  buildEmployeeFieldAccess,
  maskEmployeePayload,
} from './employeeFieldAccessService.js';
import { redactAuditLogForCaller, redactAuditExportRow } from './auditLogAccessService.js';

test('buildEmployeeFieldAccess reflects HR default credential slugs', () => {
  const access = buildEmployeeFieldAccess([
    PERMISSIONS.EMPLOYEES_CREDENTIALS_U,
    PERMISSIONS.EMPLOYEES_CREDENTIALS_X0,
  ]);
  assert.equal(access.credentials.resetPassword, true);
  assert.equal(access.credentials.resetPin, false);
});

test('maskEmployeePayload strips employment block without permission', () => {
  const masked = maskEmployeePayload(
    {
      id: '1',
      name: 'Test User',
      email: 't@example.com',
      departmentId: 'd1',
      roleId: 'r1',
    },
    [PERMISSIONS.EMPLOYEES_ACCOUNT_R],
    { includeMeta: false },
  );
  assert.equal(masked.email, 't@example.com');
  assert.equal(masked.departmentId, undefined);
});

test('assertEmployeePatchAllowed blocks employment update without slug', () => {
  const result = assertEmployeePatchAllowed([PERMISSIONS.EMPLOYEES_ACCOUNT_R], {
    departmentId: 'abc',
  });
  assert.equal(result.ok, false);
});

test('audit PII redaction strips email and ip for HR', () => {
  const redacted = redactAuditLogForCaller(
    { id: '1', email: 'hr@test.com', ip: '1.2.3.4', action: 'login_success' },
    [PERMISSIONS.AUDIT_LOG_R],
  );
  assert.equal(redacted.email, null);
  assert.equal(redacted.ip, null);
  assert.equal(redacted.piiRedacted, true);
});

test('audit PII retained for admin with audit.log_pii.r', () => {
  const kept = redactAuditLogForCaller(
    { id: '1', email: 'admin@test.com', ip: '1.2.3.4', action: 'login_success' },
    [PERMISSIONS.AUDIT_LOG_R, PERMISSIONS.AUDIT_LOG_PII_R],
  );
  assert.equal(kept.email, 'admin@test.com');
  assert.equal(kept.piiRedacted, undefined);
});

test('audit export row redacts PII columns', () => {
  const row = redactAuditExportRow(
    { Email: 'a@b.com', IP: '9.9.9.9', Action: 'login' },
    [PERMISSIONS.AUDIT_LOG_R],
  );
  assert.equal(row.Email, 'Redacted');
  assert.equal(row.IP, 'Redacted');
});
