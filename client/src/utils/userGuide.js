import {
  ADMIN_PORTAL_PERMISSIONS,
  PERMISSIONS,
  SYSTEM_ROLE_SLUGS,
  hasAnyPermission,
} from '@shared/permissions.js';

export const USER_GUIDE_PATHS = {
  admin: '/guides/admin-guide.html',
  deptHead: '/guides/dept-head-guide.html',
  reportingManager: '/guides/reporting-manager-guide.html',
  employee: '/guides/employee-guide.html',
};

const GUIDE_META = {
  admin: {
    path: USER_GUIDE_PATHS.admin,
    label: 'Admin User Guide',
    roleLabel: 'Admin',
  },
  hr: {
    path: USER_GUIDE_PATHS.admin,
    label: 'Admin & HR User Guide',
    roleLabel: 'HR',
  },
  deptHead: {
    path: USER_GUIDE_PATHS.deptHead,
    label: 'Department Head User Guide',
    roleLabel: 'Department Head',
  },
  reportingManager: {
    path: USER_GUIDE_PATHS.reportingManager,
    label: 'Reporting Manager User Guide',
    roleLabel: 'Reporting Manager',
  },
  employee: {
    path: USER_GUIDE_PATHS.employee,
    label: 'Employee User Guide',
    roleLabel: 'Employee',
  },
};

function isDeptHead(user) {
  const managed = user?.managedDepartmentIds ?? [];
  return managed.length > 0;
}

/**
 * Primary role-based user guide for the current portal session.
 */
export function resolveUserGuide(user, loginPortal) {
  const onAdminPortal =
    loginPortal === 'admin' &&
    hasAnyPermission(user?.permissions ?? [], ADMIN_PORTAL_PERMISSIONS);

  if (!onAdminPortal) {
    return { key: 'employee', ...GUIDE_META.employee };
  }

  const slug = user?.roleSlug;

  if (slug === SYSTEM_ROLE_SLUGS.ADMIN) {
    return { key: 'admin', ...GUIDE_META.admin };
  }

  if (slug === SYSTEM_ROLE_SLUGS.HR) {
    return { key: 'hr', ...GUIDE_META.hr };
  }

  if (slug === SYSTEM_ROLE_SLUGS.REPORTING_MANAGER || hasAnyPermission(user?.permissions, [PERMISSIONS.LEAVE_APPROVE])) {
    if (isDeptHead(user)) {
      return { key: 'deptHead', ...GUIDE_META.deptHead };
    }
    return { key: 'reportingManager', ...GUIDE_META.reportingManager };
  }

  return { key: 'admin', ...GUIDE_META.admin };
}

/**
 * Guide links to show on Help / FAQ pages. Dept heads also get the reporting-manager guide.
 */
export function resolveUserGuideLinks(user, loginPortal) {
  const primary = resolveUserGuide(user, loginPortal);
  const links = [primary];

  if (primary.key === 'deptHead') {
    links.push({
      key: 'reportingManager',
      ...GUIDE_META.reportingManager,
      label: 'Reporting Manager Guide (direct reports)',
    });
  }

  return links;
}
