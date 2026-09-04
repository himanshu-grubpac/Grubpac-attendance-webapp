/** Default page title/subtitle by route prefix (longest match wins). */
const PAGE_META = [
  { match: '/admin/dashboard', title: 'Dashboard', subtitle: '' },
  {
    match: '/admin/users/bulk-upload',
    title: 'Bulk Employee Sync',
    subtitle: 'Download the employee directory, make changes, and upload to sync employee records.',
  },
  {
    match: '/admin/users/register',
    title: 'Register New Employee',
    subtitle: 'Create credentials and profiles for on-boarding staff.',
  },
  { match: '/admin/users', title: 'Employee List', subtitle: 'Manage and monitor your workforce.' },
  {
    match: '/admin/roles',
    title: 'Roles & Permissions',
    subtitle: 'Define access levels with permission sets for system and custom roles.',
  },
  {
    match: '/admin/departments',
    title: 'Departments',
    subtitle: 'Organize teams with named units and codes used across employee records.',
  },
  { match: '/admin/office-settings', title: 'Geolocation', subtitle: 'Geofence, office hours, and attendance policy thresholds.' },
  { match: '/admin/faq-demo', title: 'FAQ & Demo', subtitle: 'Guides and demo videos for your role' },
  { match: '/admin/attendance', title: 'Attendance history', subtitle: 'View and manage team attendance records.' },
  {
    match: '/admin/audit-logs',
    title: 'Audit Logs',
    subtitle: 'Login events, bulk uploads, employee registrations, and other admin actions.',
  },
  {
    match: '/admin/leave/approvals',
    title: 'Pending Requests',
    subtitle: 'Review and action team leave requests awaiting approval.',
  },
  { match: '/admin/leave/team-calendar', title: 'Calendar management', subtitle: '' },
  { match: '/admin/leave/streaks', title: 'Late Warning', subtitle: 'Quarterly warning usage per employee.' },
  {
    match: '/admin/leave/policies',
    title: 'Leave policies',
    subtitle:
      'Configure leave rules per type and manually enter opening carried days for employees.',
  },
  { match: '/admin/leave/holidays', title: 'Holidays', subtitle: '' },
  {
    match: '/admin/salary',
    title: 'Salary Management',
    subtitle: 'Monthly pay estimates, salary structure, and payroll schedule.',
  },
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
  { match: '/employee/faq-demo', title: 'FAQ & Demo', subtitle: 'Guides and demo videos for your role' },
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
