import {
  ADMIN_PORTAL_PERMISSIONS,
  PERMISSIONS,
  hasAnyPermission,
  hasPermission,
} from '@shared/permissions.js';

function hasAllPermissions(userPermissions, permissions = []) {
  return permissions.every((permission) => hasPermission(userPermissions, permission));
}

export function getDefaultRoute(user) {
  if (hasAnyPermission(user?.permissions, ADMIN_PORTAL_PERMISSIONS)) {
    return '/admin/dashboard';
  }
  return '/employee/dashboard';
}

export const NAV_ITEMS = [
  {
    to: '/admin/dashboard',
    label: 'Admin dashboard',
    icon: '⊞',
    section: 'Overview',
    permission: PERMISSIONS.USERS_READ,
  },
  {
    to: '/admin/leave/approvals',
    label: 'Approvals',
    icon: '✓',
    section: 'Operations',
    permission: PERMISSIONS.LEAVE_APPROVE,
  },
  {
    to: '/admin/attendance',
    label: 'Attendance',
    icon: '◷',
    section: 'Operations',
    anyPermission: [PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM],
  },
  {
    to: '/admin/leave/team-calendar',
    label: 'Team calendar',
    icon: '▣',
    section: 'Operations',
    anyPermission: [PERMISSIONS.LEAVE_READ_TEAM, PERMISSIONS.LEAVE_READ_ALL],
  },
  {
    to: '/admin/users',
    label: 'Employee list',
    icon: '☰',
    section: 'Employees',
    permission: PERMISSIONS.USERS_READ,
  },
  {
    to: '/admin/users/register',
    label: 'Register employee',
    icon: '＋',
    section: 'Employees',
    permission: PERMISSIONS.USERS_WRITE,
  },
  {
    to: '/admin/users/bulk-upload',
    label: 'Bulk import',
    icon: '⇪',
    section: 'Employees',
    permission: PERMISSIONS.USERS_WRITE,
  },
  {
    to: '/admin/leave/policies',
    label: 'Leave policies',
    icon: '⚙',
    section: 'Leave',
    permission: PERMISSIONS.LEAVE_MANAGE_POLICIES,
  },
  {
    to: '/admin/leave/holidays',
    label: 'Holidays',
    icon: '☼',
    section: 'Leave',
    permission: PERMISSIONS.LEAVE_MANAGE_POLICIES,
  },
  {
    to: '/admin/leave/balances',
    label: 'Adjust balances',
    icon: '±',
    section: 'Leave',
    permission: PERMISSIONS.LEAVE_ADJUST_BALANCES,
  },
  {
    to: '/admin/salary',
    label: 'Salary summary',
    icon: '₹',
    section: 'Payroll',
    allPermissions: [PERMISSIONS.SALARY_READ, PERMISSIONS.USERS_READ],
  },
  {
    to: '/admin/help/team',
    label: 'Team issues',
    icon: '?',
    section: 'Support',
    anyPermission: [PERMISSIONS.HELP_MANAGE],
    hideIfAllTicketsAdmin: true,
  },
  {
    to: '/admin/help/tickets',
    label: 'Help tickets',
    icon: '?',
    section: 'Support',
    allPermissions: [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE],
  },
  {
    to: '/admin/office-settings',
    label: 'Office settings',
    icon: '⌖',
    section: 'Setup',
    permission: PERMISSIONS.OFFICE_MANAGE,
  },
  {
    to: '/admin/roles',
    label: 'Roles',
    icon: '⚙',
    section: 'Setup',
    permission: PERMISSIONS.ROLES_MANAGE,
  },
  {
    to: '/admin/departments',
    label: 'Departments',
    icon: '▦',
    section: 'Setup',
    permission: PERMISSIONS.DEPARTMENTS_MANAGE,
  },
  {
    to: '/admin/audit-logs',
    label: 'Login logs',
    icon: '⎈',
    section: 'Setup',
    permission: PERMISSIONS.AUDIT_READ,
  },
  {
    to: '/admin/profile',
    label: 'My profile',
    icon: '☺',
    section: 'Account',
    anyPermission: ADMIN_PORTAL_PERMISSIONS,
  },
  {
    to: '/admin/change-password',
    label: 'Change password',
    icon: '⚿',
    section: 'Account',
    anyPermission: ADMIN_PORTAL_PERMISSIONS,
  },
  {
    to: '/employee/dashboard',
    label: 'Dashboard',
    icon: '⌂',
    section: 'Overview',
    permission: PERMISSIONS.ATTENDANCE_READ_OWN,
  },
  {
    to: '/employee/leave/apply',
    label: 'Apply leave',
    icon: '＋',
    section: 'Leave',
    permission: PERMISSIONS.LEAVE_APPLY,
  },
  {
    to: '/employee/leave/balances',
    label: 'Leave balances',
    icon: '▤',
    section: 'Leave',
    permission: PERMISSIONS.LEAVE_READ,
  },
  {
    to: '/employee/leave/requests',
    label: 'My requests',
    icon: '☰',
    section: 'Leave',
    permission: PERMISSIONS.LEAVE_READ,
  },
  {
    to: '/employee/history',
    label: 'Attendance history',
    icon: '◷',
    section: 'Attendance',
    permission: PERMISSIONS.ATTENDANCE_READ_OWN,
  },
  {
    to: '/employee/pay-estimate',
    label: 'My pay estimate',
    icon: '₹',
    section: 'Payroll',
    permission: PERMISSIONS.SALARY_READ,
  },
  {
    to: '/employee/help',
    label: 'Help',
    icon: '?',
    section: 'Support',
    permission: PERMISSIONS.HELP_WRITE,
  },
  {
    to: '/employee/profile',
    label: 'My profile',
    icon: '☺',
    section: 'Account',
    permission: PERMISSIONS.ATTENDANCE_READ_OWN,
    hideIfAdminRoute: true,
  },
  {
    to: '/employee/change-password',
    label: 'Change password',
    icon: '⚿',
    section: 'Account',
    permission: PERMISSIONS.ATTENDANCE_READ_OWN,
    hideIfAdminRoute: true,
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

export function getVisibleNavItems(user) {
  const permissions = user?.permissions ?? [];
  const hasAdminNav = hasAnyPermission(permissions, ADMIN_PORTAL_PERMISSIONS);

  return NAV_ITEMS.filter((item) => {
    if (item.hideIfAdminRoute && hasAdminNav && item.to.startsWith('/employee/')) {
      return false;
    }

    if (
      item.hideIfAllTicketsAdmin &&
      hasAllPermissions(permissions, [PERMISSIONS.HELP_MANAGE, PERMISSIONS.USERS_WRITE])
    ) {
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
    label: 'Approvals',
    icon: '✓',
    matchPrefixes: ['/admin/leave/approvals', '/admin/help'],
    permission: PERMISSIONS.LEAVE_APPROVE,
  },
  {
    key: 'attendance',
    label: 'Attendance',
    icon: '◷',
    matchPrefixes: ['/admin/attendance', '/admin/leave/team-calendar'],
    anyPermission: [
      PERMISSIONS.ATTENDANCE_READ_ALL,
      PERMISSIONS.ATTENDANCE_READ_TEAM,
      PERMISSIONS.LEAVE_READ_TEAM,
      PERMISSIONS.LEAVE_READ_ALL,
    ],
  },
  { key: 'more', label: 'Menu', icon: '⋯' },
];

function resolveAdminTeamLabel(permissions) {
  if (
    hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_ALL) ||
    hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_TEAM)
  ) {
    return 'Attendance';
  }
  return 'Team calendar';
}

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

function resolveAdminTeamTarget(permissions) {
  if (
    hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_ALL) ||
    hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_TEAM)
  ) {
    return '/admin/attendance';
  }
  return '/admin/leave/team-calendar';
}

