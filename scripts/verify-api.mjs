/**
 * Full API verification with in-memory MongoDB (single process).
 * Run: npm run verify
 */
process.env.USE_MEMORY_DB = 'true';
process.env.PORT = '5055';
process.env.NODE_ENV = 'test';

const {
  endOfDayIST,
  formatISTDateTime,
  getISTDateInputValue,
  startOfDayIST,
} = await import('../server/src/utils/istDate.js');
const { startServer } = await import('../server/src/index.js');
const { disconnectDatabase } = await import('../server/src/config/db.js');
const { seedDatabase } = await import('../server/src/seed.js');

const PORT = 5055;
const BASE = `http://localhost:${PORT}/api`;

let passed = 0;
let failed = 0;
let httpServer;
let cookieHeader = '';
let csrfToken = '';

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`✓ ${message}`);
  } else {
    failed += 1;
    console.error(`✗ ${message}`);
  }
}

function absorbCookies(response) {
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) {
    cookieHeader = cookies.map((entry) => entry.split(';')[0]).join('; ');
    for (const entry of cookies) {
      const match = entry.match(/^attendance_csrf=([^;]+)/);
      if (match) csrfToken = match[1];
    }
  }
}

async function request(pathname, options = {}) {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = {
    'Content-Type': 'application/json',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...(options.headers ?? {}),
  };

  if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  const response = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  absorbCookies(response);
  const data = await response.json().catch(() => ({}));
  if (data.csrfToken) {
    csrfToken = data.csrfToken;
  }
  return { response, data };
}

function insidePayload(lat, lng, accuracyMeters = 10) {
  return {
    latitude: lat,
    longitude: lng,
    accuracyMeters,
    clientTimestamp: new Date().toISOString(),
  };
}

