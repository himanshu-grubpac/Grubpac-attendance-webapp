import {
  PERMISSIONS,
  canSwitchPortal,
  hasAdminPortalAccess,
  hasCompanyHelpAccess,
  SYSTEM_ROLE_SLUGS,
  hasAnyPermission,
  hasEmployeePortalAccess,
  hasPermission,
} from '@shared/permissions.js';

function hasAllPermissions(userPermissions, permissions = []) {
  return permissions.every((permission) => hasPermission(userPermissions, permission));
}

export function resolveLoginPortal(loginPortal, user) {
  if (loginPortal === 'admin' && hasAdminPortalAccess(user?.permissions)) {
    return loginPortal;
  }
  if (loginPortal === 'employee' && hasEmployeePortalAccess(user?.permissions)) {
    return loginPortal;
  }
  if (hasAdminPortalAccess(user?.permissions)) {
    return 'admin';
  }
  return 'employee';
}

export function getDefaultRoute(user, loginPortal) {
  const portal = resolveLoginPortal(loginPortal, user);
  return portal === 'admin' ? '/admin/dashboard' : '/employee/dashboard';
}

export const NAV_ITEMS = [
  {
    to: '/admin/dashboard',
    label: 'Dashboard',
    icon: '⊞',
    section: 'Overview',
    portal: 'admin',
    permission: PERMISSIONS.DASHBOARD_ADMIN,
  },
  {
    to: '/admin/users',
    label: 'Employee List',
    icon: '☰',
    section: 'Employees',
    portal: 'admin',
    anyPermission: [PERMISSIONS.EMPLOYEES_RECORD_R, PERMISSIONS.EMPLOYEES_STATS_R],
  },
  {
    to: '/admin/users/register',
    label: 'Register Employee',
    icon: '＋',
    section: 'Employees',
    portal: 'admin',
    permission: PERMISSIONS.EMPLOYEES_REGISTER_C,
    teamCreator: true,
  },
  {
    to: '/admin/users/bulk-upload',
    label: 'Bulk Import',
    icon: '⇪',
    section: 'Employees',
    portal: 'admin',
    permission: PERMISSIONS.EMPLOYEES_BULK_UPLOAD_C,
  },
  {
    to: '/admin/salary',
    label: 'Salary Summary',
    icon: '₹',
    section: 'Employees',
    portal: 'admin',
    allPermissions: [PERMISSIONS.SALARY_PAYROLL_R, PERMISSIONS.EMPLOYEES_RECORD_R],
  },
  {
    to: '/admin/salary/lop',
    label: 'Salary Calculation / LOP',
    icon: '₹',
    section: 'Employees',
    portal: 'admin',
    allPermissions: [PERMISSIONS.SALARY_PAYROLL_R, PERMISSIONS.EMPLOYEES_RECORD_R],
  },
  {
    to: '/admin/salary/team',
    label: 'Team Salary Audit',
    icon: '₹',
    section: 'Employees',
    portal: 'admin',
    permission: PERMISSIONS.SALARY_TEAM_AUDIT_R,
  },
  {
    to: '/admin/attendance',
    label: 'Attendance history',
    icon: '◷',
    section: 'Employees',
    portal: 'admin',
    permission: PERMISSIONS.ATTENDANCE_RECORD_R,
  },
  {
    to: '/admin/attendance/today-present',
    label: 'Today present',
    icon: '●',
    section: 'Employees',
    portal: 'admin',
    permission: PERMISSIONS.ATTENDANCE_TODAY_R,
  },
  {
    to: '/admin/audit-logs',
    label: 'Login Logs',
    icon: '⎈',
    section: 'Employees',
    portal: 'admin',
    permission: PERMISSIONS.AUDIT_LOG_R,
  },
  {
    to: '/admin/help/tickets',
    label: 'Help tickets',
    icon: '?',
    section: 'Employees',
    portal: 'admin',
    companyHelpAccess: true,
  },
  {
    to: '/admin/help/team',
    label: 'Team issues',
    icon: '?',
    section: 'Employees',
    portal: 'admin',
    permission: PERMISSIONS.HELP_TICKET_R,
    excludeCompanyHelpAccess: true,
  },
  {
    to: '/admin/leave/policies',
    label: 'Leave policies',
    icon: '⚙',
    section: 'Leaves',
    portal: 'admin',
    permission: PERMISSIONS.LEAVE_POLICY_R,
  },
  {
    to: '/admin/leave/approvals',
    label: 'Pending Requests',
    icon: '✓',
    section: 'Leaves',
    portal: 'admin',
    permission: PERMISSIONS.LEAVE_APPROVE,
    matchPrefixes: ['/admin/leave/approvals', '/admin/leave/comp-off'],
    badge: 'approvals',
  },
  {
    to: '/admin/leave/streaks',
    label: 'Late Warning',
    icon: '⚡',
    section: 'Leaves',
    portal: 'admin',
    permission: PERMISSIONS.ATTENDANCE_LATE_WARNING_R,
  },
  {
    to: '/admin/leave/team-calendar',
    label: 'Calendar management',
    icon: '▣',
    section: 'Leaves',
    portal: 'admin',
    permission: PERMISSIONS.LEAVE_HOLIDAY_R,
  },
  {
    to: '/admin/office-settings',
    label: 'Geolocation & Timings',
    icon: '⌖',
    section: 'Operations',
    portal: 'admin',
    permission: PERMISSIONS.OPS_GEOFENCE_R,
  },
  {
    to: '/admin/faq-demo',
    label: 'FAQ & Demo',
    icon: '❓',
    section: 'Operations',
    portal: 'admin',
    anyPermission: [PERMISSIONS.OPS_FAQ_R, PERMISSIONS.OPS_GUIDE_R],
  },
  {
    to: '/admin/departments',
    label: 'Departments',
    icon: '▦',
    section: 'Operations',
    portal: 'admin',
    permission: PERMISSIONS.OPS_DEPARTMENT_R,
  },
  {
    to: '/admin/roles',
    label: 'Roles & Permissions',
    icon: '⚙',
    section: 'Operations',
    portal: 'admin',
    permission: PERMISSIONS.RBAC_ROLE_R,
  },

  {
    to: '/employee/dashboard',
    label: 'Dashboard',
    icon: '⌂',
    section: 'Overview',
    portal: 'employee',
    permission: PERMISSIONS.EMP_DASHBOARD_R,
  },
  {
    to: '/employee/leave/apply-wfh',
    label: 'Apply WFH',
    icon: '＋',
    section: 'Leave',
    portal: 'employee',
    permission: PERMISSIONS.EMP_WFH_C,
  },
  {
    to: '/employee/leave/apply',
    label: 'Apply leave',
    icon: '＋',
    section: 'Leave',
    portal: 'employee',
    permission: PERMISSIONS.EMP_LEAVE_C,
  },
  {
    to: '/employee/leave/comp-off',
    label: 'Request comp off',
    icon: '◈',
    section: 'Leave',
    portal: 'employee',
    permission: PERMISSIONS.EMP_COMPOFF_C,
  },
  {
    to: '/employee/leave/balances',
    label: 'Leave balances',
    icon: '▤',
    section: 'Leave',
    portal: 'employee',
    permission: PERMISSIONS.EMP_BALANCE_R,
  },
  {
    to: '/employee/leave/requests',
    label: 'My requests',
    icon: '☰',
    section: 'Leave',
    portal: 'employee',
    permission: PERMISSIONS.EMP_REQUESTS_R,
  },
  {
    to: '/employee/history',
    label: 'Attendance history',
    icon: '◷',
    section: 'Attendance',
    portal: 'employee',
    permission: PERMISSIONS.EMP_ATTENDANCE_R,
  },
  {
    to: '/employee/pay-estimate',
    label: 'My pay estimate',
    icon: '₹',
    section: 'Payroll',
    portal: 'employee',
    permission: PERMISSIONS.EMP_PAY_R,
  },
  {
    to: '/employee/faq-demo',
    label: 'FAQ & Demo',
    icon: '❓',
    section: 'Support',
    portal: 'employee',
    permission: PERMISSIONS.EMP_FAQ_R,
  },
  {
    to: '/employee/help',
    label: 'Help',
    icon: '?',
    section: 'Support',
    portal: 'employee',
    permission: PERMISSIONS.EMP_TICKET_C,
  },
];

