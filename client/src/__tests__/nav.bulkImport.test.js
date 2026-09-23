import { describe, it, expect } from 'vitest';
import { buildDefaultRolePermissions, SYSTEM_ROLE_SLUGS } from '@shared/permissions.js';
import { canAccessRoute, getVisibleNavItems } from '../config/nav.js';

const RM_DEFAULTS = buildDefaultRolePermissions()['reporting-manager'];
const RM_USER = {
  roleSlug: SYSTEM_ROLE_SLUGS.REPORTING_MANAGER,
  permissions: RM_DEFAULTS,
};

describe('Bulk Import nav and route access', () => {
  it('hides Bulk Import from Reporting Manager default permissions', () => {
    const items = getVisibleNavItems(RM_USER, 'admin');
    expect(items.some((item) => item.to === '/admin/users/bulk-upload')).toBe(false);
  });

  it('denies bulk-upload route for Reporting Manager default permissions', () => {
    expect(
      canAccessRoute(RM_USER, { permission: 'employees.bulk_upload.c' }),
    ).toBe(false);
  });
});
