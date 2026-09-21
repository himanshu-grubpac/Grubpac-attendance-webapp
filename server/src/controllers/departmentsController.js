import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import { Department } from '../models/Department.js';
import { User } from '../models/User.js';
import { resolveAccessibleDepartmentIds } from '../services/teamScopeService.js';
import {
  createDepartmentSchema,
  updateDepartmentSchema,
} from '../../../shared/validation/departments.js';
import { auditEntityChange, auditRequest } from '../utils/auditLog.js';

export async function listDepartments(req, res) {
  const permissions = req.userPermissions ?? [];
  const accessibleDeptIds = await resolveAccessibleDepartmentIds(req.user, permissions);

  if (accessibleDeptIds !== null && accessibleDeptIds.length === 0) {
    return res.json({ departments: [] });
  }

  const deptQuery = accessibleDeptIds !== null ? { _id: { $in: accessibleDeptIds } } : {};

  const departments = await Department.find(deptQuery)
    .populate('leadUserId', 'name email')
    .populate('deputyUserId', 'name email')
    .sort({ name: 1 });

  const countMatch =
    accessibleDeptIds !== null
      ? { departmentId: { $in: accessibleDeptIds } }
      : { departmentId: { $ne: null } };

  const counts = await User.aggregate([
    { $match: countMatch },
    { $group: { _id: '$departmentId', count: { $sum: 1 } } },
  ]);
  const countMap = Object.fromEntries(counts.map((c) => [c._id.toString(), c.count]));

  res.json({
    departments: departments.map((dept) => ({
      ...dept.toSafeJSON(),
      employeeCount: countMap[dept._id.toString()] ?? 0,
    })),
  });
}

export async function createDepartment(req, res) {
  const parsed = createDepartmentSchema.parse(req.body);
  const existing = await Department.findOne({
    $or: [{ code: parsed.code }, { name: parsed.name }],
  });

  if (existing) {
    return res.status(409).json({ message: 'Department name or code already exists.' });
  }

  const department = await Department.create({
    ...parsed,
    createdBy: req.user._id,
  });

  auditRequest(req, 'department_created', auditEntityChange({
    adminId: req.user._id.toString(),
    module: 'organization',
    entity: 'Department',
    entityId: department._id.toString(),
    action: 'Create',
    next: {
      code: department.code,
      name: department.name,
      leadUserId: department.leadUserId?.toString() || null,
      deputyUserId: department.deputyUserId?.toString() || null,
    },
  }));

  res.status(201).json({ department: department.toSafeJSON() });
}

export async function updateDepartment(req, res) {
  const parsed = updateDepartmentSchema.parse(req.body);
  const department = await Department.findById(req.params.id);

  if (!department) {
    return res.status(404).json({ message: 'Department not found.' });
  }

  if (parsed.code && parsed.code !== department.code) {
    const codeTaken = await Department.findOne({
      code: parsed.code,
      _id: { $ne: department._id },
    });
    if (codeTaken) {
      return res.status(409).json({ message: 'Department code already exists.' });
    }
  }

  if (parsed.name && parsed.name !== department.name) {
    const nameTaken = await Department.findOne({
      name: parsed.name,
      _id: { $ne: department._id },
    });
    if (nameTaken) {
      return res.status(409).json({ message: 'Department name already exists.' });
    }
  }

  const previous = {
    name: department.name,
    code: department.code,
    isActive: department.isActive,
  };

  const permissions = req.userPermissions ?? [];

  if (parsed.leadUserId !== undefined && String(parsed.leadUserId ?? '') !== String(department.leadUserId ?? '')) {
    if (!hasPermission(permissions, PERMISSIONS.OPS_DEPARTMENT_X0)) {
      return res.status(403).json({ message: 'You do not have permission to assign department lead.' });
    }
  }
  if (parsed.deputyUserId !== undefined && String(parsed.deputyUserId ?? '') !== String(department.deputyUserId ?? '')) {
    if (!hasPermission(permissions, PERMISSIONS.OPS_DEPARTMENT_X1)) {
      return res.status(403).json({ message: 'You do not have permission to assign deputy lead.' });
    }
  }
  if (parsed.isActive !== undefined && parsed.isActive !== department.isActive) {
    if (!hasPermission(permissions, PERMISSIONS.OPS_DEPARTMENT_X2)) {
      return res.status(403).json({ message: 'You do not have permission to activate or deactivate departments.' });
    }
  }

  if (parsed.name !== undefined) department.name = parsed.name;
  if (parsed.code !== undefined) department.code = parsed.code;
  if (parsed.isActive !== undefined) department.isActive = parsed.isActive;
  if (parsed.leadUserId !== undefined) department.leadUserId = parsed.leadUserId;
  if (parsed.deputyUserId !== undefined) department.deputyUserId = parsed.deputyUserId;

  await department.save();

  if (parsed.name && parsed.name !== previous.name) {
    await User.updateMany(
      { departmentId: department._id },
      { $set: { department: department.name } },
    );
  }

  auditRequest(req, 'department_updated', auditEntityChange({
    adminId: req.user._id.toString(),
    module: 'organization',
    entity: 'Department',
    entityId: department._id.toString(),
    action: 'Update',
    previous,
    next: {
      name: department.name,
      code: department.code,
      isActive: department.isActive,
    },
  }));

  res.json({ department: department.toSafeJSON() });
}

export async function deleteDepartment(req, res) {
  const department = await Department.findById(req.params.id);

  if (!department) {
    return res.status(404).json({ message: 'Department not found.' });
  }

  const assignedCount = await User.countDocuments({ departmentId: department._id });
  if (assignedCount > 0) {
    return res.status(400).json({
      message: `Cannot delete department assigned to ${assignedCount} user(s).`,
    });
  }

  await department.deleteOne();

  auditRequest(req, 'department_deleted', auditEntityChange({
    adminId: req.user._id.toString(),
    module: 'organization',
    entity: 'Department',
    entityId: department._id.toString(),
    action: 'Delete',
    previous: { code: department.code, name: department.name },
  }));

  res.json({ message: 'Department deleted successfully.' });
}
