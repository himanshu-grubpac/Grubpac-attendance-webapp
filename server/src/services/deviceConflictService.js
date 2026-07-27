import { AuditLog } from '../models/AuditLog.js';
import { env } from '../config/env.js';

const LOGIN_ACTIONS = new Set(['login_success', 'login_failed']);
const CHECK_IN_ACTION = 'attendance_marked';

export function getDeviceConflictWindowMs() {
  return env.deviceConflictWindowMs;
}

function resolveEventIdentity(log) {
  const userId = log.userId?.toString?.() ?? log.userId ?? null;
  if (userId) {
    return `uid:${userId}`;
  }
  const email = log.email?.toLowerCase?.() ?? log.email ?? null;
  if (email) {
    return `email:${email}`;
  }
  const identifier = log.metadata?.identifier?.toLowerCase?.() ?? log.metadata?.identifier ?? null;
  if (identifier) {
    return `identifier:${identifier}`;
  }
  return null;
}

function isTrackableEvent(log) {
  if (LOGIN_ACTIONS.has(log.action)) return true;
  return log.action === CHECK_IN_ACTION && log.metadata?.type === 'check_in';
}

function withinWindow(leftTime, rightTime, windowMs) {
  return Math.abs(leftTime - rightTime) <= windowMs;
}

function collectConflictReasons(left, right) {
  const reasons = [];
  if (left.deviceId && right.deviceId && left.deviceId === right.deviceId) {
    reasons.push('device');
  }
  if (left.ip && right.ip && left.ip === right.ip) {
    reasons.push('ip');
  }
  return reasons;
}

/** Pure conflict resolver — exported for unit tests. */
export function resolveConflictsForLog(log, candidates, windowMs) {
  const logIdentity = resolveEventIdentity(log);
  if (!logIdentity) {
    return { ipConflict: false, conflictWithUsers: [] };
  }

  const logTime = new Date(log.timestamp).getTime();
  const conflictUsers = new Map();

  for (const other of candidates) {
    const otherId = other._id?.toString?.() ?? other.id ?? null;
    const logId = log._id?.toString?.() ?? log.id ?? null;
    if (otherId && logId && otherId === logId) continue;

    const otherIdentity = resolveEventIdentity(other);
    if (!otherIdentity || otherIdentity === logIdentity) continue;
    if (!withinWindow(logTime, new Date(other.timestamp).getTime(), windowMs)) continue;

    const reasons = collectConflictReasons(log, other);
    if (reasons.length === 0) continue;

    const userKey = otherIdentity;
    const existing = conflictUsers.get(userKey) ?? {
      userId: other.userId?.toString?.() ?? other.userId ?? null,
      email: other.email ?? other.metadata?.identifier ?? null,
      reasons: new Set(),
    };
    for (const reason of reasons) {
      existing.reasons.add(reason);
    }
    conflictUsers.set(userKey, existing);
  }

  const conflictWithUsers = [...conflictUsers.values()].map((entry) => ({
    userId: entry.userId,
    email: entry.email,
    reasons: [...entry.reasons],
  }));

  return {
    ipConflict: conflictWithUsers.length > 0,
    conflictWithUsers,
  };
}

export async function enrichAuditLogsWithConflicts(logs) {
  if (!logs.length) {
    return new Map();
  }

  const windowMs = getDeviceConflictWindowMs();
  const timestamps = logs.map((log) => new Date(log.timestamp).getTime());
  const earliest = new Date(Math.min(...timestamps) - windowMs);
  const latest = new Date(Math.max(...timestamps));

  const candidates = await AuditLog.find({
    timestamp: { $gte: earliest, $lte: latest },
    $or: [
      { action: { $in: [...LOGIN_ACTIONS] } },
      { action: CHECK_IN_ACTION, 'metadata.type': 'check_in' },
    ],
  })
    .select('action userId email ip deviceId timestamp metadata')
    .lean();

  const trackable = candidates.filter(isTrackableEvent);
  const result = new Map();

  for (const log of logs) {
    const logId = log._id.toString();
    result.set(logId, resolveConflictsForLog(log, trackable, windowMs));
  }

  return result;
}