const ADMIN_USERS_LIST_PATH = '/admin/users';
const ADMIN_ROLES_LIST_PATH = '/admin/roles';

export function resolveNavItemActive(to, { isActive, location }) {
  if (to === ADMIN_USERS_LIST_PATH) {
    const { pathname } = location;
    if (pathname === ADMIN_USERS_LIST_PATH) return true;
    if (!pathname.startsWith(`${ADMIN_USERS_LIST_PATH}/`)) return false;

    const childSegment = pathname.slice(`${ADMIN_USERS_LIST_PATH}/`.length);
    if (!childSegment || childSegment.includes('/')) return false;

    return childSegment !== 'register' && childSegment !== 'bulk-upload';
  }

  if (to === ADMIN_ROLES_LIST_PATH) {
    const { pathname } = location;
    if (pathname === ADMIN_ROLES_LIST_PATH) return true;
    return pathname.startsWith(`${ADMIN_ROLES_LIST_PATH}/`);
  }

  if (to === '/admin/leave/approvals') {
    const { pathname } = location;
    if (pathname === to || pathname.startsWith('/admin/leave/comp-off')) return true;
  }

  return isActive;
}

export function getVisibleNavItems(user, loginPortal) {
  const permissions = user?.permissions ?? [];
  const portal = resolveLoginPortal(loginPortal, user);

  return NAV_ITEMS.filter((item) => {
    if (item.portal && item.portal !== portal) {
      return false;
    }

    if (item.excludeIfAllPermissions?.length && hasAllPermissions(permissions, item.excludeIfAllPermissions)) {
      return false;
    }

    if (item.excludeCompanyHelpAccess && hasCompanyHelpAccess(permissions)) {
      return false;
    }

    if (item.teamCreator && user?.roleSlug === SYSTEM_ROLE_SLUGS.REPORTING_MANAGER) {
      return true;
    }

    if (item.companyHelpAccess) {
      return hasCompanyHelpAccess(permissions);
    }

    if (item.allPermissions?.length) {
      return hasAllPermissions(permissions, item.allPermissions);
    }

    if (item.anyPermission?.length) {
      return hasAnyPermission(permissions, item.anyPermission);
    }

    if (item.permission) {
      return hasPermission(permissions, item.permission);
    }

    return true;
  });
}

