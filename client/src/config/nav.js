import {
  ADMIN_PORTAL_PERMISSIONS,
  PERMISSIONS,
  hasAnyPermission,
  hasPermission,
} from '@shared/permissions.js';

function hasAllPermissions(userPermissions, permissions = []) {
  return permissions.every((permission) => hasPermission(userPermissions, permission));
}

export function resolveLoginPortal(loginPortal, user) {
  if (loginPortal === 'admin' || loginPortal === 'employee') {
    return loginPortal;
  }
  if (hasAnyPermission(user?.permissions, ADMIN_PORTAL_PERMISSIONS)) {
    return 'admin';
  }
  return 'employee';
}

export function getDefaultRoute(user, loginPortal) {
  const portal = resolveLoginPortal(loginPortal, user);
  return portal === 'admin' ? '/admin/dashboard' : '/employee/dashboard';
}

/**
 * Sidebar / drawer nav items.
 * Admin portal: Mohit Sir IA only (Account lives in sidebar footer, not here).
 * Employee portal: self-service items only (Account lives in sidebar footer).
 */
export const NAV_ITEMS = [
  // ── Admin portal (Overview → Employees → Leaves → Operations) ──
  {
    to: '/admin/dashboard',
    label: 'Dashboard',
    icon: '⊞',
    section: 'Overview',
    portal: 'admin',
    permission: PERMISSIONS.USERS_READ,
  },
  {
    to: '/admin/users',
    label: 'Employee List',
    icon: '☰',
    section: 'Employees',
    portal: 'admin',
    permission: PERMISSIONS.USERS_READ,
  },
  {
    to: '/admin/users/register',
    label: 'Register Employee',
    icon: '＋',
    section: 'Employees',
    portal: 'admin',
    permission: PERMISSIONS.USERS_WRITE,
  },
  {
    to: '/admin/users/bulk-upload',
    label: 'Bulk Import',
    icon: '⇪',
    section: 'Employees',
    portal: 'admin',
    permission: PERMISSIONS.USERS_WRITE,
  },
  {
    to: '/admin/salary',
    label: 'Salary Summary',
    icon: '₹',
    section: 'Employees',
    portal: 'admin',
    allPermissions: [PERMISSIONS.SALARY_READ, PERMISSIONS.USERS_READ],
  },
  {
    to: '/admin/attendance',
    label: 'Attendance history',
    icon: '◷',
    section: 'Employees',
    portal: 'admin',
    anyPermission: [PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM],
  },
  {
    to: '/admin/audit-logs',
    label: 'Login Logs',
    icon: '⎈',
    section: 'Employees',
    portal: 'admin',
    permission: PERMISSIONS.AUDIT_READ,
  },
  {
    to: '/admin/help/tickets',
    label: 'Help tickets',
    icon: '?',
    section: 'Employees',
    portal: 'admin',
    allPermissions: [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE],
  },
  {
    to: '/admin/leave/policies',
    label: 'Leave policies',
    icon: '⚙',
    section: 'Leaves',
    portal: 'admin',
    permission: PERMISSIONS.LEAVE_MANAGE_POLICIES,
  },
  {
    to: '/admin/leave/approvals',
    label: 'Pending Requests',
    icon: '✓',
    section: 'Leaves',
    portal: 'admin',
    permission: PERMISSIONS.LEAVE_APPROVE,
  },
  {
    to: '/admin/leave/streaks',
    label: 'Streaks',
    icon: '⚡',
    section: 'Leaves',
    portal: 'admin',
    anyPermission: [PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM],
  },
  {
    to: '/admin/leave/team-calendar',
    label: 'Calendar management',
    icon: '▣',
    section: 'Leaves',
    portal: 'admin',
    permission: PERMISSIONS.LEAVE_MANAGE_POLICIES,
  },
  {
    to: '/admin/office-settings',
    label: 'Geolocation & Timings',
    icon: '⌖',
    section: 'Operations',
    portal: 'admin',
    permission: PERMISSIONS.OFFICE_MANAGE,
  },
  {
    to: '/admin/departments',
    label: 'Departments',
    icon: '▦',
    section: 'Operations',
    portal: 'admin',
    permission: PERMISSIONS.DEPARTMENTS_MANAGE,
  },
  {
    to: '/admin/roles',
    label: 'Roles & Permissions',
    icon: '⚙',
    section: 'Operations',
    portal: 'admin',
    permission: PERMISSIONS.ROLES_MANAGE,
  },

  // ── Employee portal ──
  {
    to: '/employee/dashboard',
    label: 'Dashboard',
    icon: '⌂',
    section: 'Overview',
    portal: 'employee',
    permission: PERMISSIONS.ATTENDANCE_READ_OWN,
  },
  {
    to: '/employee/leave/apply',
    label: 'Apply leave / WFH',
    icon: '＋',
    section: 'Leave',
    portal: 'employee',
    permission: PERMISSIONS.LEAVE_APPLY,
  },
  {
    to: '/employee/leave/balances',
    label: 'Leave balances',
    icon: '▤',
    section: 'Leave',
    portal: 'employee',
    permission: PERMISSIONS.LEAVE_READ,
  },
  {
    to: '/employee/leave/requests',
    label: 'My requests',
    icon: '☰',
    section: 'Leave',
    portal: 'employee',
    permission: PERMISSIONS.LEAVE_READ,
  },
  {
    to: '/employee/history',
    label: 'Attendance history',
    icon: '◷',
    section: 'Attendance',
    portal: 'employee',
    permission: PERMISSIONS.ATTENDANCE_READ_OWN,
  },
  {
    to: '/employee/pay-estimate',
    label: 'My pay estimate',
    icon: '₹',
    section: 'Payroll',
    portal: 'employee',
    permission: PERMISSIONS.SALARY_READ,
  },
  {
    to: '/employee/help',
    label: 'Help',
    icon: '?',
    section: 'Support',
    portal: 'employee',
    permission: PERMISSIONS.HELP_WRITE,
  },
];

