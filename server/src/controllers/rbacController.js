import {
  ADMIN_LOCK_SLUGS,
  PERMISSION_CATALOG,
  PERMISSIONS,
  SYSTEM_ROLE_SLUGS,
  buildPermissionMetadataMap,
  enforceAdminLockPermissions,
  getPermissionCatalogTree,
} from '../../../shared/permissions.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import {
  createRoleSchema,
  roleListQuerySchema,
  updateRoleSchema,
} from '../../../shared/validation/roles.js';
import { auditRequest } from '../utils/auditLog.js';
import {
  permissionsArrayChanged,
  resolveRolePermissionsVersion,
} from '../services/rolePermissionsVersionService.js';

export async function getCatalog(req, res) {
  res.json({
    catalog: PERMISSION_CATALOG,
    tree: getPermissionCatalogTree(),
    metadata: Object.fromEntries(buildPermissionMetadataMap()),
    adminLockSlugs: ADMIN_LOCK_SLUGS,
    totalSlugs: buildPermissionMetadataMap().size,
  });
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

  auditRequest(req, 'role_created', {
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

  if (role.isSystem && role.slug === SYSTEM_ROLE_SLUGS.ADMIN && parsed.permissions !== undefined) {
    parsed.permissions = enforceAdminLockPermissions(parsed.permissions);
  }

  if (parsed.permissions !== undefined) {
    const actorRoleId =
      req.user?.roleId?._id?.toString?.() ?? req.user?.roleId?.toString?.() ?? null;
    if (actorRoleId && actorRoleId === role._id.toString()) {
      const removed = (role.permissions ?? []).filter((key) => !parsed.permissions.includes(key));
      if (removed.length > 0) {
        return res.status(403).json({
          message: 'You cannot remove permissions from your own role. Ask another admin to make this change.',
        });
      }
    }
  }

  const previous = {
    name: role.name,
    permissions: [...(role.permissions ?? [])],
  };

  if (parsed.name !== undefined) role.name = parsed.name;
  if (parsed.description !== undefined) role.description = parsed.description;
  if (parsed.permissions !== undefined) {
    const permsChanged = permissionsArrayChanged(role.permissions, parsed.permissions);
    role.permissions = parsed.permissions;
    if (permsChanged) {
      role.permissionsVersion = resolveRolePermissionsVersion(role) + 1;
    }
  }

  await role.save();

  auditRequest(req, 'role_updated', {
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

  auditRequest(req, 'role_deleted', {
    adminId: req.user._id.toString(),
    roleId: role._id.toString(),
    slug: role.slug,
  });

  res.json({ message: 'Role deleted successfully.' });
}

/** List users with role assignment info (rbac.user.r). */
export async function listRbacUsers(req, res) {
  const users = await User.find({ isActive: true })
    .populate('roleId', 'name slug')
    .select('firstName lastName name email employeeCode roleId')
    .sort({ name: 1 })
    .limit(500);
  res.json({
    users: users.map((user) => ({
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      employeeCode: user.employeeCode ?? null,
      roleId: user.roleId?._id?.toString?.() ?? user.roleId?.toString?.() ?? null,
      roleName: user.roleId?.name ?? null,
      roleSlug: user.roleId?.slug ?? null,
    })),
  });
}
