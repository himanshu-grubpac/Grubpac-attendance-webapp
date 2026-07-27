import { SYSTEM_ROLE_SLUGS, legacyRoleFromSlug } from '../../../shared/permissions.js';
import { escapeRegex } from '../../../shared/utils/escapeRegex.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { Department } from '../models/Department.js';

export { legacyRoleFromSlug };

export async function resolveDepartment(parsed) {
  if (parsed.departmentId) {
    const department = await Department.findById(parsed.departmentId);
    if (!department || !department.isActive) {
      const error = new Error('Department not found.');
      error.statusCode = 400;
      throw error;
    }
    return department;
  }

  if (parsed.department) {
    const department = await Department.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(parsed.department)}$`, 'i') },
      isActive: true,
    });
    if (department) return department;
  }

  return null;
}

export async function resolveReportingManager(reportingManagerId, excludeUserId = null) {
  if (!reportingManagerId) return null;

  const manager = await User.findById(reportingManagerId).populate('roleId');
  if (!manager || !manager.isActive) {
    const error = new Error('Reporting manager not found.');
    error.statusCode = 400;
    throw error;
  }

  if (excludeUserId && manager._id.toString() === excludeUserId.toString()) {
    const error = new Error('User cannot be their own reporting manager.');
    error.statusCode = 400;
    throw error;
  }

  return manager;
}

export async function resolveDelegateApprover(delegateApproverId, excludeUserId = null) {
  if (!delegateApproverId) return null;

  const delegate = await User.findById(delegateApproverId);
  if (!delegate || !delegate.isActive) {
    const error = new Error('Delegate approver not found.');
    error.statusCode = 400;
    throw error;
  }

  if (excludeUserId && delegate._id.toString() === excludeUserId.toString()) {
    const error = new Error('User cannot delegate approval to themselves.');
    error.statusCode = 400;
    throw error;
  }

  return delegate;
}

export async function resolveRole(roleId) {
  const role = roleId
    ? await Role.findById(roleId)
    : await Role.findOne({ slug: SYSTEM_ROLE_SLUGS.EMPLOYEE });
  if (!role) {
    const error = new Error('Role not found.');
    error.statusCode = 400;
    throw error;
  }
  return role;
}

export async function resolveManagedDepartments(departmentIds = []) {
  if (!departmentIds?.length) {
    return [];
  }

  const uniqueIds = [...new Set(departmentIds.map(String))];
  const departments = await Department.find({
    _id: { $in: uniqueIds },
    isActive: true,
  }).select('_id');

  if (departments.length !== uniqueIds.length) {
    const error = new Error('One or more managed departments were not found.');
    error.statusCode = 400;
    throw error;
  }

  return departments.map((department) => department._id);
}