const DASHBOARD_PATHS = new Set(['/employee/dashboard', '/admin/dashboard']);

export function isDashboardPath(pathname) {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return DASHBOARD_PATHS.has(normalized);
}

const EMPLOYEE_BOTTOM_NAV = [
  {
    key: 'home',
    to: '/employee/dashboard',
    label: 'Dashboard',
    icon: '⌂',
    matchPrefixes: ['/employee/dashboard'],
  },
  {
    key: 'leave',
    to: '/employee/leave/apply',
    label: 'Leave',
    icon: '▤',
    matchPrefixes: ['/employee/leave'],
    permission: PERMISSIONS.EMP_LEAVE_C,
    fallbackPermission: PERMISSIONS.EMP_BALANCE_R,
    fallbackTo: '/employee/leave/balances',
  },
  {
    key: 'history',
    to: '/employee/history',
    label: 'Attendance history',
    shortLabel: 'History',
    icon: '◷',
    matchPrefixes: ['/employee/history'],
    permission: PERMISSIONS.EMP_ATTENDANCE_R,
  },
  { key: 'more', label: 'Menu', icon: '⋯' },
];

const ADMIN_BOTTOM_NAV = [
  {
    key: 'home',
    to: '/admin/dashboard',
    label: 'Dashboard',
    icon: '⊞',
    matchPrefixes: ['/admin/dashboard'],
    permission: PERMISSIONS.DASHBOARD_ADMIN,
  },
  {
    key: 'approvals',
    to: '/admin/leave/approvals',
    label: 'Pending Requests',
    shortLabel: 'Pending',
    icon: '✓',
    matchPrefixes: ['/admin/leave/approvals', '/admin/leave/comp-off'],
    permission: PERMISSIONS.LEAVE_APPROVE,
    badge: 'approvals',
  },
  {
    key: 'attendance',
    to: '/admin/attendance',
    label: 'Attendance history',
    shortLabel: 'Attendance',
    icon: '◷',
    matchPrefixes: ['/admin/attendance'],
    permission: PERMISSIONS.ATTENDANCE_RECORD_R,
  },
  { key: 'more', label: 'Menu', icon: '⋯' },
];

function navItemAllowed(item, permissions) {
  if (item.excludeIfAllPermissions?.length && hasAllPermissions(permissions, item.excludeIfAllPermissions)) {
    return false;
  }
  if (item.excludeCompanyHelpAccess && hasCompanyHelpAccess(permissions)) {
    return false;
  }
  if (item.companyHelpAccess) {
    return hasCompanyHelpAccess(permissions);
  }
  if (item.allPermissions?.length) {
    return item.allPermissions.every((p) => hasPermission(permissions, p));
  }
  if (item.anyPermission?.length) {
    return hasAnyPermission(permissions, item.anyPermission);
  }
  if (item.permission) {
    return hasPermission(permissions, item.permission);
  }
  return true;
}

