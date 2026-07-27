import mongoose from 'mongoose';
import { hasPermission } from '../../../shared/permissions.js';
import { User } from '../models/User.js';

export async function getActorManagedDepartmentIds(actor) {
  if (!actor?._id) return [];
  if (Array.isArray(actor.managedDepartmentIds) && actor.managedDepartmentIds.length > 0) {
    return actor.managedDepartmentIds.map((id) => id.toString());
  }
  const doc = await User.findById(actor._id).select('managedDepartmentIds').lean();
  return (doc?.managedDepartmentIds ?? []).map((id) => id.toString());
}

/**
 * Returns null when unscoped (read-all), [] when team scope applies but no employees match,
 * or an array of user ObjectIds.
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

  const managedIds = await getActorManagedDepartmentIds(actor);
  if (managedIds.length > 0) {
    const objectIds = managedIds.map((id) => new mongoose.Types.ObjectId(id));
    const users = await User.find({ departmentId: { $in: objectIds }, isActive: true }).select('_id');
    return users.map((user) => user._id);
  }

  const reports = await User.find({ reportingManagerId: actor._id, isActive: true }).select('_id');
  return reports.map((user) => user._id);
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

  const managedIds = await getActorManagedDepartmentIds(actor);
  if (managedIds.length > 0) {
    query.departmentId = {
      $in: managedIds.map((id) => new mongoose.Types.ObjectId(id)),
    };
    return query;
  }

  query.reportingManagerId = actor._id;
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

/** Leave approvals: direct reports + delegate chain, or managed-department employees. */
export async function resolveLeaveApprovalUserIds(actor) {
  const managedIds = await getActorManagedDepartmentIds(actor);
  if (managedIds.length > 0) {
    const objectIds = managedIds.map((id) => new mongoose.Types.ObjectId(id));
    const users = await User.find({ departmentId: { $in: objectIds }, isActive: true }).select('_id');
    return users.map((user) => user._id);
  }

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
