import mongoose from 'mongoose';
import { SYSTEM_ROLE_SLUGS, hasPermission } from '../../../shared/permissions.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';

/**
 * Returns null when unscoped (read-all), [] when team scope applies but no employees match,
 * or an array of user ObjectIds.
 *
 * Team visibility = DIRECT REPORTS + DELEGATE CHAIN ONLY — the exact same
 * membership as the leave approval queue. Managed departments deliberately do
 * NOT widen visibility in this resolver: an RM sees precisely the people
 * under them (dashboard stats, employee list, attendance history, salary
 * audit), no more. (The `managedDepartmentIds` field stays stored for org
 * records; single-record salary checks may still consult it. The Today
 * Present surfaces apply their own managed-department scope — in-scope
 * reports + self + in-scope same-role peers — inside
 * getTeamTodayStatusService, but no teamScopeService listing does.)
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

/** Managed department ids of the actor (org record, kept current on read). */
export async function getActorManagedDepartmentIds(actor) {
  if (!actor?._id) return [];
  if (Array.isArray(actor.managedDepartmentIds) && actor.managedDepartmentIds.length > 0) {
    return actor.managedDepartmentIds.map((id) => id.toString());
  }
  const doc = await User.findById(actor._id).select('managedDepartmentIds').lean();
  return (doc?.managedDepartmentIds ?? []).map((id) => id.toString());
}

/**
 * Roster visibility for team-scoped listings (Employee List directory/stats,
 * team-today strip, adjustment grid): everyone in the actor's managed
 * departments, plus direct reports + delegate chain, plus the actor themself,
 * plus fellow reporting managers. All statuses — the directory TOTAL counts
 * inactive members too, and boards render them distinctly.
 *
 * Deliberately WIDER than resolveTeamScopedUserIds: that function gates
 * authority (approvals, confirmations, corrections) and must stay narrow so
 * an RM can never approve their own or a fellow RM's items. Visibility is
 * wider than authority by design — seeing a row never grants acting on it.
 */
export async function resolveTeamRosterIds(actor, permissions, readAllPermission, readTeamPermission) {
  if (hasPermission(permissions, readAllPermission)) {
    return null;
  }
  if (!hasPermission(permissions, readTeamPermission) || !actor?._id) {
    return [];
  }
  const seen = new Set();
  const roster = [];
  const add = (id) => {
    if (!id) return;
    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);
    roster.push(id);
  };

  // Managed departments (all statuses).
  const managedIds = (await getActorManagedDepartmentIds(actor))
    .filter((id) => mongoose.isValidObjectId(id));
  if (managedIds.length > 0) {
    const members = await User.find({
      departmentId: { $in: managedIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).select('_id').lean();
    for (const member of members) add(member._id);
  }

  // Direct reports + delegate chain (all statuses).
  const directReports = await User.find({ reportingManagerId: actor._id }).select('_id').lean();
  for (const report of directReports) add(report._id);
  const delegatedManagers = await User.find({ delegateApproverId: actor._id }).select('_id').lean();
  const delegateIds = delegatedManagers.map((manager) => manager._id);
  if (delegateIds.length > 0) {
    const delegatedReports = await User.find({ reportingManagerId: { $in: delegateIds } }).select('_id').lean();
    for (const report of delegatedReports) add(report._id);
  }

  // Self: an RM always sees themself in listings.
  add(actor._id);

  // Fellow reporting managers, org-wide.
  const rmRole = await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.REPORTING_MANAGER }).select('_id').lean();
  if (rmRole) {
    const fellowRms = await User.find({ roleId: rmRole._id }).select('_id').lean();
    for (const rm of fellowRms) add(rm._id);
  }

  return roster;
}

/**
 * Read-visibility check for single records (e.g. employee detail): true when
 * the actor may SEE the target. Built on the wide roster (managed + reports
 * + self + fellow RMs), NOT on the narrow authority scope — viewing never
 * implies acting. Mutations keep using isUserInTeamScope.
 */
export async function isUserVisibleToActor(actor, permissions, targetUserId, readAllPermission, readTeamPermission) {
  if (hasPermission(permissions, readAllPermission)) return true;
  if (!targetUserId || !actor?._id) return false;
  const rosterIds = await resolveTeamRosterIds(actor, permissions, readAllPermission, readTeamPermission);
  if (rosterIds === null) return true;
  return rosterIds.some((id) => String(id) === String(targetUserId));
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

  // Visibility roster (managed + reports + self + fellow RMs) — wider than
  // the authority scope on purpose (see resolveTeamRosterIds).
  const scopedIds = await resolveTeamRosterIds(actor, permissions, readAllPermission, readTeamPermission);
  if (scopedIds === null) return query;
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
