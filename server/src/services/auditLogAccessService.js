import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';

const PII_KEYS = ['email', 'ip', 'deviceId', 'userAgent'];

/**
 * Strip login-event PII when caller lacks audit.log_pii.r (catalog row 33).
 */
export function redactAuditLogForCaller(log, permissions) {
  if (hasPermission(permissions, PERMISSIONS.AUDIT_LOG_PII_R)) {
    return log;
  }

  const redacted = { ...log };
  for (const key of PII_KEYS) {
    if (key in redacted) {
      redacted[key] = null;
    }
  }

  if (redacted.metadata && typeof redacted.metadata === 'object') {
    const metadata = { ...redacted.metadata };
    for (const key of ['email', 'ip', 'deviceId', 'userAgent', 'identifier']) {
      if (key in metadata) metadata[key] = null;
    }
    redacted.metadata = metadata;
  }

  redacted.piiRedacted = true;
  return redacted;
}

export function redactAuditExportRow(row, permissions) {
  if (hasPermission(permissions, PERMISSIONS.AUDIT_LOG_PII_R)) {
    return row;
  }
  const redacted = { ...row };
  for (const key of ['Email', 'IP', 'DeviceId', 'UserAgent']) {
    if (key in redacted) redacted[key] = 'Redacted';
  }
  return redacted;
}
