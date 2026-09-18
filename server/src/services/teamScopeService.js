import mongoose from 'mongoose';
import {
  COMPANY_WIDE_SCOPE_SLUG,
  hasCompanyWideScope,
  hasPermission,
} from '../../../shared/permissions.js';
import { Department } from '../models/Department.js';
import { User } from '../models/User.js';

function scopeError(message, statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Team visibility for R / team-bounded permissions (row 15 anchor):
 * direct reports + delegate chain + managed departments + dept lead/deputy.
 * Returns null when company-wide (employees.record.r), [] when no team match,
 * or an array of user ObjectIds.
 */
export async function resolveTeamScopedUserIds(actor, permissions) {
  if (hasCompanyWideScope(permissions)) {
    return null;
  }
  if (!actor?._id) {
    return [];
  }
  return resolveManagedTeamUserIds(actor);
}

export async function applyTeamScopeToEmployeeQuery(query, actor, permissions) {
  if (hasCompanyWideScope(permissions)) {
    return query;
  }
  if (!actor?._id) {
    return query;
  }
  const scopedIds = await resolveManagedTeamUserIds(actor);
  query._id = { $in: scopedIds };
  return query;
}

/** Apply team user-id scope to any User query. Returns query unchanged when company-wide. */
export async function applyTeamScopeToUserIdQuery(query, actor, permissions) {
  const scopedIds = await resolveTeamScopedUserIds(actor, permissions);
  if (scopedIds !== null) {
    query._id = { $in: scopedIds };
  }
  return query;
}

/**
 * Departments the actor may filter or assign: managedDepartmentIds, lead/deputy
 * departments, and own department. Returns null when company-wide.
 */
export async function resolveAccessibleDepartmentIds(actor, permissions) {
  if (hasCompanyWideScope(permissions)) {
    return null;
  }
  if (!actor?._id) {
    return [];
  }

  const deptIdSet = new Set();

  for (const id of actor.managedDepartmentIds ?? []) {
    deptIdSet.add((id._id ?? id).toString());
  }

  const ownDept = actor.departmentId?._id ?? actor.departmentId;
  if (ownDept) {
    deptIdSet.add(ownDept.toString());
  }

  const leadDeputyDepts = await Department.find({
    $or: [{ leadUserId: actor._id }, { deputyUserId: actor._id }],
    isActive: true,
  }).select('_id');

  for (const dept of leadDeputyDepts) {
    deptIdSet.add(dept._id.toString());
  }

  return [...deptIdSet].map((id) => new mongoose.Types.ObjectId(id));
}

export function assertDepartmentFilterAllowed(accessibleDeptIds, departmentId) {
  if (!departmentId || accessibleDeptIds === null) {
    return;
  }
  const target = departmentId.toString();
  const allowed = accessibleDeptIds.some((id) => id.toString() === target);
  if (!allowed) {
    throw scopeError('You do not have access to the selected department.');
  }
}

export async function assertDepartmentInAccessibleSet(actor, permissions, departmentId) {
  if (!departmentId) {
    return;
  }
  const accessible = await resolveAccessibleDepartmentIds(actor, permissions);
  assertDepartmentFilterAllowed(accessible, departmentId);
}

export async function assertManagedDepartmentsAccessible(actor, permissions, managedDepartmentIds) {
  if (!managedDepartmentIds?.length) {
    return;
  }
  const accessible = await resolveAccessibleDepartmentIds(actor, permissions);
  if (accessible === null) {
    return;
  }
  const allowedSet = new Set(accessible.map((id) => id.toString()));
  for (const id of managedDepartmentIds) {
    const deptId = (id._id ?? id).toString();
    if (!allowedSet.has(deptId)) {
      throw scopeError('One or more managed departments are outside your access scope.');
    }
  }
}

export async function isUserInTeamScope(actor, permissions, targetUserId) {
  if (hasCompanyWideScope(permissions)) {
    return true;
  }
  const scopedIds = await resolveTeamScopedUserIds(actor, permissions);
  if (scopedIds === null) {
    return true;
  }
  return scopedIds.some((id) => id.toString() === String(targetUserId));
}

/**
 * Direct reports + delegate chain (leave approval membership).
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

/** Team-scope user set for leave reads — same membership as approvals. */
export async function resolveLeaveTeamUserIds(actor) {
  return resolveLeaveApprovalUserIds(actor);
}

/**
 * Full managed-team membership: direct reports, delegate chain, explicit
 * managedDepartmentIds, and departments where actor is lead or deputy.
 */
export async function resolveManagedTeamUserIds(actor) {
  const idSet = new Set();

  const reportIds = await resolveLeaveApprovalUserIds(actor);
  reportIds.forEach((id) => idSet.add(id.toString()));

  const managedDeptIds = [
    ...(Array.isArray(actor.managedDepartmentIds) ? actor.managedDepartmentIds : []),
  ];

  const leadDeputyDepts = await Department.find({
    $or: [{ leadUserId: actor._id }, { deputyUserId: actor._id }],
    isActive: true,
  }).select('_id');

  for (const dept of leadDeputyDepts) {
    managedDeptIds.push(dept._id);
  }

  const uniqueDeptIds = [...new Set(managedDeptIds.map((id) => id.toString()))];
  if (uniqueDeptIds.length > 0) {
    const deptMembers = await User.find({
      departmentId: { $in: uniqueDeptIds },
      isActive: true,
    }).select('_id');
    deptMembers.forEach((user) => idSet.add(user._id.toString()));
  }

  if (actor?._id) {
    idSet.delete(actor._id.toString());
  }

  return [...idSet].map((id) => id);
}

/**
 * @deprecated Use resolveTeamScopedUserIds(actor, permissions) — kept for gradual migration.
 */
export async function resolveTeamScopedUserIdsLegacy(
  actor,
  permissions,
  readAllPermission,
  readTeamPermission,
) {
  if (hasPermission(permissions, readAllPermission) || hasCompanyWideScope(permissions)) {
    return null;
  }
  if (!hasPermission(permissions, readTeamPermission) && !hasPermission(permissions, COMPANY_WIDE_SCOPE_SLUG)) {
    if (!actor?._id) return [];
    return resolveManagedTeamUserIds(actor);
  }
  if (!actor?._id) return [];
  return resolveManagedTeamUserIds(actor);
}

export async function applyTeamScopeToEmployeeQueryLegacy(
  query,
  actor,
  permissions,
  readAllPermission,
  readTeamPermission,
) {
  if (hasPermission(permissions, readAllPermission) || hasCompanyWideScope(permissions)) {
    return query;
  }
  if (!hasPermission(permissions, readTeamPermission) && !actor?._id) {
    return query;
  }
  const scopedIds = await resolveManagedTeamUserIds(actor);
  query._id = { $in: scopedIds };
  return query;
}

export async function isUserInTeamScopeLegacy(
  actor,
  permissions,
  targetUserId,
  readAllPermission,
  readTeamPermission,
) {
  if (hasPermission(permissions, readAllPermission) || hasCompanyWideScope(permissions)) {
    return true;
  }
  if (!hasPermission(permissions, readTeamPermission)) {
    return false;
  }
  const scopedIds = await resolveTeamScopedUserIdsLegacy(
    actor,
    permissions,
    readAllPermission,
    readTeamPermission,
  );
  if (scopedIds === null) return true;
  return scopedIds.some((id) => id.toString() === String(targetUserId));
}
