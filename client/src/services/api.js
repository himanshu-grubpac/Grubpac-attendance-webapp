import axios from 'axios';

let csrfToken = null;

function readCsrfFromCookie() {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)attendance_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setCsrfToken(token) {
  csrfToken = token ?? null;
}

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const method = (config.method ?? 'get').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const token = csrfToken ?? readCsrfFromCookie();
    if (token) {
      config.headers['X-CSRF-Token'] = token;
    }
  }
  return config;
});

api.interceptors.response.use(
  (response) => {
    if (response.data?.csrfToken) {
      setCsrfToken(response.data.csrfToken);
    }
    return response;
  },
  (error) => {
    if (error?.response?.status === 401 && !error.config?.url?.includes('/auth/')) {
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);

export const authApi = {
  adminLogin: (identifier, password) =>
    api.post('/auth/admin/login', { identifier, password }).then((r) => r.data),
  employeeLogin: (identifier, password) =>
    api.post('/auth/user/login', { identifier, password }).then((r) => r.data),
  logout: () => api.post('/auth/logout').then((r) => r.data),
  me: () => api.get('/auth/me').then((r) => r.data),
  updateProfile: (payload) =>
    api.patch('/auth/me', payload).then((r) => r.data),
  changePassword: (payload) =>
    api.post('/auth/change-password', payload).then((r) => r.data),
};

export const adminApi = {
  listPermissions: () => api.get('/admin/permissions').then((r) => r.data),
  listRoles: (params = {}) => api.get('/admin/roles', { params }).then((r) => r.data),
  createRole: (payload) => api.post('/admin/roles', payload).then((r) => r.data),
  updateRole: (id, payload) => api.patch(`/admin/roles/${id}`, payload).then((r) => r.data),
  deleteRole: (id) => api.delete(`/admin/roles/${id}`).then((r) => r.data),
  listDepartments: () => api.get('/admin/departments').then((r) => r.data),
  createDepartment: (payload) => api.post('/admin/departments', payload).then((r) => r.data),
  updateDepartment: (id, payload) =>
    api.patch(`/admin/departments/${id}`, payload).then((r) => r.data),
  deleteDepartment: (id) => api.delete(`/admin/departments/${id}`).then((r) => r.data),
  listManagers: (params = {}) => api.get('/admin/users/managers', { params }).then((r) => r.data),
  listEmployees: (params = {}) =>
    api.get('/admin/users', { params }).then((r) => r.data),
  getEmployee: (id) => api.get(`/admin/users/${id}`).then((r) => r.data),
  registerEmployee: (payload) =>
    api.post('/admin/users', payload).then((r) => r.data),
  updateEmployee: (id, payload) =>
    api.patch(`/admin/users/${id}`, payload).then((r) => r.data),
  updateEmployeeStatus: (id, isActive) =>
    api.patch(`/admin/users/${id}`, { isActive }).then((r) => r.data),
  resetEmployeePassword: (id, payload) =>
    api.patch(`/admin/users/${id}/password`, payload).then((r) => r.data),
  downloadTemplate: () =>
    api.get('/admin/users/template', { responseType: 'blob' }).then((r) => r.data),
  bulkUpload: (file) => {
    const form = new FormData();
    form.append('file', file);
    return api
      .post('/admin/users/bulk-upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data);
  },
  getOfficeSettings: () =>
    api.get('/admin/office-settings').then((r) => r.data),
  updateOfficeSettings: (payload) =>
    api.put('/admin/office-settings', payload).then((r) => r.data),
  listAttendance: (params) =>
    api.get('/admin/attendance', { params }).then((r) => r.data),
  listAuditLogs: (params = {}) =>
    api.get('/admin/audit-logs', { params }).then((r) => r.data),
  getReportsSummary: () => api.get('/admin/reports/summary').then((r) => r.data),
};

export const attendanceApi = {
  getToday: () => api.get('/attendance/today').then((r) => r.data),
  checkIn: (payload) =>
    api.post('/attendance/check-in', payload).then((r) => r.data),
  checkOut: (payload) =>
    api.post('/attendance/check-out', payload).then((r) => r.data),
  getHistory: (params = {}) =>
    api.get('/attendance/history', { params }).then((r) => r.data),
  getMonthSummary: (params = {}) =>
    api.get('/attendance/month-summary', { params }).then((r) => r.data),
};

export const notificationsApi = {
  list: (params = {}) => api.get('/notifications', { params }).then((r) => r.data),
  getUnreadCount: () => api.get('/notifications/unread-count').then((r) => r.data),
  markRead: (id) => api.post(`/notifications/${id}/read`).then((r) => r.data),
  markAllRead: () => api.post('/notifications/read-all').then((r) => r.data),
  clearAll: () => api.delete('/notifications/clear-all').then((r) => r.data),
};

export const leaveApi = {
  listTypes: () => api.get('/leave/types').then((r) => r.data),
  listPolicies: () => api.get('/leave/policies').then((r) => r.data),
  updatePolicy: (id, payload) => api.patch(`/leave/policies/${id}`, payload).then((r) => r.data),
  getMyBalances: (params = {}) => api.get('/leave/balances/me', { params }).then((r) => r.data),
  getBalances: (params = {}) => api.get('/leave/balances', { params }).then((r) => r.data),
  adjustBalance: (userId, payload) =>
    api.patch(`/leave/balances/${userId}`, payload).then((r) => r.data),
  initBalances: (payload = {}) => api.post('/leave/balances/init', payload).then((r) => r.data),
  previewDays: (params) => api.get('/leave/requests/preview', { params }).then((r) => r.data),
  listRequests: (params = {}) => api.get('/leave/requests', { params }).then((r) => r.data),
  createRequest: (payload) => api.post('/leave/requests', payload).then((r) => r.data),
  cancelRequest: (id) => api.post(`/leave/requests/${id}/cancel`).then((r) => r.data),
  approveRequest: (id, payload = {}) =>
    api.post(`/leave/requests/${id}/approve`, payload).then((r) => r.data),
  rejectRequest: (id, payload = {}) =>
    api.post(`/leave/requests/${id}/reject`, payload).then((r) => r.data),
  getTeamCalendar: (params = {}) => api.get('/leave/team-calendar', { params }).then((r) => r.data),
  listHolidays: (params = {}) => api.get('/leave/holidays', { params }).then((r) => r.data),
  createHoliday: (payload) => api.post('/leave/holidays', payload).then((r) => r.data),
  updateHoliday: (id, payload) => api.patch(`/leave/holidays/${id}`, payload).then((r) => r.data),
  deleteHoliday: (id) => api.delete(`/leave/holidays/${id}`).then((r) => r.data),
  encashBalance: (userId, payload) =>
    api.post(`/leave/balances/${userId}/encash`, payload).then((r) => r.data),
  applyCarryForward: (payload) => api.post('/leave/carry-forward', payload).then((r) => r.data),
  runAccrualJob: () => api.post('/leave/jobs/accrual').then((r) => r.data),
};

export const helpApi = {
  listTickets: (params = {}) => api.get('/help/tickets', { params }).then((r) => r.data),
  createTicket: (payload) => api.post('/help/tickets', payload).then((r) => r.data),
  getTicket: (id) => api.get(`/help/tickets/${id}`).then((r) => r.data),
  updateTicketStatus: (id, payload) =>
    api.patch(`/help/tickets/${id}`, payload).then((r) => r.data),
  addComment: (id, payload) =>
    api.post(`/help/tickets/${id}/comments`, payload).then((r) => r.data),
};

export const salaryApi = {
  updateUserSalary: (id, payload) =>
    api.patch(`/salary/users/${id}`, payload).then((r) => r.data),
  getSummary: (params) => api.get('/salary/summary', { params }).then((r) => r.data),
  listSummaries: (month) =>
    api.get('/salary/summaries', { params: { month } }).then((r) => r.data),
  exportSummary: (month) =>
    api.get('/salary/export', { params: { month }, responseType: 'blob' }).then((r) => r.data),
};

export function getErrorMessage(error) {
  const data = error?.response?.data;
  if (data?.errors?.length) {
    return data.errors.map((item) => item.message).join(' ');
  }
  return (
    data?.message ||
    data?.rejectionReasons?.join(' ') ||
    error?.message ||
    'Something went wrong.'
  );
}

export function getFieldErrors(error) {
  const data = error?.response?.data;
  if (!data?.errors?.length) return {};
  return data.errors.reduce((acc, item) => {
    acc[item.path || 'form'] = item.message;
    return acc;
  }, {});
}

export default api;
