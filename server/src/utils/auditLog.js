import { AuditLog } from '../models/AuditLog.js';
import { User } from '../models/User.js';
import { logError } from './logger.js';

const LOGIN_ACTIONS = new Set(['login_success', 'login_failed']);
// Never persist secrets or credential-adjacent values inside audit metadata.
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'pin',
  'pin4Hash',
  'currentPin',
  'newPin',
  'confirmPin',
  'currentPassword',
  'newPassword',
  'confirmPassword',
  'generatedPassword',
  'token',
  'csrfToken',
]);

export function buildPersistPayload(action, meta = {}) {
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
    entityType,
    entityId,
    fieldChanged,
    oldValue,
    newValue,
    actionType,
    ...rest
  } = safeMeta;

  const resolvedUserId = userId ?? adminId ?? undefined;
  let resolvedStatus;
  let resolvedReason = reason;
  let metadata = Object.keys(rest).length > 0 ? { ...rest } : undefined;

  // Top-level `status` is an enum (success/failed). Callers may also pass a
  // DOMAIN status (ticket/leave/request state) under the same key — that must
  // stay in metadata only, otherwise AuditLog validation rejects the write
  // and the audit row is silently dropped (audit_persist_failed).
  const isAuditStatus = status === 'success' || status === 'failed';
  if (LOGIN_ACTIONS.has(action)) {
    resolvedStatus = isAuditStatus ? status : action === 'login_success' ? 'success' : 'failed';
    if (!isAuditStatus && status !== undefined) {
      metadata = { ...(metadata ?? {}), status };
    }
  } else if (isAuditStatus) {
    metadata = { ...(metadata ?? {}), status };
    resolvedStatus = status;
  } else {
    // Non-login actions always carry a top-level status so the column is
    // never empty; explicit values still win.
    if (status !== undefined) {
      metadata = { ...(metadata ?? {}), status };
    }
    resolvedStatus = 'success';
  }

  // Reason is never left empty: failures without one are flagged as
  // unspecified (a real logging gap), successes record n/a.
  if (resolvedReason === undefined || resolvedReason === null || resolvedReason === '') {
    resolvedReason = resolvedStatus === 'failed' ? 'unspecified' : 'n/a';
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
    reason: resolvedReason,
    entityType: entityType || undefined,
    entityId: entityId || undefined,
    fieldChanged: fieldChanged || undefined,
    oldValue: oldValue !== undefined ? oldValue : undefined,
    newValue: newValue !== undefined ? newValue : undefined,
    actionType: actionType || undefined,
  };
}

export function getRequestAuditContext(req) {
  if (!req) return {};
  const forwarded = req.headers?.['x-forwarded-for'];
  const ip =
    req.ip ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined);

  // Body fingerprint (login/check-in) or the X-Device-Id header the web
  // client attaches to every request — either identifies the device.
  const rawDeviceId = req.body?.deviceId ?? req.headers?.['x-device-id'];
  const deviceId =
    typeof rawDeviceId === 'string' && rawDeviceId.trim().length > 0
      ? rawDeviceId.trim()
      : undefined;

  return {
    ip: ip || undefined,
    deviceId,
    userAgent: req.headers?.['user-agent'] || undefined,
  };
}

/**
 * In-flight fire-and-forget audit persists. Tracked so orderly shutdown
 * (tests, scripts) can drain them via flushAuditLogs() before disconnecting
 * the database. Request paths are unaffected — auditLog() still returns
 * synchronously without awaiting the write.
 */
const pendingAuditPersists = new Set();

function stripSensitiveKeys(meta) {
  const safe = { ...meta };
  for (const key of SENSITIVE_KEYS) {
    delete safe[key];
  }
  return safe;
}

/**
 * Best-effort backfill of actor identity. Controllers should pass email/role
 * explicitly (see auditRequest), but any call that only knows the user id
 * still ends up with a complete actor record.
 */
