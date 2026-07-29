import { SYSTEM_ROLE_SLUGS, legacyRoleFromSlug } from '../../../shared/permissions.js';
import { escapeRegex } from '../../../shared/utils/escapeRegex.js';
import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { Department } from '../models/Department.js';
import { normalizeEmployeeCode } from './employeeCodeService.js';

export { legacyRoleFromSlug };

const MANAGER_ROLE_SLUGS = [
  SYSTEM_ROLE_SLUGS.ADMIN,
  SYSTEM_ROLE_SLUGS.HR,
  SYSTEM_ROLE_SLUGS.REPORTING_MANAGER,
];

async function managerRoleIds() {
  const roles = await Role.find({ slug: { $in: MANAGER_ROLE_SLUGS } }).select('_id');
  return roles.map((role) => role._id);
}

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

export async function resolveReportingManagerByEmailOrCode(email, employeeCode) {
  const roleIds = await managerRoleIds();
  const normalizedEmail = String(email ?? '')
    .trim()
    .toLowerCase();
  const normalizedCode = normalizeEmployeeCode(employeeCode);
  const baseQuery = { isActive: true, roleId: { $in: roleIds } };

  if (normalizedEmail) {
    const manager = await User.findOne({ ...baseQuery, email: normalizedEmail });
    if (manager) return manager;
  }

  if (normalizedCode) {
    const manager = await User.findOne({ ...baseQuery, employeeCode: normalizedCode });
    if (manager) return manager;
  }

  return null;
}

/** Resolve department name and reporting manager email/code to IDs before schema validation. */
export async function prepareEmployeeReferences(data, context = {}) {
  const prepared = { ...data };

  if (!prepared.departmentId && prepared.department) {
    const department = await Department.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(prepared.department)}$`, 'i') },
      isActive: true,
    });
    if (!department) {
      const error = new Error(`Department "${prepared.department}" not found.`);
      error.statusCode = 400;
      throw error;
    }
    prepared.departmentId = department._id.toString();
  }

  if (
    !prepared.reportingManagerId
    && (prepared.reportingManagerEmail || prepared.reportingManagerCode)
  ) {
    const manager = await resolveReportingManagerByEmailOrCode(
      prepared.reportingManagerEmail,
      prepared.reportingManagerCode,
    );
    if (!manager) {
      const error = new Error('Reporting manager not found.');
      error.statusCode = 400;
      throw error;
    }
    prepared.reportingManagerId = manager._id.toString();
  }

  return prepared;
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