async function main() {
  console.log('--- IST utilities ---');
  const now = new Date();
  const istFormatted = formatISTDateTime(now);
  assert(/\d{1,2}.*\d{4}/.test(istFormatted), `IST datetime formats correctly (${istFormatted})`);
  assert(getISTDateInputValue().match(/^\d{4}-\d{2}-\d{2}$/), 'IST date input is YYYY-MM-DD');
  assert(startOfDayIST(now) < endOfDayIST(now), 'IST day boundaries are valid');

  console.log('\n--- Starting test server (in-memory MongoDB) ---');
  await seedDatabase();
  httpServer = await startServer();

  const OFFICE_LAT = 12.9716;
  const OFFICE_LNG = 77.5946;

  console.log('\n--- Health ---');
  const health = await request('/health', { method: 'GET' });
  assert(health.response.ok, 'Health endpoint responds');
  assert(health.data.checks?.mongo === 'ok', 'Health reports MongoDB ping ok');

  console.log('\n--- Admin auth (httpOnly cookie) ---');
  const adminLogin = await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });
  assert(adminLogin.response.ok, 'Admin login works');
  assert(adminLogin.data.user?.role === 'admin', 'Admin login sets session cookie');
  assert(cookieHeader.includes('attendance_token='), 'httpOnly auth cookie is issued');

  console.log('\n--- Office settings ---');
  const officeUpdate = await request('/admin/office-settings', {
    method: 'PUT',
    body: {
      name: 'Grubpac Technologies — Test Office',
      latitude: OFFICE_LAT,
      longitude: OFFICE_LNG,
      radiusMeters: 100,
      maxAccuracyMeters: 50,
    },
  });
  assert(officeUpdate.response.ok, 'Office settings update works');

  const invalidOffice = await request('/admin/office-settings', {
    method: 'PUT',
    body: {
      name: 'Bad',
      latitude: 120,
      longitude: OFFICE_LNG,
      radiusMeters: 100,
      maxAccuracyMeters: 50,
    },
  });
  assert(invalidOffice.response.status === 400, 'Invalid latitude is rejected');

  const employeeEmail = `emp.verify.${Date.now()}@grubpac.test`;
  const employeePassword = 'Employee@12345';
  const employeeMobile = `9${String(Date.now()).slice(-9)}`;

  console.log('\n--- Employee registration validation ---');
  const badEmployee = await request('/admin/users', {
    method: 'POST',
    body: {
      name: 'Bad',
      email: 'not-an-email',
      mobile: '12345',
      password: 'weak',
    },
  });
  assert(badEmployee.response.status === 400, 'Invalid employee payload is rejected');

  const register = await request('/admin/users', {
    method: 'POST',
    body: {
      firstName: 'Verify',
      lastName: 'Employee',
      email: employeeEmail,
      mobile: employeeMobile,
      password: employeePassword,
      employeeCode: `EMP${Date.now()}`,
      department: 'QA',
      joiningDate: '2026-01-01',
      endingDate: '2027-12-31',
    },
  });
  assert(register.response.status === 201, 'Employee registration works');
  assert(register.data.employee?.endingDate, 'Employee registration stores endingDate');
  const employeeCode = register.data.employee?.employeeCode;
  assert(employeeCode, 'Registered employee has employeeCode');

  cookieHeader = '';
  const employeeLogin = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: employeePassword },
  });
  assert(employeeLogin.response.ok, 'Employee login works');
  assert(cookieHeader.includes('attendance_token='), 'Employee session cookie is issued');

  console.log('\n--- Portal separation (Employee tab vs Admin tab) ---');
  cookieHeader = '';
  const adminOnEmployeePortal = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });
  assert(adminOnEmployeePortal.response.status === 403, 'Admin is rejected on Employee tab');
  assert(!cookieHeader.includes('attendance_token='), 'Admin gets no session cookie from Employee tab');

  cookieHeader = '';
  const employeeOnAdminPortal = await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: employeePassword },
  });
  assert(employeeOnAdminPortal.response.status === 403, 'Plain employee is rejected on Admin tab');

  cookieHeader = '';
  const sampleEmployeeOnEmployeePortal = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: 'employee.sample@grubpac.com', password: 'Employee@12345' },
  });
  assert(sampleEmployeeOnEmployeePortal.response.ok, 'Sample employee login works on Employee tab');

  cookieHeader = '';
  const sampleEmployeeOnAdminPortal = await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'employee.sample@grubpac.com', password: 'Employee@12345' },
  });
  assert(sampleEmployeeOnAdminPortal.response.status === 403, 'Sample employee is rejected on Admin tab');

  console.log('\n--- Multi-identifier login + validation gaps ---');
  cookieHeader = '';
  const emptyLogin = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: '', password: '' },
  });
  assert(emptyLogin.response.status === 400, 'Empty login fields are rejected');

  cookieHeader = '';
  const unknownLogin = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: 'nobody.missing@grubpac.test', password: 'WrongPassword1' },
  });
  assert(unknownLogin.response.status === 401, 'Unknown user login is rejected');

  cookieHeader = '';
  const mobileLogin = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeMobile, password: employeePassword },
  });
  assert(mobileLogin.response.ok, 'Employee can login with mobile number');

  cookieHeader = '';
  const codeLogin = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeCode, password: employeePassword },
  });
  assert(codeLogin.response.ok, 'Employee can login with employee code');

  console.log('\n--- Login tracking ---');
  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });
  const failedLogin = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: 'WrongPassword1' },
  });
  assert(failedLogin.response.status === 401, 'Failed login is rejected');

  const auditLogs = await request('/admin/audit-logs?page=1&limit=20', { method: 'GET' });
  assert(auditLogs.response.ok, 'Admin audit logs list works');
  assert(auditLogs.data.pagination, 'Admin audit logs include pagination');
  assert(
    auditLogs.data.logs.some((log) => log.action === 'login_success'),
    'Audit logs include login_success entries',
  );
  assert(
    auditLogs.data.logs.some((log) => log.action === 'login_failed' && log.reason === 'bad_password'),
    'Audit logs include login_failed entries',
  );

  const successOnly = await request('/admin/audit-logs?action=login_success&page=1&limit=20', {
    method: 'GET',
  });
  assert(
    successOnly.response.ok &&
      successOnly.data.logs.every((log) => log.action === 'login_success'),
    'Audit log action filter works',
  );

  const listAfterLogin = await request('/admin/users?page=1&limit=10', { method: 'GET' });
  const loggedInEmployee = listAfterLogin.data.employees?.find((e) => e.email === employeeEmail);
  assert(loggedInEmployee?.lastLoginAt, 'Employee lastLoginAt is set after login');

  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: employeePassword },
  });

  console.log('\n--- Today status (IST) ---');
  const today = await request('/attendance/today', { method: 'GET' });
  assert(today.response.ok, 'Today status endpoint works');
  assert(today.data.status?.istDate, 'Today status includes IST date');
  assert(today.data.status?.currentIST, 'Today status includes current IST time');
  assert(today.data.status?.office?.latitude === OFFICE_LAT, 'Today status includes office geo');

  console.log('\n--- Attendance geo rules ---');
  const outside = await request('/attendance/check-in', {
    method: 'POST',
    body: insidePayload(28.6139, 77.209),
  });
  assert(outside.response.status === 400, 'Outside radius check-in is rejected');

  const future = await request('/attendance/check-in', {
    method: 'POST',
    body: {
      ...insidePayload(OFFICE_LAT, OFFICE_LNG),
      clientTimestamp: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  assert(future.response.status === 400, 'Future timestamp is rejected');

  const stale = await request('/attendance/check-in', {
    method: 'POST',
    body: {
      ...insidePayload(OFFICE_LAT, OFFICE_LNG),
      clientTimestamp: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  assert(stale.response.status === 400, 'Stale location is rejected');

  const edgeAccuracy = await request('/attendance/check-in', {
    method: 'POST',
    body: insidePayload(OFFICE_LAT, OFFICE_LNG, 95),
  });
  assert(edgeAccuracy.response.status === 400, 'Conservative geofence rejects poor edge accuracy');

  const inside = await request('/attendance/check-in', {
    method: 'POST',
    body: insidePayload(OFFICE_LAT, OFFICE_LNG, 10),
  });
  assert(inside.response.status === 201, 'Inside radius check-in is allowed');
  assert(inside.data.status === 'allowed', 'Check-in status is allowed');

  const duplicate = await request('/attendance/check-in', {
    method: 'POST',
    body: insidePayload(OFFICE_LAT, OFFICE_LNG),
  });
  assert(duplicate.response.status === 400, 'Duplicate check-in is rejected');

  const checkout = await request('/attendance/check-out', {
    method: 'POST',
    body: insidePayload(OFFICE_LAT, OFFICE_LNG),
  });
  assert(checkout.response.status === 201, 'Check-out after check-in works');

  const duplicateCheckout = await request('/attendance/check-out', {
    method: 'POST',
    body: insidePayload(OFFICE_LAT, OFFICE_LNG),
  });
  assert(duplicateCheckout.response.status === 400, 'Duplicate check-out is rejected');

  cookieHeader = '';
  const employee2Email = `emp2.verify.${Date.now()}@grubpac.test`;
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });
  await request('/admin/users', {
    method: 'POST',
    body: {
      firstName: 'Verify',
      lastName: 'Employee 2',
      email: employee2Email,
      mobile: `8${String(Date.now()).slice(-9)}`,
      password: employeePassword,
      joiningDate: '2026-01-01',
    },
  });
  cookieHeader = '';
  const employee2Login = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employee2Email, password: employeePassword },
  });
  const checkoutWithoutCheckin = await request('/attendance/check-out', {
    method: 'POST',
    body: insidePayload(OFFICE_LAT, OFFICE_LNG),
  });
  assert(checkoutWithoutCheckin.response.status === 400, 'Check-out without check-in is rejected');

  console.log('\n--- History, pagination & admin attendance ---');
  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: employeePassword },
  });
  const history = await request('/attendance/history?page=1&limit=10', { method: 'GET' });
  assert(history.response.ok && history.data.records.length >= 2, 'Employee history returns records');
  assert(history.data.pagination?.total >= 2, 'Employee history includes pagination metadata');

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });
  const adminAttendance = await request(
    `/admin/attendance?date=${getISTDateInputValue()}&page=1&limit=10`,
    { method: 'GET' },
  );
  assert(adminAttendance.response.ok, 'Admin attendance list works');
  assert(adminAttendance.data.pagination, 'Admin attendance includes pagination');

  const listUsers = await request('/admin/users?page=1&limit=10', { method: 'GET' });
  assert(listUsers.response.ok, 'Admin employee list works');
  assert(listUsers.data.pagination, 'Admin employee list includes pagination');

  const me = await request('/auth/me', { method: 'GET' });
  assert(me.response.ok, '/auth/me works with cookie auth');
  assert(Array.isArray(me.data.user?.permissions), '/auth/me includes permissions array');
  assert(me.data.user.permissions.includes('users.read'), 'Admin permissions are loaded from role');

  console.log('\n--- Self-service profile (PATCH /auth/me) ---');
  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: employeePassword },
  });
  const profilePatch = await request('/auth/me', {
    method: 'PATCH',
    body: {
      firstName: 'VerifyUpdated',
      lastName: 'Employee',
      mobile: employeeMobile,
    },
  });
  assert(profilePatch.response.ok, 'Employee can update own profile');
  assert(profilePatch.data.user?.firstName === 'VerifyUpdated', 'Profile firstName is updated');

  const privilegeEscalation = await request('/auth/me', {
    method: 'PATCH',
    body: {
      firstName: 'VerifyUpdated',
      role: 'admin',
      isActive: false,
      email: 'hacked@grubpac.test',
    },
  });
  assert(privilegeEscalation.response.status === 400, 'Profile patch rejects privilege escalation fields');

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });

  console.log('\n--- Inactive user login ---');
  const inactiveTarget = listUsers.data.employees?.find((e) => e.email === employeeEmail);
  assert(inactiveTarget?.id, 'Employee id available for inactive login test');
  const deactivate = await request(`/admin/users/${inactiveTarget.id}`, {
    method: 'PATCH',
    body: { isActive: false },
  });
  assert(deactivate.response.ok, 'Admin can deactivate employee for inactive login test');

  cookieHeader = '';
  const inactiveLogin = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: employeePassword },
  });
  assert(inactiveLogin.response.status === 401, 'Inactive employee login is rejected');

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });
  const reactivate = await request(`/admin/users/${inactiveTarget.id}`, {
    method: 'PATCH',
    body: { isActive: true },
  });
  assert(reactivate.response.ok, 'Employee reactivated after inactive login test');

  console.log('\n--- Phase A: RBAC roles & departments ---');
  const rolesList = await request('/admin/roles', { method: 'GET' });
  assert(rolesList.response.ok, 'Admin can list roles');
  assert(
    rolesList.data.roles.some((role) => role.slug === 'admin' && role.isSystem),
    'System Admin role is seeded',
  );

  const permissionsList = await request('/admin/permissions', { method: 'GET' });
  assert(permissionsList.response.ok, 'Permission matrix metadata is available');
  assert(permissionsList.data.groups?.length > 0, 'Permission groups are returned');

  const customRoleSlug = `qa-lead-${Date.now()}`;
  const createRole = await request('/admin/roles', {
    method: 'POST',
    body: {
      name: 'QA Lead',
      slug: customRoleSlug,
      description: 'Custom test role',
      permissions: ['users.read', 'attendance.read_team'],
    },
  });
  assert(createRole.response.status === 201, 'Admin can create custom role');

  const updateRole = await request(`/admin/roles/${createRole.data.role.id}`, {
    method: 'PATCH',
    body: {
      permissions: ['users.read', 'attendance.read_team', 'leave.approve'],
    },
  });
  assert(updateRole.response.ok, 'Admin can update role permissions');

  const adminSystemRole = rolesList.data.roles.find((role) => role.slug === 'admin');
  const deleteSystemRole = await request(`/admin/roles/${adminSystemRole.id}`, {
    method: 'DELETE',
  });
  assert(deleteSystemRole.response.status === 400, 'System roles cannot be deleted');

  const departmentsList = await request('/admin/departments', { method: 'GET' });
  assert(departmentsList.response.ok, 'Admin can list departments');
  assert(
    departmentsList.data.departments.some((dept) => dept.code === 'DEV'),
    'Development department is seeded',
  );

  const createDepartment = await request('/admin/departments', {
    method: 'POST',
    body: { name: 'QA Ops', code: `QA${String(Date.now()).slice(-4)}` },
  });
  assert(createDepartment.response.status === 201, 'Admin can create department');

  const devDepartment = departmentsList.data.departments.find((dept) => dept.code === 'DEV');
  const phaseAEmployeeId = listUsers.data.employees?.find((e) => e.email === employee2Email)?.id;
  assert(phaseAEmployeeId, 'Second employee id available for org update');
  const orgUpdate = await request(`/admin/users/${phaseAEmployeeId}`, {
    method: 'PATCH',
    body: {
      departmentId: devDepartment?.id,
      roleId: createRole.data.role.id,
    },
  });
  assert(orgUpdate.response.ok, 'Admin can update employee org fields');
  assert(orgUpdate.data.employee?.departmentName === 'Development', 'Employee department is assigned');
  assert(orgUpdate.data.employee?.roleSlug === customRoleSlug, 'Employee custom role is assigned');

  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: employeePassword },
  });
  const employeeForbidden = await request('/admin/roles', { method: 'GET' });
  assert(employeeForbidden.response.status === 403, 'Employee cannot access roles API');

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });
  const orgAudits = await request('/admin/audit-logs?page=1&limit=100', { method: 'GET' });
  assert(
    orgAudits.data.logs.some((log) => log.action === 'role_created'),
    'Audit logs include role_created',
  );
  assert(
    orgAudits.data.logs.some((log) => log.action === 'employee_org_updated'),
    'Audit logs include employee_org_updated',
  );

  console.log('\n--- Password change & admin reset ---');
  const employeeId = listUsers.data.employees?.find((e) => e.email === employeeEmail)?.id;
  assert(employeeId, 'Employee id available for password reset');

  const weakReset = await request(`/admin/users/${employeeId}/password`, {
    method: 'PATCH',
    body: { newPassword: 'weak', confirmPassword: 'weak' },
  });
  assert(weakReset.response.status === 400, 'Admin reset rejects weak password');

  const mismatchReset = await request(`/admin/users/${employeeId}/password`, {
    method: 'PATCH',
    body: { newPassword: 'ResetPass@12345', confirmPassword: 'ResetPass@99999' },
  });
  assert(mismatchReset.response.status === 400, 'Admin reset rejects mismatched passwords');

  const sameReset = await request(`/admin/users/${employeeId}/password`, {
    method: 'PATCH',
    body: { newPassword: employeePassword, confirmPassword: employeePassword },
  });
  assert(sameReset.response.status === 400, 'Admin reset rejects same-as-current password');

  const resetPassword = 'ResetPass@12345';
  const adminReset = await request(`/admin/users/${employeeId}/password`, {
    method: 'PATCH',
    body: { newPassword: resetPassword, confirmPassword: resetPassword },
  });
  assert(adminReset.response.ok, 'Admin can reset employee password');

  cookieHeader = '';
  const loginAfterReset = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: resetPassword },
  });
  assert(loginAfterReset.response.ok, 'Employee can login with admin-reset password');

  const badCurrent = await request('/auth/change-password', {
    method: 'POST',
    body: {
      currentPassword: 'WrongCurrent1',
      newPassword: 'ChangedPass@123',
      confirmPassword: 'ChangedPass@123',
    },
  });
  assert(badCurrent.response.status === 401, 'Change password rejects wrong current password');

  const sameAsCurrent = await request('/auth/change-password', {
    method: 'POST',
    body: {
      currentPassword: resetPassword,
      newPassword: resetPassword,
      confirmPassword: resetPassword,
    },
  });
  assert(sameAsCurrent.response.status === 400, 'Change password rejects same-as-current password');

  const changedPassword = 'ChangedPass@123';
  const changeOwn = await request('/auth/change-password', {
    method: 'POST',
    body: {
      currentPassword: resetPassword,
      newPassword: changedPassword,
      confirmPassword: changedPassword,
    },
  });
  assert(changeOwn.response.ok, 'Employee can change own password');

  cookieHeader = '';
  const loginAfterChange = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: changedPassword },
  });
  assert(loginAfterChange.response.ok, 'Employee can login with self-changed password');

  console.log('\n--- Notifications ---');
  const { createNotification } = await import('../server/src/services/notificationService.js');
  const employeeUserId = loginAfterChange.data.user?.id;
  assert(employeeUserId, 'Employee user id available for notifications');

  await createNotification({
    userId: employeeUserId,
    type: 'verify.test',
    title: 'Verify notification',
    body: 'Integration test notification body',
    link: '/employee',
    metadata: { source: 'verify-api' },
  });
  await createNotification({
    userId: employeeUserId,
    type: 'verify.test',
    title: 'Second notification',
    body: 'Another unread notification',
  });

  const listNotifs = await request('/notifications?page=1&limit=10', { method: 'GET' });
  assert(listNotifs.response.ok, 'Employee can list notifications');
  assert(listNotifs.data.unreadCount >= 2, 'List response includes unreadCount');
  assert(listNotifs.data.notifications?.length >= 2, 'List returns created notifications');

  const unreadOnly = await request('/notifications/unread-count', { method: 'GET' });
  assert(unreadOnly.response.ok, 'Unread count endpoint works');
  assert(unreadOnly.data.unreadCount >= 2, 'Unread count reflects new notifications');

  const firstId = listNotifs.data.notifications[0]?.id;
  const markRead = await request(`/notifications/${firstId}/read`, { method: 'POST' });
  assert(markRead.response.ok, 'Mark one notification read works');
  assert(markRead.data.notification?.readAt, 'Marked notification has readAt');

  const markAll = await request('/notifications/read-all', { method: 'POST' });
  assert(markAll.response.ok, 'Mark all notifications read works');
  assert(markAll.data.updatedCount >= 1, 'Mark all updates remaining unread notifications');

  const afterAll = await request('/notifications/unread-count', { method: 'GET' });
  assert(afterAll.data.unreadCount === 0, 'Unread count is zero after mark all read');

  cookieHeader = '';
  const unauthNotifs = await request('/notifications', { method: 'GET' });
  assert(unauthNotifs.response.status === 401, 'Notifications require authentication');

  cookieHeader = '';
  const unauthChange = await request('/auth/change-password', {
    method: 'POST',
    body: {
      currentPassword: changedPassword,
      newPassword: 'AnotherPass@123',
      confirmPassword: 'AnotherPass@123',
    },
  });
  assert(unauthChange.response.status === 401, 'Change password requires authentication');

  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });
  const passwordAudits = await request('/admin/audit-logs?page=1&limit=50', { method: 'GET' });
  assert(
    passwordAudits.data.logs.some((log) => log.action === 'password_reset_by_admin'),
    'Audit logs include password_reset_by_admin',
  );
  assert(
    passwordAudits.data.logs.some((log) => log.action === 'password_changed'),
    'Audit logs include password_changed',
  );

  console.log('\n--- Phase B: Leave management ---');
  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });

  const leaveTypes = await request('/leave/types', { method: 'GET' });
  assert(leaveTypes.response.ok, 'Admin can list leave types');
  const slType = leaveTypes.data.types?.find((t) => t.code === 'SL');
  const clType = leaveTypes.data.types?.find((t) => t.code === 'CL');
  const elType = leaveTypes.data.types?.find((t) => t.code === 'EL');
  assert(slType && clType && elType, 'SL, CL, EL leave types are seeded');

  const leavePolicies = await request('/leave/policies', { method: 'GET' });
  assert(leavePolicies.response.ok, 'Admin can list leave policies');
  const slPolicy = leavePolicies.data.policies?.find((p) => p.leaveTypeCode === 'SL');
  const elPolicy = leavePolicies.data.policies?.find((p) => p.leaveTypeCode === 'EL');
  assert(slPolicy?.annualQuota === 7, 'SL annual quota is 7');
  assert(elPolicy?.annualQuota === 18 && elPolicy?.accrualPerMonth === 1.5, 'EL policy accrues 1.5/month');

  const holidaysList = await request('/leave/holidays', { method: 'GET' });
  assert(holidaysList.response.ok, 'Holidays list works');
  assert(Array.isArray(holidaysList.data.holidays), 'Holiday seed/list returns array (empty until Jan publish)');

  const managerEmail = `mgr.verify.${Date.now()}@grubpac.test`;
  const managerMobile = `7${String(Date.now()).slice(-9)}`;
  const managerRegister = await request('/admin/users', {
    method: 'POST',
    body: {
      firstName: 'Verify',
      lastName: 'Manager',
      email: managerEmail,
      mobile: managerMobile,
      password: employeePassword,
      employeeCode: `MGR${Date.now()}`,
      joiningDate: '2026-01-01',
    },
  });
  assert(managerRegister.response.status === 201, 'Manager user created');
  const managerId = managerRegister.data.employee?.id;

  const rolesForMgr = await request('/admin/roles', { method: 'GET' });
  const reportingManagerRole = rolesForMgr.data.roles?.find((r) => r.slug === 'reporting-manager');
  await request(`/admin/users/${managerId}`, {
    method: 'PATCH',
    body: { roleId: reportingManagerRole?.id },
  });

  await request(`/admin/users/${employeeId}`, {
    method: 'PATCH',
    body: { reportingManagerId: managerId },
  });

  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: changedPassword },
  });

  const myBalances = await request('/leave/balances/me', { method: 'GET' });
  assert(myBalances.response.ok, 'Employee can view own leave balances');
  assert(myBalances.data.balances?.length >= 3, 'Employee has SL/CL/EL balances');
  const empSlBalance = myBalances.data.balances?.find((b) => b.leaveTypeCode === 'SL');
  assert(empSlBalance?.entitled === 7, 'Employee SL entitled is 7');

  const year = new Date().getFullYear();
  const leaveStart = `${year}-03-10`;
  const leaveEnd = `${year}-03-11`;

  const previewDays = await request(
    `/leave/requests/preview?startDate=${leaveStart}&endDate=${leaveEnd}`,
    { method: 'GET' },
  );
  assert(previewDays.response.ok && previewDays.data.days === 2, 'Leave preview counts working days');

  const createLeave = await request('/leave/requests', {
    method: 'POST',
    body: {
      leaveTypeId: clType.id,
      startDate: leaveStart,
      endDate: leaveEnd,
      reason: 'Personal errand',
    },
  });
  assert(createLeave.response.status === 201, 'Employee can apply leave');
  assert(createLeave.data.request?.status === 'pending', 'New leave request is pending');
  const leaveRequestId = createLeave.data.request?.id;

  const duplicateLeave = await request('/leave/requests', {
    method: 'POST',
    body: {
      leaveTypeId: clType.id,
      startDate: leaveStart,
      endDate: leaveEnd,
      reason: 'Overlap test',
    },
  });
  assert(duplicateLeave.response.status === 400, 'Overlapping leave is rejected');

  const myRequests = await request('/leave/requests?scope=mine', { method: 'GET' });
  assert(myRequests.response.ok && myRequests.data.requests?.length >= 1, 'Employee can list own requests');

  // Reporting Manager holds LEAVE_APPROVE/ATTENDANCE_READ_TEAM/etc., which are
  // ADMIN_PORTAL_PERMISSIONS — they must sign in via the admin portal, not employee.
  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: managerEmail, password: employeePassword },
  });

  const mgrApprovals = await request('/leave/requests?scope=approvals', { method: 'GET' });
  assert(mgrApprovals.response.ok, 'Manager can view approval queue');
  assert(
    mgrApprovals.data.requests?.some((r) => r.id === leaveRequestId),
    'Manager sees direct report pending request',
  );

  const approveLeave = await request(`/leave/requests/${leaveRequestId}/approve`, {
    method: 'POST',
    body: { comment: 'Approved for verify test' },
  });
  assert(approveLeave.response.ok, 'Manager can approve leave');
  assert(approveLeave.data.request?.status === 'approved', 'Leave status becomes approved');

  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: changedPassword },
  });

  const balancesAfterApprove = await request('/leave/balances/me', { method: 'GET' });
  const clBalanceAfter = balancesAfterApprove.data.balances?.find((b) => b.leaveTypeCode === 'CL');
  assert(clBalanceAfter?.used === 2, 'Approved leave increments used balance');

  const pendingCancelStart = `${year}-04-07`;
  const pendingCancelEnd = `${year}-04-07`;
  const pendingLeave = await request('/leave/requests', {
    method: 'POST',
    body: {
      leaveTypeId: clType.id,
      startDate: pendingCancelStart,
      endDate: pendingCancelEnd,
      reason: 'Cancel me',
    },
  });
  assert(pendingLeave.response.status === 201, 'Second leave request created for cancel test');
  const pendingId = pendingLeave.data.request?.id;

  const cancelLeave = await request(`/leave/requests/${pendingId}/cancel`, { method: 'POST' });
  assert(cancelLeave.response.ok, 'Employee can cancel pending leave');
  assert(cancelLeave.data.request?.status === 'cancelled', 'Cancelled status is set');

  const slLongStart = `${year}-05-06`;
  const slLongEnd = `${year}-05-09`;
  const slWithoutDoc = await request('/leave/requests', {
    method: 'POST',
    body: {
      leaveTypeId: slType.id,
      startDate: slLongStart,
      endDate: slLongEnd,
      reason: 'Sick without cert',
    },
  });
  assert(slWithoutDoc.response.status === 400, 'SL >2 consecutive days requires medical certificate');

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });

  const holidayDate = `${year}-08-15`;
  const createHoliday = await request('/leave/holidays', {
    method: 'POST',
    body: { date: holidayDate, name: 'Verify Holiday' },
  });
  assert(createHoliday.response.status === 201, 'Admin can create holiday');

  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: changedPassword },
  });

  const leaveOnHoliday = await request('/leave/requests', {
    method: 'POST',
    body: {
      leaveTypeId: clType.id,
      startDate: holidayDate,
      endDate: holidayDate,
      reason: 'Holiday block test',
    },
  });
  assert(leaveOnHoliday.response.status === 400, 'Leave on holiday is blocked');

  cookieHeader = '';
  const adminForLeadSetup = await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });
  assert(
    adminForLeadSetup.response.ok,
    `Admin login before lead/deputy setup (${adminForLeadSetup.response.status}: ${adminForLeadSetup.data?.message ?? 'unknown'})`,
  );

  const leadEmail = `lead.verify.${Date.now()}@grubpac.test`;
  const deputyEmail = `deputy.verify.${Date.now()}@grubpac.test`;
  const leadRegister = await request('/admin/users', {
    method: 'POST',
    body: {
      firstName: 'Verify',
      lastName: 'Lead',
      email: leadEmail,
      mobile: `6${String(Date.now()).slice(-9)}`,
      password: employeePassword,
      joiningDate: '2026-01-01',
    },
  });
  const deputyRegister = await request('/admin/users', {
    method: 'POST',
    body: {
      firstName: 'Verify',
      lastName: 'Deputy',
      email: deputyEmail,
      mobile: `9${String(Date.now() + 1).slice(-9)}`,
      password: employeePassword,
      joiningDate: '2026-01-01',
    },
  });
  assert(leadRegister.response.status === 201, `Lead user registration works (${leadRegister.data?.message ?? leadRegister.response.status})`);
  assert(deputyRegister.response.status === 201, `Deputy user registration works (${deputyRegister.data?.message ?? deputyRegister.response.status})`);
  const leadId = leadRegister.data.employee?.id;
  const deputyId = deputyRegister.data.employee?.id;
  assert(leadId && deputyId, 'Lead and deputy ids are available');
  const devDept = departmentsList.data.departments.find((d) => d.code === 'DEV');

  await request(`/admin/departments/${devDept?.id}`, {
    method: 'PATCH',
    body: { leadUserId: leadId, deputyUserId: deputyId },
  });
  await request(`/admin/users/${leadId}`, {
    method: 'PATCH',
    body: { departmentId: devDept?.id, reportingManagerId: managerId },
  });
  await request(`/admin/users/${deputyId}`, {
    method: 'PATCH',
    body: { departmentId: devDept?.id, reportingManagerId: managerId },
  });

  const conflictStart = `${year}-06-02`;
  const conflictEnd = `${year}-06-02`;

  cookieHeader = '';
  const leadLogin = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: leadEmail, password: employeePassword },
  });
  assert(leadLogin.response.ok, 'Lead can login');
  await request('/leave/balances/init', { method: 'POST', body: {} });

  const leadLeave = await request('/leave/requests', {
    method: 'POST',
    body: {
      leaveTypeId: clType.id,
      startDate: conflictStart,
      endDate: conflictEnd,
      reason: 'Lead leave',
    },
  });
  assert(leadLeave.response.status === 201, 'Lead can apply leave');

  cookieHeader = '';
  const deputyLogin = await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: deputyEmail, password: employeePassword },
  });
  assert(deputyLogin.response.ok, 'Deputy can login');
  await request('/leave/balances/init', { method: 'POST', body: {} });

  const deputyConflict = await request('/leave/requests', {
    method: 'POST',
    body: {
      leaveTypeId: clType.id,
      startDate: conflictStart,
      endDate: conflictEnd,
      reason: 'Deputy overlap',
    },
  });
  assert(deputyConflict.response.status === 400, 'Lead+Deputy same-day leave is blocked');

  cookieHeader = '';
  const adminRelogin = await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });
  assert(adminRelogin.response.ok, 'Admin relogin for leave admin tests');

  const teamCalendar = await request(`/leave/team-calendar?month=${year}-03`, { method: 'GET' });
  assert(teamCalendar.response.ok, 'Admin team calendar works');

  const adjustBalance = await request(`/leave/balances/${employeeId}`, {
    method: 'PATCH',
    body: {
      leaveTypeId: clType.id,
      year,
      carried: 1,
      reason: 'Verify manual adjustment',
    },
  });
  assert(adjustBalance.response.ok, 'Admin can adjust leave balance');

  const leaveAudits = await request('/admin/audit-logs?page=1&limit=100', { method: 'GET' });
  assert(leaveAudits.response.ok, 'Leave audit logs are readable');
  assert(
    leaveAudits.data.logs?.some((log) => log.action === 'leave_request_created'),
    'Audit logs include leave_request_created',
  );
  assert(
    leaveAudits.data.logs?.some((log) => log.action === 'leave_request_approved'),
    'Audit logs include leave_request_approved',
  );

  console.log('\n--- Phase D: Help / Support tickets ---');
  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: changedPassword },
  });

  const createTicket = await request('/help/tickets', {
    method: 'POST',
    body: {
      title: 'Cannot check in',
      category: 'Attendance',
      description: 'Mobile app shows outside geofence even at office.',
      priority: 'high',
    },
  });
  assert(createTicket.response.status === 201, 'Employee can create help ticket');
  assert(createTicket.data.ticket?.status === 'open', 'New help ticket is open');
  const helpTicketId = createTicket.data.ticket?.id;

  const invalidTicket = await request('/help/tickets', {
    method: 'POST',
    body: {
      title: 'X',
      category: 'BadCategory',
      description: 'short',
    },
  });
  assert(invalidTicket.response.status === 400, 'Invalid help ticket payload is rejected');

  const myTickets = await request('/help/tickets?scope=mine', { method: 'GET' });
  assert(myTickets.response.ok, 'Employee can list own help tickets');
  assert(
    myTickets.data.tickets?.some((item) => item.id === helpTicketId),
    'Created ticket appears in mine list',
  );

  const ticketDetail = await request(`/help/tickets/${helpTicketId}`, { method: 'GET' });
  assert(ticketDetail.response.ok, 'Employee can view own ticket detail');
  assert(Array.isArray(ticketDetail.data.comments), 'Ticket detail includes comments array');

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: managerEmail, password: employeePassword },
  });

  const teamTickets = await request('/help/tickets?scope=team', { method: 'GET' });
  assert(teamTickets.response.ok, 'Manager can list team help tickets');
  assert(
    teamTickets.data.tickets?.some((item) => item.id === helpTicketId),
    'Manager sees direct report ticket in team list',
  );

  const mgrUpdateStatus = await request(`/help/tickets/${helpTicketId}`, {
    method: 'PATCH',
    body: { status: 'in_progress' },
  });
  assert(mgrUpdateStatus.response.ok, 'Manager can update ticket status');
  assert(mgrUpdateStatus.data.ticket?.status === 'in_progress', 'Ticket status becomes in_progress');

  const mgrComment = await request(`/help/tickets/${helpTicketId}/comments`, {
    method: 'POST',
    body: { body: 'Please share your GPS accuracy reading.' },
  });
  assert(mgrComment.response.status === 201, 'Manager can comment on team ticket');

  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: changedPassword },
  });

  const empComment = await request(`/help/tickets/${helpTicketId}/comments`, {
    method: 'POST',
    body: { body: 'Accuracy is about 25 meters.' },
  });
  assert(empComment.response.status === 201, 'Employee can comment on own ticket');

  const detailWithComments = await request(`/help/tickets/${helpTicketId}`, { method: 'GET' });
  assert(
    detailWithComments.data.comments?.length >= 2,
    'Ticket detail returns comment thread',
  );

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });
  const otherEmployeeEmail = `emp3.verify.${Date.now()}@grubpac.test`;
  const otherEmployeeRegister = await request('/admin/users', {
    method: 'POST',
    body: {
      firstName: 'Verify',
      lastName: 'Employee 3',
      email: otherEmployeeEmail,
      mobile: `6${String(Date.now() + 2).slice(-9)}`,
      password: employeePassword,
      joiningDate: '2026-01-01',
    },
  });
  assert(otherEmployeeRegister.response.status === 201, 'Third employee registered for help authz test');
  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: otherEmployeeEmail, password: employeePassword },
  });
  const forbiddenTicket = await request(`/help/tickets/${helpTicketId}`, { method: 'GET' });
  assert(forbiddenTicket.response.status === 403, 'Other employee cannot view ticket');

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });

  const allTickets = await request('/help/tickets?scope=all', { method: 'GET' });
  assert(allTickets.response.ok, 'Admin can list all help tickets');
  assert(
    allTickets.data.tickets?.some((item) => item.id === helpTicketId),
    'Admin all-tickets list includes employee ticket',
  );

  const adminResolve = await request(`/help/tickets/${helpTicketId}`, {
    method: 'PATCH',
    body: { status: 'resolved' },
  });
  assert(adminResolve.response.ok, 'Admin can resolve ticket');
  assert(adminResolve.data.ticket?.status === 'resolved', 'Ticket status becomes resolved');

  const helpAudits = await request('/admin/audit-logs?page=1&limit=100', { method: 'GET' });
  assert(
    helpAudits.data.logs?.some((log) => log.action === 'help_ticket_created'),
    'Audit logs include help_ticket_created',
  );
  assert(
    helpAudits.data.logs?.some((log) => log.action === 'help_ticket_status_updated'),
    'Audit logs include help_ticket_status_updated',
  );
  assert(
    helpAudits.data.logs?.some((log) => log.action === 'help_ticket_comment_added'),
    'Audit logs include help_ticket_comment_added',
  );

  console.log('\n--- Phase C: Salary & leave impact ---');
  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });

  const salaryMonth = getISTDateInputValue().slice(0, 7);
  const salaryEffective = `${new Date().getFullYear()}-01-01`;

  const setSalary = await request(`/salary/users/${employeeId}`, {
    method: 'PATCH',
    body: { monthlySalary: 50000, salaryEffectiveFrom: salaryEffective },
  });
  assert(setSalary.response.ok, 'Admin can set employee monthly salary');
  assert(setSalary.data.employee?.monthlySalary === 50000, 'Salary is stored on user');
  assert(setSalary.data.employee?.salaryCurrency === 'INR', 'Salary currency is INR');

  const badSalary = await request(`/salary/users/${employeeId}`, {
    method: 'PATCH',
    body: { monthlySalary: -100 },
  });
  assert(badSalary.response.status === 400, 'Negative salary is rejected');

  const adminSummary = await request(
    `/salary/summary?userId=${employeeId}&month=${salaryMonth}`,
    { method: 'GET' },
  );
  assert(adminSummary.response.ok, 'Admin can fetch salary summary');
  assert(
    adminSummary.data.summary?.month === salaryMonth,
    'Summary returns requested month',
  );
  assert(
    typeof adminSummary.data.summary?.workingDaysInMonth === 'number',
    'Summary includes workingDaysInMonth',
  );
  assert(
    typeof adminSummary.data.summary?.presentDays === 'number',
    'Summary includes presentDays',
  );
  assert(
    typeof adminSummary.data.summary?.payableEstimate === 'number',
    'Summary includes payableEstimate',
  );
  assert(
    adminSummary.data.summary?.presentDays >= 1,
    'Present days reflect allowed check-in in month',
  );

  const badMonth = await request(`/salary/summary?userId=${employeeId}&month=2026-13`, {
    method: 'GET',
  });
  assert(badMonth.response.status === 400, 'Invalid month query is rejected');

  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: changedPassword },
  });

  const ownSummary = await request(`/salary/summary?month=${salaryMonth}`, { method: 'GET' });
  assert(ownSummary.response.ok, 'Employee can fetch own salary summary with salary.read');

  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: otherEmployeeEmail, password: employeePassword },
  });
  const forbiddenSummary = await request(
    `/salary/summary?userId=${employeeId}&month=${salaryMonth}`,
    { method: 'GET' },
  );
  assert(forbiddenSummary.response.status === 403, 'Other employee cannot view peer salary summary');

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: managerEmail, password: employeePassword },
  });
  const mgrSummary = await request(
    `/salary/summary?userId=${employeeId}&month=${salaryMonth}`,
    { method: 'GET' },
  );
  assert(mgrSummary.response.ok, 'Reporting manager can view direct report summary (read_team)');

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });

  const exportRes = await fetch(`${BASE}/salary/export?month=${salaryMonth}`, {
    method: 'GET',
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
  absorbCookies(exportRes);
  assert(exportRes.ok, 'Admin can export salary Excel');
  assert(
    exportRes.headers.get('content-type')?.includes('spreadsheet'),
    'Export returns spreadsheet content type',
  );

  const salaryAudits = await request('/admin/audit-logs?page=1&limit=100', { method: 'GET' });
  assert(
    salaryAudits.data.logs?.some((log) => log.action === 'salary_updated'),
    'Audit logs include salary_updated without amount values',
  );
  const salaryAudit = salaryAudits.data.logs?.find((log) => log.action === 'salary_updated');
  assert(
    salaryAudit?.metadata?.fieldsUpdated &&
      !salaryAudit.metadata?.monthlySalary,
    'Salary audit logs userId/fields only (no amount)',
  );

  const permissionsAfterSeed = await request('/admin/permissions', { method: 'GET' });
  const salaryGroup = permissionsAfterSeed.data.groups?.find((group) => group.label === 'Salary');
  assert(
    salaryGroup?.permissions?.some((item) => item.key === 'salary.read_team'),
    'Permission matrix includes salary.read_team',
  );

  console.log('\n--- Phase E: Leave extras, delegation, reports ---');
  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });

  const leaveTypesE = await request('/leave/types', { method: 'GET' });
  const coType = leaveTypesE.data.types?.find((t) => t.code === 'CO');
  assert(coType?.name === 'Compensatory Off', 'Comp-off (CO) leave type is seeded');

  const reportsSummary = await request('/admin/reports/summary', { method: 'GET' });
  assert(reportsSummary.response.ok, 'Admin reports summary endpoint works');
  assert(typeof reportsSummary.data.summary?.pendingLeaveRequests === 'number', 'Reports include pending leave count');
  assert(typeof reportsSummary.data.summary?.openHelpTickets === 'number', 'Reports include open help tickets');

  const enableSandwich = await request('/admin/office-settings', {
    method: 'PUT',
    body: {
      name: 'Grubpac Technologies — Test Office',
      latitude: OFFICE_LAT,
      longitude: OFFICE_LNG,
      radiusMeters: 100,
      maxAccuracyMeters: 50,
      sandwichLeaveEnabled: true,
    },
  });
  assert(enableSandwich.response.ok, 'Admin can enable sandwich leave policy');

  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: changedPassword },
  });

  const halfDayDate = `${year}-07-15`;
  const halfDayLeave = await request('/leave/requests', {
    method: 'POST',
    body: {
      leaveTypeId: clType.id,
      startDate: halfDayDate,
      endDate: halfDayDate,
      halfDay: 'am',
      reason: 'Half day personal',
    },
  });
  assert(halfDayLeave.response.status === 201, 'Employee can apply half-day leave');
  assert(halfDayLeave.data.request?.days === 0.5, 'Half-day leave counts as 0.5 days');
  assert(halfDayLeave.data.request?.halfDay === 'am', 'Half-day AM is stored on request');
  const halfDayLeaveId = halfDayLeave.data.request?.id;

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });

  const approveHalfDay = await request(`/leave/requests/${halfDayLeaveId}/approve`, {
    method: 'POST',
    body: { comment: 'Approved for salary half-day test' },
  });
  assert(approveHalfDay.response.ok, 'Admin can approve half-day leave');

  const halfDaySalaryMonth = halfDayDate.slice(0, 7);
  const halfDaySalarySummary = await request(
    `/salary/summary?userId=${employeeId}&month=${halfDaySalaryMonth}`,
    { method: 'GET' },
  );
  assert(halfDaySalarySummary.response.ok, 'Salary summary includes approved half-day leave month');
  assert(
    halfDaySalarySummary.data.summary?.paidLeaveDays === 0.5,
    'Paid leave days count half-day as 0.5 not 1 full day',
  );

  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: changedPassword },
  });

  const sandwichStart = `${year}-03-06`;
  const sandwichEnd = `${year}-03-09`;
  const sandwichPreview = await request(
    `/leave/requests/preview?startDate=${sandwichStart}&endDate=${sandwichEnd}`,
    { method: 'GET' },
  );
  assert(
    sandwichPreview.response.ok && sandwichPreview.data.days === 4,
    'Sandwich preview counts weekend between Fri and Mon as 4 days',
  );
  assert(sandwichPreview.data.sandwichApplied === true, 'Preview indicates sandwich policy applied');

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });

  const encashResult = await request(`/leave/balances/${employeeId}/encash`, {
    method: 'POST',
    body: {
      leaveTypeId: clType.id,
      year,
      days: 1,
      reason: 'Verify encashment record',
    },
  });
  assert(encashResult.response.ok, 'Admin can record leave encashment');
  assert(encashResult.data.balance?.encashed >= 1, 'Encashment increments encashed counter');

  const cfResult = await request('/leave/carry-forward', {
    method: 'POST',
    body: { fromYear: year },
  });
  assert(cfResult.response.ok, 'Admin can apply year-end carry-forward');
  assert(typeof cfResult.data.adjustments === 'number', 'Carry-forward returns adjustment count');

  const delegateEmail = `delegate.verify.${Date.now()}@grubpac.test`;
  const delegateRegister = await request('/admin/users', {
    method: 'POST',
    body: {
      firstName: 'Verify',
      lastName: 'Delegate',
      email: delegateEmail,
      mobile: `9${String(Date.now() + 3).slice(-9)}`,
      password: employeePassword,
      joiningDate: '2026-01-01',
    },
  });
  assert(delegateRegister.response.status === 201, `Delegate user created (${delegateRegister.data?.message ?? delegateRegister.response.status})`);
  const delegateId = delegateRegister.data.employee?.id;
  assert(delegateId, 'Delegate user id is available');

  const rolesForDelegate = await request('/admin/roles', { method: 'GET' });
  const mgrRole = rolesForDelegate.data.roles?.find((r) => r.slug === 'reporting-manager');
  await request(`/admin/users/${delegateId}`, {
    method: 'PATCH',
    body: { roleId: mgrRole?.id },
  });

  await request(`/admin/users/${managerId}`, {
    method: 'PATCH',
    body: { delegateApproverId: delegateId },
  });

  cookieHeader = '';
  await request('/auth/user/login', {
    method: 'POST',
    body: { identifier: employeeEmail, password: changedPassword },
  });

  const delegateLeaveStart = `${year}-07-20`;
  const delegateLeaveEnd = `${year}-07-20`;
  const delegateTestLeave = await request('/leave/requests', {
    method: 'POST',
    body: {
      leaveTypeId: clType.id,
      startDate: delegateLeaveStart,
      endDate: delegateLeaveEnd,
      reason: 'Delegate approval test',
    },
  });
  assert(delegateTestLeave.response.status === 201, 'Leave request created for delegate approval test');
  const delegateLeaveId = delegateTestLeave.data.request?.id;

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: delegateEmail, password: employeePassword },
  });

  const delegateApprove = await request(`/leave/requests/${delegateLeaveId}/approve`, {
    method: 'POST',
    body: { comment: 'Approved by delegate' },
  });
  assert(delegateApprove.response.ok, 'Delegate approver can approve leave');
  assert(delegateApprove.data.request?.status === 'approved', 'Delegate approval sets status approved');

  cookieHeader = '';
  await request('/auth/admin/login', {
    method: 'POST',
    body: { identifier: 'admin@grubpac.com', password: 'Grubpac@Admin2026' },
  });
  const phaseEAudits = await request('/admin/audit-logs?page=1&limit=100', { method: 'GET' });
  assert(
    phaseEAudits.data.logs?.some((log) => log.action === 'leave_encashment_recorded'),
    'Audit logs include leave_encashment_recorded',
  );
  assert(
    phaseEAudits.data.logs?.some((log) => log.action === 'leave_carry_forward_applied'),
    'Audit logs include leave_carry_forward_applied',
  );

  const logout = await request('/auth/logout', { method: 'POST' });
  assert(logout.response.ok, 'Logout clears session');

  httpServer.close();
  await disconnectDatabase();

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  if (httpServer) httpServer.close();
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
