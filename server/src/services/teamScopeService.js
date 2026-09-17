import { hasPermission } from '../../../shared/permissions.js';
import { User } from '../models/User.js';

/**
 * Returns null when unscoped (read-all), [] when team scope applies but no employees match,
 * or an array of user ObjectIds.
 *
 * Team visibility = DIRECT REPORTS + DELEGATE CHAIN ONLY — the exact same
 * membership as the leave approval queue. Managed departments deliberately do
 * NOT widen visibility anywhere: an RM sees precisely the people under them
 * (dashboard, employee list, attendance, today strip, salary audit), no more.
 * (The `managedDepartmentIds` field stays stored for org records; single-record
 * salary checks may still consult it, but no listing does.)
 */
export async function resolveTeamScopedUserIds(
  actor,
  permissions,
  readAllPermission,
  readTeamPermission,
) {
  if (hasPermission(permissions, readAllPermission)) {
    return null;
  }
  if (!hasPermission(permissions, readTeamPermission) || !actor?._id) {
    return [];
  }

  return resolveLeaveApprovalUserIds(actor);
}

export async function applyTeamScopeToEmployeeQuery(
  query,
  actor,
  permissions,
  readAllPermission,
  readTeamPermission,
) {
  if (hasPermission(permissions, readAllPermission)) {
    return query;
  }
  if (!hasPermission(permissions, readTeamPermission) || !actor?._id) {
    return query;
  }

  const scopedIds = await resolveLeaveApprovalUserIds(actor);
  query._id = { $in: scopedIds };
  return query;
}

export async function isUserInTeamScope(
  actor,
  permissions,
  targetUserId,
  readAllPermission,
  readTeamPermission,
) {
  if (hasPermission(permissions, readAllPermission)) {
    return true;
  }
  if (!hasPermission(permissions, readTeamPermission)) {
    return false;
  }
  const scopedIds = await resolveTeamScopedUserIds(
    actor,
    permissions,
    readAllPermission,
    readTeamPermission,
  );
  if (scopedIds === null) {
    return true;
  }
  return scopedIds.some((id) => id.toString() === String(targetUserId));
}

/**
 * Leave visibility scope: direct reports + delegate chain ONLY.
 * Managed departments deliberately do NOT widen leave visibility — a
 * reporting manager sees leave requests of employees under them and nobody
 * else. (The generic team-scope resolvers above now share this exact
 * membership, so every page agrees on who "the team" is.)
 */
export async function resolveLeaveApprovalUserIds(actor) {
  const directReports = await User.find({ reportingManagerId: actor._id, isActive: true }).select('_id');
  const delegatedManagers = await User.find({ delegateApproverId: actor._id, isActive: true }).select('_id');
  const managerIds = delegatedManagers.map((item) => item._id);
  const delegatedReports =
    managerIds.length > 0
      ? await User.find({ reportingManagerId: { $in: managerIds }, isActive: true }).select('_id')
      : [];
  return [
    ...directReports.map((item) => item._id),
    ...delegatedReports.map((item) => item._id),
  ];
}

/**
 * Team-scope (all statuses) user set for leave reads. Identical membership
 * to the approvals scope: direct reports + delegate chain, never managed
 * departments. Separate name so call sites read by intent.
 */
export async function resolveLeaveTeamUserIds(actor) {
  return resolveLeaveApprovalUserIds(actor);
}
