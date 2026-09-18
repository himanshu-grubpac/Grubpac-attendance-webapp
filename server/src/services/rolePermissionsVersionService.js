/** @param {import('../models/Role.js').Role | { permissionsVersion?: number } | null | undefined} role */
export function resolveRolePermissionsVersion(role) {
  return role?.permissionsVersion ?? 1;
}

/** Bump role.permissionsVersion after permission array changes. */
export async function bumpRolePermissionsVersion(role) {
  role.permissionsVersion = resolveRolePermissionsVersion(role) + 1;
  await role.save();
  return role.permissionsVersion;
}

/** @param {string[]|undefined|null} before @param {string[]|undefined|null} after */
export function permissionsArrayChanged(before, after) {
  const a = [...(before ?? [])].sort().join('\0');
  const b = [...(after ?? [])].sort().join('\0');
  return a !== b;
}