export function getBottomNavItems(user, loginPortal) {
  const permissions = user?.permissions ?? [];
  const portal = resolveLoginPortal(loginPortal, user);
  const template = portal === 'admin' ? ADMIN_BOTTOM_NAV : EMPLOYEE_BOTTOM_NAV;

  return template
    .map((item) => {
      if (item.key === 'more') {
        return item;
      }

      if (item.key === 'leave' && item.fallbackPermission) {
        if (!navItemAllowed(item, permissions) && hasPermission(permissions, item.fallbackPermission)) {
          return { ...item, to: item.fallbackTo };
        }
      }

      if (!navItemAllowed(item, permissions)) {
        return null;
      }

      return item;
    })
    .filter(Boolean);
}

export function getMoreNavItems(user, loginPortal) {
  const permissions = user?.permissions ?? [];
  const portal = resolveLoginPortal(loginPortal, user);
  const bottomItems = getBottomNavItems(user, loginPortal);
  const bottomRoutes = new Set(
    bottomItems.filter((item) => item.to).map((item) => item.to),
  );

  const moreLinks = getVisibleNavItems(user, loginPortal).filter((item) => {
    if (bottomRoutes.has(item.to)) {
      return false;
    }
    if (portal === 'admin' && item.to === '/admin/dashboard') {
      return false;
    }
    if (portal === 'employee' && item.to === '/employee/dashboard') {
      return false;
    }
    return true;
  });

  if (portal === 'admin') {
    return moreLinks;
  }

  const priority = [
    '/employee/leave/balances',
    '/employee/leave/requests',
    '/employee/pay-estimate',
    '/employee/faq-demo',
    '/employee/help',
  ];
  const byPath = new Map(moreLinks.map((item) => [item.to, item]));
  const ordered = [];

  for (const path of priority) {
    if (byPath.has(path)) {
      ordered.push(byPath.get(path));
      byPath.delete(path);
    }
  }
  for (const item of moreLinks) {
    if (byPath.has(item.to)) {
      ordered.push(item);
    }
  }

  return ordered;
}

export function resolveBottomNavActive(pathname, bottomItems, moreRoutes = []) {
  const normalized = pathname.replace(/\/+$/, '') || '/';

  for (const item of bottomItems) {
    if (item.key === 'more') continue;
    if (item.matchPrefixes?.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
      return item.key;
    }
  }

  if (
    moreRoutes.some(
      (route) => normalized === route || normalized.startsWith(`${route}/`),
    )
  ) {
    return 'more';
  }

  return null;
}

export function isMoreNavActive(pathname, user, loginPortal) {
  const moreRoutes = getMoreNavItems(user, loginPortal).map((item) => item.to);
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return moreRoutes.some(
    (route) => normalized === route || normalized.startsWith(`${route}/`),
  );
}

export function canAccessRoute(user, {
  permission,
  anyPermission,
  allPermissions,
  excludeIfAllPermissions,
  companyHelpAccess,
  excludeCompanyHelpAccess,
  teamCreator,
} = {}) {
  const permissions = user?.permissions ?? [];
  if (excludeIfAllPermissions?.length && hasAllPermissions(permissions, excludeIfAllPermissions)) {
    return false;
  }
  if (excludeCompanyHelpAccess && hasCompanyHelpAccess(permissions)) {
    return false;
  }
  // teamCreator marks creation surfaces that reporting managers may also
  // use (scoped to their managed departments, enforced server-side).
  if (teamCreator && user?.roleSlug === SYSTEM_ROLE_SLUGS.REPORTING_MANAGER) {
    return true;
  }
  if (companyHelpAccess) {
    return hasCompanyHelpAccess(permissions);
  }
  if (allPermissions?.length) {
    return allPermissions.every((item) => hasPermission(permissions, item));
  }
  if (anyPermission?.length) {
    return hasAnyPermission(permissions, anyPermission);
  }
  if (permission) {
    return hasPermission(permissions, permission);
  }
  return Boolean(user);
}

export function canAccessPortalRoute(user, loginPortal, routePortal) {
  if (!user || !routePortal) return true;
  return resolveLoginPortal(loginPortal, user) === routePortal;
}

export { canSwitchPortal };
