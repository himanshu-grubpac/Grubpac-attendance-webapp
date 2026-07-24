/** Default page title/subtitle by route prefix (longest match wins). */
const PAGE_META = [
  { match: '/admin/dashboard', title: 'Dashboard', subtitle: '' },
  { match: '/admin/users/bulk-upload', title: 'Bulk Import', subtitle: 'Register many employees from a spreadsheet.' },
  {
    match: '/admin/users/register',
    title: 'Register New Employee',
    subtitle: 'Create credentials and profiles for on-boarding staff.',
  },
  { match: '/admin/users', title: 'Employee List', subtitle: 'Manage and monitor your workforce.' },
  { match: '/admin/roles', title: 'Roles & Permissions', subtitle: '' },
  { match: '/admin/departments', title: 'Departments', subtitle: '' },
  { match: '/admin/office-settings', title: 'Geolocation', subtitle: 'Geofence, office hours, and attendance policy thresholds.' },
  { match: '/admin/attendance', title: 'Attendance history', subtitle: 'View and manage team attendance records.' },
  { match: '/admin/audit-logs', title: 'Login Logs', subtitle: '' },
  { match: '/admin/leave/approvals', title: 'Pending Requests', subtitle: '' },
  { match: '/admin/leave/team-calendar', title: 'Calendar management', subtitle: '' },
  { match: '/admin/leave/policies', title: 'Leave policies', subtitle: '' },
  { match: '/admin/leave/holidays', title: 'Holidays', subtitle: '' },
  { match: '/admin/leave/balances', title: 'Adjust balances', subtitle: '' },
  { match: '/admin/salary', title: 'Salary Summary', subtitle: '' },
  { match: '/admin/help/team', title: 'Team issues', subtitle: '' },
  { match: '/admin/help/tickets', title: 'Help tickets', subtitle: '' },
  { match: '/admin/profile', title: 'Account settings', subtitle: 'Your account details.' },
  { match: '/admin/change-password', title: 'Change password', subtitle: 'Update your sign-in password.' },
  { match: '/employee/dashboard', title: 'Dashboard', subtitle: '' },
  { match: '/employee/history', title: 'Attendance history', subtitle: '' },
  { match: '/employee/leave/balances', title: 'Leave balances', subtitle: '' },
  { match: '/employee/leave/apply', title: 'Apply leave', subtitle: 'Submit a new leave request.' },
  { match: '/employee/leave/requests', title: 'My requests', subtitle: '' },
  { match: '/employee/pay-estimate', title: 'My pay estimate', subtitle: '' },
  { match: '/employee/help', title: 'Help', subtitle: '' },
  { match: '/employee/profile', title: 'Account settings', subtitle: 'Your account details.' },
  { match: '/employee/change-password', title: 'Change password', subtitle: 'Update your sign-in password.' },
];

export function getPageMeta(pathname) {
  const normalized = pathname.replace(/\/+$/, '') || '/';

  if (/^\/admin\/users\/[a-f\d]{24}$/i.test(normalized)) {
    return {
      title: 'Employee details',
      subtitle: '',
    };
  }

  const entries = PAGE_META.filter(
    (entry) => normalized === entry.match || normalized.startsWith(`${entry.match}/`),
  );
  entries.sort((a, b) => b.match.length - a.match.length);
  const hit = entries[0];
  if (!hit) return { title: '', subtitle: '' };
  return { title: hit.title, subtitle: hit.subtitle ?? '' };
}