export function getBottomNavItems(user) {
  const permissions = user?.permissions ?? [];
  const isAdmin = hasAnyPermission(permissions, ADMIN_PORTAL_PERMISSIONS);
  const template = isAdmin ? ADMIN_BOTTOM_NAV : EMPLOYEE_BOTTOM_NAV;

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

      if (item.key === 'attendance') {
        if (!navItemAllowed(item, permissions)) {
          return null;
        }
        return {
          ...item,
          to: resolveAdminTeamTarget(permissions),
          label: resolveAdminTeamLabel(permissions),
        };
      }

      if (!navItemAllowed(item, permissions)) {
        return null;
      }

      return item;
    })
    .filter(Boolean);
}

export function getMoreNavItems(user) {
  const permissions = user?.permissions ?? [];
  const bottomItems = getBottomNavItems(user);
  const bottomRoutes = new Set(
    bottomItems.filter((item) => item.to).map((item) => item.to),
  );

  const isAdmin = hasAnyPermission(permissions, ADMIN_PORTAL_PERMISSIONS);

  const moreLinks = getVisibleNavItems(user).filter((item) => {
    if (bottomRoutes.has(item.to)) {
      return false;
    }
    if (isAdmin && item.to === '/admin/dashboard') {
      return false;
    }
    if (!isAdmin && item.to === '/employee/dashboard') {
      return false;
    }
    return true;
  });

  if (isAdmin) {
    return moreLinks;
  }

  const priority = [
    '/employee/leave/balances',
    '/employee/leave/requests',
    '/employee/pay-estimate',
    '/employee/help',
    '/employee/profile',
    '/employee/change-password',
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

export function isMoreNavActive(pathname, user) {
  const moreRoutes = getMoreNavItems(user).map((item) => item.to);
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