async function backfillActorIdentity(doc, payload) {
  if (!doc || !payload.userId || (payload.email && payload.role)) return;
  try {
    const user = await User.findById(payload.userId).select('email role').lean();
    if (!user) return;
    const patch = {};
    if (!payload.email && user.email) patch.email = user.email;
    if (!payload.role && user.role) patch.role = user.role;
    if (Object.keys(patch).length > 0) {
      await AuditLog.updateOne({ _id: doc._id }, { $set: patch });
    }
  } catch {
    // Identity backfill must never break the request path.
  }
}

async function persistAuditLog(action, meta, timestamp) {
  const payload = buildPersistPayload(action, meta);
  try {
    const doc = await AuditLog.create({ ...payload, timestamp });
    await backfillActorIdentity(doc, payload);
  } catch (error) {
    logError('audit_persist_failed', {
      action,
      error: error.message,
      userId: payload.userId,
    });
  }
}

export function auditLog(action, meta = {}) {
  const timestamp = new Date();
  const safeForLog = stripSensitiveKeys(meta);
  console.log(
    JSON.stringify({
      type: 'audit',
      action,
      timestamp: timestamp.toISOString(),
      ...safeForLog,
    }),
  );

  const pending = persistAuditLog(action, meta, timestamp).finally(() => {
    pendingAuditPersists.delete(pending);
  });
  pendingAuditPersists.add(pending);
}

/**
 * Wait for all in-flight audit persists to settle. Never throws
 * (individual failures are already logged by auditLog). Intended for
 * orderly shutdown before database disconnect — NOT for request paths.
 */
export async function flushAuditLogs() {
  await Promise.allSettled([...pendingAuditPersists]);
}

/**
 * Standard entity-mutation payload. Every important create/update/delete
 * should log: who (actor), when (automatic), what module/entity, which
 * record, what changed (previous → next), and what action was performed.
 *
 * Usage: auditLog('leave_policy_updated', auditEntityChange({
 *   adminId, module: 'leave', entity: 'LeavePolicy', entityId,
 *   action: 'Update', previous, next,
 * }));
 */
export function auditEntityChange({
  adminId,
  userId,
  module,
  entity,
  entityId,
  action,
  previous,
  next,
  ...rest
} = {}) {
  return {
    ...(adminId ? { adminId } : {}),
    ...(userId ? { userId } : {}),
    ...(module ? { module } : {}),
    ...(entity ? { entity } : {}),
    ...(entityId ? { entityId } : {}),
    ...(action ? { entityAction: action } : {}),
    ...(previous !== undefined ? { previous } : {}),
    ...(next !== undefined ? { next } : {}),
    ...rest,
  };
}

/** Awaited request-scoped variant (see auditRequest). */
export async function auditRequestSync(req, action, meta = {}) {
  const user = req?.user;
  return auditLogSync(action, {
    ...getRequestAuditContext(req),
    ...(user?._id ? { adminId: user._id.toString() } : {}),
    ...(user?.email ? { email: user.email } : {}),
    ...(user?.role ? { role: user.role } : {}),
    ...meta,
  });
}

/** Awaited audit persist for critical mutations when callers need durability. */
export async function auditLogSync(action, meta = {}) {
  const timestamp = new Date();
  const safeForLog = stripSensitiveKeys(meta);
  console.log(
    JSON.stringify({
      type: 'audit',
      action,
      timestamp: timestamp.toISOString(),
      ...safeForLog,
    }),
  );

  await persistAuditLog(action, meta, timestamp);
}

/**
 * Request-scoped audit helper for controllers. Merges IP/device/user-agent
 * plus the actor's email/role automatically — explicit meta fields win.
 * Prefer this over bare auditLog() in every HTTP handler.
 */
export function auditRequest(req, action, meta = {}) {
  const user = req?.user;
  return auditLog(action, {
    ...getRequestAuditContext(req),
    ...(user?._id ? { adminId: user._id.toString() } : {}),
    ...(user?.email ? { email: user.email } : {}),
    ...(user?.role ? { role: user.role } : {}),
    ...meta,
  });
}
