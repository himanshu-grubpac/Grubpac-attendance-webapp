process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLogExportRows } from './adminController.js';

test('export rows mirror the viewer fallbacks instead of blank cells', () => {
  const [legacy, failedLogin] = auditLogExportRows([
    {
      action: 'lop_exported',
      timestamp: new Date('2026-09-16T10:00:00.000Z'),
    },
    {
      action: 'login_failed',
      status: 'failed',
      reason: 'bad_password',
      metadata: { identifier: 'ghost@example.com' },
      timestamp: new Date('2026-09-16T10:01:00.000Z'),
    },
  ]);

  assert.equal(legacy.Email, 'System');
  assert.equal(legacy.Role, 'System');
  assert.equal(legacy.Status, 'UNKNOWN');
  assert.equal(legacy.Reason, 'Not recorded');
  assert.equal(legacy.EntityId, 'n/a');
  assert.equal(legacy.IP, 'Not recorded');
  assert.equal(legacy.DeviceId, 'Not recorded');

  assert.equal(failedLogin.Email, 'ghost@example.com');
  assert.equal(failedLogin.Role, 'Not recorded');
  assert.equal(failedLogin.Status, 'failed');
  assert.equal(failedLogin.Reason, 'bad_password');
});

test('export device cell carries the full owner, browser and OS label', () => {
  const userId = '507f1f77bcf86cd799439011';
  const [row] = auditLogExportRows(
    [
      {
        action: 'login_success',
        status: 'success',
        userId,
        email: 'atul@grubpac.com',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        timestamp: new Date('2026-09-16T10:02:00.000Z'),
      },
    ],
    new Map([[userId, 'Atul']]),
  );

  assert.equal(row.Device, "Atul's Desktop — Chrome / Windows");
});
