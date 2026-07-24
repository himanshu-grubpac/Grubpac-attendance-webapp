import { PERMISSION_GROUPS } from '../../../shared/permissions.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import {
  createRoleSchema,
  roleListQuerySchema,
  updateRoleSchema,
} from '../../../shared/validation/roles.js';
import { auditLog } from '../utils/auditLog.js';

export async function listPermissions(req, res) {
  res.json({ groups: PERMISSION_GROUPS });
}

export async function listRoles(req, res) {
  const { includeSystem } = roleListQuerySchema.parse(req.query);
  const query = includeSystem ? {} : { isSystem: false };
  const roles = await Role.find(query).sort({ isSystem: -1, name: 1 });
  res.json({ roles: roles.map((role) => role.toSafeJSON()) });
}

export async function createRole(req, res) {
  const parsed = createRoleSchema.parse(req.body);
  const existing = await Role.findOne({ slug: parsed.slug });
  if (existing) {
    return res.status(409).json({ message: 'A role with this slug already exists.' });
  }

  const role = await Role.create({
    ...parsed,
    isSystem: false,
    createdBy: req.user._id,
  });

  auditLog('role_created', {
    adminId: req.user._id.toString(),
    roleId: role._id.toString(),
    slug: role.slug,
    permissions: role.permissions,
  });

  res.status(201).json({ role: role.toSafeJSON() });
}

export async function updateRole(req, res) {
  const parsed = updateRoleSchema.parse(req.body);
  const role = await Role.findById(req.params.id);

  if (!role) {
    return res.status(404).json({ message: 'Role not found.' });
  }

  const previous = {
    name: role.name,
    permissions: [...(role.permissions ?? [])],
  };

  if (parsed.name !== undefined) role.name = parsed.name;
  if (parsed.description !== undefined) role.description = parsed.description;
  if (parsed.permissions !== undefined) role.permissions = parsed.permissions;

  await role.save();

  auditLog('role_updated', {
    adminId: req.user._id.toString(),
    roleId: role._id.toString(),
    slug: role.slug,
    isSystem: role.isSystem,
    previous,
    next: {
      name: role.name,
      permissions: role.permissions,
    },
  });

  res.json({ role: role.toSafeJSON() });
}

export async function deleteRole(req, res) {
  const role = await Role.findById(req.params.id);

  if (!role) {
    return res.status(404).json({ message: 'Role not found.' });
  }

  if (role.isSystem) {
    return res.status(400).json({ message: 'System roles cannot be deleted.' });
  }

  const assignedCount = await User.countDocuments({ roleId: role._id });
  if (assignedCount > 0) {
    return res.status(400).json({
      message: `Cannot delete role assigned to ${assignedCount} user(s). Reassign them first.`,
    });
  }

  await role.deleteOne();

  auditLog('role_deleted', {
    adminId: req.user._id.toString(),
    roleId: role._id.toString(),
    slug: role.slug,
  });

  res.json({ message: 'Role deleted successfully.' });
}
