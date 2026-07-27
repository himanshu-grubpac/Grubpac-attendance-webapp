import { AuditLog } from '../models/AuditLog.js';
import { logError } from './logger.js';

const LOGIN_ACTIONS = new Set(['login_success', 'login_failed']);
const SENSITIVE_KEYS = new Set(['password', 'passwordHash']);

function buildPersistPayload(action, meta = {}) {
  const safeMeta = { ...meta };
  for (const key of SENSITIVE_KEYS) {
    delete safeMeta[key];
  }

  const {
    userId,
    adminId,
    email,
    role,
    ip,
    deviceId,
    userAgent,
    reason,
    status,
    ...rest
  } = safeMeta;

  const resolvedUserId = userId ?? adminId ?? undefined;
  let resolvedStatus;
  let metadata = Object.keys(rest).length > 0 ? { ...rest } : undefined;

  if (LOGIN_ACTIONS.has(action)) {
    resolvedStatus = status ?? (action === 'login_success' ? 'success' : 'failed');
  } else if (status !== undefined) {
    metadata = { ...(metadata ?? {}), status };
  }

  if (metadata && Object.keys(metadata).length === 0) {
    metadata = undefined;
  }

  return {
    action,
    userId: resolvedUserId || undefined,
    email,
    role,
    ip,
    deviceId: deviceId || undefined,
    userAgent,
    metadata,
    status: resolvedStatus,
    reason,
  };
}

export function getRequestAuditContext(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    req.ip ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined);

  const rawDeviceId = req.body?.deviceId;
  const deviceId =
    typeof rawDeviceId === 'string' && rawDeviceId.trim().length > 0
      ? rawDeviceId.trim()
      : undefined;

  return {
    ip: ip || undefined,
    deviceId,
    userAgent: req.headers['user-agent'] || undefined,
  };
}

export function auditLog(action, meta = {}) {
  const timestamp = new Date();
  console.log(
    JSON.stringify({
      type: 'audit',
      action,
      timestamp: timestamp.toISOString(),
      ...meta,
    }),
  );

  const payload = buildPersistPayload(action, meta);
  AuditLog.create({ ...payload, timestamp }).catch((error) => {
    logError('audit_persist_failed', {
      action,
      error: error.message,
      userId: payload.userId,
    });
  });
}

/** Awaited audit persist for critical mutations when callers need durability. */
export async function auditLogSync(action, meta = {}) {
  const timestamp = new Date();
  console.log(
    JSON.stringify({
      type: 'audit',
      action,
      timestamp: timestamp.toISOString(),
      ...meta,
    }),
  );

  const payload = buildPersistPayload(action, meta);
  await AuditLog.create({ ...payload, timestamp });
}
