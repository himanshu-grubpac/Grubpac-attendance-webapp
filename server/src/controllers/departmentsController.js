import { Department } from '../models/Department.js';
import { User } from '../models/User.js';
import {
  createDepartmentSchema,
  updateDepartmentSchema,
} from '../../../shared/validation/departments.js';
import { auditLog } from '../utils/auditLog.js';

export async function listDepartments(req, res) {
  const departments = await Department.find()
    .populate('leadUserId', 'name email')
    .populate('deputyUserId', 'name email')
    .sort({ name: 1 });
  res.json({ departments: departments.map((dept) => dept.toSafeJSON()) });
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

  auditLog('department_created', {
    adminId: req.user._id.toString(),
    departmentId: department._id.toString(),
    code: department.code,
    name: department.name,
    leadUserId: department.leadUserId?.toString() || null, 
    deputyUserId: department.deputyUserId?.toString() || null,
  });

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

  if (parsed.name !== undefined) department.name = parsed.name;
  if (parsed.code !== undefined) department.code = parsed.code;
  if (parsed.isActive !== undefined) department.isActive = parsed.isActive;
  if (parsed.leadUserId !== undefined) department.leadUserId = parsed.leadUserId;
  if (parsed.deputyUserId !== undefined) department.deputyUserId = parsed.deputyUserId;

  await department.save();

  auditLog('department_updated', {
    adminId: req.user._id.toString(),
    departmentId: department._id.toString(),
    previous,
    next: {
      name: department.name,
      code: department.code,
      isActive: department.isActive,
    },
  });

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

  auditLog('department_deleted', {
    adminId: req.user._id.toString(),
    departmentId: department._id.toString(),
    code: department.code,
  });

  res.json({ message: 'Department deleted successfully.' });
}