const ADMIN_USERS_LIST_PATH = '/admin/users';

export function resolveNavItemActive(to, { isActive, location }) {
  if (to === ADMIN_USERS_LIST_PATH) {
    const { pathname } = location;
    if (pathname === ADMIN_USERS_LIST_PATH) return true;
    if (!pathname.startsWith(`${ADMIN_USERS_LIST_PATH}/`)) return false;

    const childSegment = pathname.slice(`${ADMIN_USERS_LIST_PATH}/`.length);
    if (!childSegment || childSegment.includes('/')) return false;

    return childSegment !== 'register' && childSegment !== 'bulk-upload';
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
    permission: PERMISSIONS.LEAVE_APPLY,
    fallbackPermission: PERMISSIONS.LEAVE_READ,
    fallbackTo: '/employee/leave/balances',
  },
  {
    key: 'history',
    to: '/employee/history',
    label: 'Attendance history',
    shortLabel: 'History',
    icon: '◷',
    matchPrefixes: ['/employee/history'],
    permission: PERMISSIONS.ATTENDANCE_READ_OWN,
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
    anyPermission: ADMIN_PORTAL_PERMISSIONS,
  },
  {
    key: 'approvals',
    to: '/admin/leave/approvals',
    label: 'Pending Requests',
    shortLabel: 'Pending',
    icon: '✓',
    matchPrefixes: ['/admin/leave/approvals'],
    permission: PERMISSIONS.LEAVE_APPROVE,
  },
  {
    key: 'attendance',
    to: '/admin/attendance',
    label: 'Attendance history',
    shortLabel: 'Attendance',
    icon: '◷',
    matchPrefixes: ['/admin/attendance'],
    anyPermission: [PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM],
  },
  { key: 'more', label: 'Menu', icon: '⋯' },
];

function navItemAllowed(item, permissions) {
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

export function canAccessRoute(user, { permission, anyPermission, allPermissions } = {}) {
  const permissions = user?.permissions ?? [];
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
