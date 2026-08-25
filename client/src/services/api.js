import axios from 'axios';
import { getDeviceFingerprint } from '../utils/deviceFingerprint.js';

let csrfToken = null;

function readCsrfFromCookie() {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)attendance_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setCsrfToken(token) {
  csrfToken = token ?? null;
}

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function normalizeApiPath(url) {
  if (url.startsWith('/api/')) return url.slice(4);
  if (url.startsWith('/api')) return url.slice(4) || '/';
  return url;
}

function parseDownloadErrorBody(data, fallback) {
  if (!data) return fallback;
  try {
    if (data instanceof ArrayBuffer) {
      const text = new TextDecoder().decode(data);
      const body = JSON.parse(text);
      return body.message ?? fallback;
    }
    if (typeof data === 'object' && data.message) return data.message;
  } catch {
    // Non-JSON error body — keep default message.
  }
  return fallback;
}

async function downloadExcelBlob(
  url,
  { errorMessage = 'Failed to download Excel file.', onProgress } = {},
) {
  const path = normalizeApiPath(url);

  try {
    const response = await api.get(path, {
      responseType: 'arraybuffer',
      headers: { Accept: EXCEL_MIME },
      onDownloadProgress: onProgress
        ? (event) => {
            if (event.total > 0) {
              onProgress(Math.round((event.loaded / event.total) * 100));
            }
          }
        : undefined,
    });

    const buffer = response.data;
    if (buffer.byteLength < 4) {
      throw new Error('Downloaded Excel file is empty.');
    }

    const magic = new Uint8Array(buffer.slice(0, 2));
    if (magic[0] !== 0x50 || magic[1] !== 0x4b) {
      throw new Error('Downloaded file is not a valid Excel workbook.');
    }

    onProgress?.(100);
    return new Blob([buffer], { type: EXCEL_MIME });
  } catch (error) {
    if (!error?.response) {
      throw error instanceof Error ? error : new Error(errorMessage);
    }
    throw new Error(parseDownloadErrorBody(error.response.data, errorMessage));
  }
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
  adminLogin: (identifier, password) => {
    const { deviceId } = getDeviceFingerprint();
    return api.post('/auth/admin/login', { identifier, password, deviceId }).then((r) => r.data);
  },
  employeeLogin: (identifier, password) => {
    const { deviceId } = getDeviceFingerprint();
    return api.post('/auth/user/login', { identifier, password, deviceId }).then((r) => r.data);
  },
  logout: () => api.post('/auth/logout').then((r) => r.data),
  me: () => api.get('/auth/me').then((r) => r.data),
  updateProfile: (payload) =>
    api.patch('/auth/me', payload).then((r) => r.data),
  changePassword: (payload) =>
    api.post('/auth/change-password', payload).then((r) => r.data),
  forgotPassword: (email) =>
    api.post('/auth/forgot-password', { email }).then((r) => r.data),
  verifyResetToken: (token) =>
    api.post('/auth/reset-password/verify', { token }).then((r) => r.data),
  resetPassword: (payload) =>
    api.post('/auth/reset-password', payload).then((r) => r.data),
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
  getEmployeeStats: () => api.get('/admin/users/stats').then((r) => r.data),
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
    downloadExcelBlob('/api/admin/users/template', {
      errorMessage: 'Failed to download template.',
    }),
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
    api
      .get('/admin/office-settings', {
        params: { _: Date.now() },
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      })
      .then((r) => r.data),
  updateOfficeSettings: (payload) =>
    api
      .put('/admin/office-settings', payload, {
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      })
      .then((r) => r.data),
  listAttendance: (params) =>
    api.get('/admin/attendance', { params }).then((r) => r.data),
  getQuarterWarnings: () =>
    api.get('/admin/attendance/quarter-warnings').then((r) => r.data),
  resetQuarterWarnings: (userIds) =>
    api.post('/admin/attendance/quarter-warnings/reset', { userIds }).then((r) => r.data),
  listWeekConfirmations: (weekStart) =>
    api.get('/admin/attendance/week-confirmations', { params: { weekStart } }).then((r) => r.data),
  confirmWeekAttendance: (payload) =>
    api.post('/admin/attendance/week-confirmations', payload).then((r) => r.data),
  unconfirmWeekAttendance: (params) =>
    api.delete('/admin/attendance/week-confirmations', { params }).then((r) => r.data),
  editAttendanceRecord: (id, payload) =>
    api.patch(`/admin/attendance/records/${id}`, payload).then((r) => r.data),
  upsertAttendanceRecord: (payload) =>
    api.post('/admin/attendance/records', payload).then((r) => r.data),
  listAuditLogs: (params = {}) =>
    api.get('/admin/audit-logs', { params }).then((r) => r.data),
  getReportsSummary: () => api.get('/admin/reports/summary').then((r) => r.data),
};

export const attendanceApi = {
  getToday: () => api.get('/attendance/today').then((r) => r.data),
  checkIn: (payload, lateNote) => {
    const { deviceId } = getDeviceFingerprint();
    return api
      .post('/attendance/check-in', {
        ...payload,
        deviceId,
        ...(lateNote ? { lateNote } : {}),
      })
      .then((r) => r.data);
  },
  checkOut: (payload) => {
    const { deviceId } = getDeviceFingerprint();
    return api
      .post('/attendance/check-out', {
        ...payload,
        deviceId,
      })
      .then((r) => r.data);
  },
  getHistory: (params = {}) =>
    api.get('/attendance/history', { params }).then((r) => r.data),
  getMonthSummary: (params = {}) =>
    api.get('/attendance/month-summary', { params }).then((r) => r.data),
  getQuarterWarnings: () =>
    api
      .get('/attendance/quarter-warnings', {
        params: { _: Date.now() },
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      })
      .then((r) => r.data),
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
  createType: (payload) => api.post('/leave/types', payload).then((r) => r.data),
  listPolicies: (params = {}) => api.get('/leave/policies', { params }).then((r) => r.data),
  createPolicy: (payload) => api.post('/leave/policies', payload).then((r) => r.data),
  updatePolicy: (id, payload) => api.patch(`/leave/policies/${id}`, payload).then((r) => r.data),
  getMyBalances: (params = {}) => api.get('/leave/balances/me', { params }).then((r) => r.data),
  getBalances: (params = {}) => api.get('/leave/balances', { params }).then((r) => r.data),
  adjustBalance: (userId, payload) =>
    api.patch(`/leave/balances/${userId}`, payload).then((r) => r.data),
  getAdjustmentGrid: (params = {}) =>
    api.get('/leave/adjustments/grid', { params }).then((r) => r.data),
  batchAdjustCarried: (payload) =>
    api.post('/leave/adjustments/batch', payload).then((r) => r.data),
  downloadCarryTemplate: (params = {}) => {
    const search = new URLSearchParams();
    if (params.year != null) search.set('year', String(params.year));
    if (params.fromYear != null) search.set('fromYear', String(params.fromYear));
    if (params.toYear != null) search.set('toYear', String(params.toYear));
    if (params.departmentId) search.set('departmentId', params.departmentId);
    if (params.userIds) search.set('userIds', params.userIds);
    const query = search.toString();
    return downloadExcelBlob(`/api/leave/carry-bulk/template${query ? `?${query}` : ''}`, {
      errorMessage: 'Failed to download carried leave template.',
    });
  },
  downloadCarryAuditReport: (params = {}, { onProgress } = {}) => {
    const search = new URLSearchParams();
    if (params.year != null) search.set('year', String(params.year));
    if (params.fromYear != null) search.set('fromYear', String(params.fromYear));
    if (params.toYear != null) search.set('toYear', String(params.toYear));
    if (params.departmentId) search.set('departmentId', params.departmentId);
    if (params.userIds) search.set('userIds', params.userIds);
    const query = search.toString();
    return downloadExcelBlob(`/api/leave/carry-bulk/audit-report${query ? `?${query}` : ''}`, {
      errorMessage: 'Failed to download leave audit report.',
      onProgress,
    });
  },
  uploadCarryBulk: (file) => {
    const form = new FormData();
    form.append('file', file);
    return api
      .post('/leave/carry-bulk/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then((r) => r.data);
  },
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
  listHolidayCategories: () => api.get('/leave/holiday-categories').then((r) => r.data),
  createHolidayCategory: (payload) => api.post('/leave/holiday-categories', payload).then((r) => r.data),
  updateHolidayCategory: (id, payload) => api.patch(`/leave/holiday-categories/${id}`, payload).then((r) => r.data),
  deleteHolidayCategory: (id) => api.delete(`/leave/holiday-categories/${id}`).then((r) => r.data),
  createHoliday: (payload) => api.post('/leave/holidays', payload).then((r) => r.data),
  updateHoliday: (id, payload) => api.patch(`/leave/holidays/${id}`, payload).then((r) => r.data),
  deleteHoliday: (id) => api.delete(`/leave/holidays/${id}`).then((r) => r.data),
  listRecurringHolidayRules: () => api.get('/leave/recurring-rules').then((r) => r.data),
  updateRecurringHolidayRules: (payload) => api.put('/leave/recurring-rules', payload).then((r) => r.data),
  materializeRecurringHolidays: (payload) =>
    api.post('/leave/holidays/materialize-recurring', payload).then((r) => r.data),
};

export const helpApi = {
  listTickets: (params = {}) => api.get('/help/tickets', { params }).then((r) => r.data),
  createTicket: (payload) => api.post('/help/tickets', payload).then((r) => r.data),
  getTicket: (id) => api.get(`/help/tickets/${id}`).then((r) => r.data),
  updateTicketStatus: (id, payload) =>
    api.patch(`/help/tickets/${id}`, payload).then((r) => r.data),
  addComment: (id, payload) =>
    api.post(`/help/tickets/${id}/comments`, payload).then((r) => r.data),
  presignAttachment: (ticketId, payload) =>
    api.post(`/help/tickets/${ticketId}/attachments/presign`, payload).then((r) => r.data),
  confirmAttachment: (ticketId, attachmentId) =>
    api
      .post(`/help/tickets/${ticketId}/attachments/${attachmentId}/confirm`)
      .then((r) => r.data),
  getAttachmentDownloadUrl: (ticketId, attachmentId) =>
    api
      .get(`/help/tickets/${ticketId}/attachments/${attachmentId}/download`)
      .then((r) => r.data),
};

export const salaryApi = {
  updateUserSalary: (id, payload) =>
    api.patch(`/salary/users/${id}`, payload).then((r) => r.data),
  getSummary: (params) => api.get('/salary/summary', { params }).then((r) => r.data),
  listSummaries: (month) =>
    api.get('/salary/summaries', { params: { month } }).then((r) => r.data),
  exportSummary: (month) =>
    downloadExcelBlob(`/api/salary/export?month=${encodeURIComponent(month)}`, {
      errorMessage: 'Failed to export salary summary.',
    }),
  getSettings: () => api.get('/salary/settings').then((r) => r.data),
  updateSettings: (payload) => api.patch('/salary/settings', payload).then((r) => r.data),
  listStructure: (params = {}) =>
    api.get('/salary/structure', { params }).then((r) => r.data),
  listTransfers: (params = {}) =>
    api.get('/salary/transfers', { params }).then((r) => r.data),
  generateTransfers: (payload) =>
    api.post('/salary/transfers/generate', payload).then((r) => r.data),
  updateTransfer: (id, payload) =>
    api.patch(`/salary/transfers/${id}`, payload).then((r) => r.data),
};

export const demoFaqApi = {
  list: () => api.get('/demo-faq').then((r) => r.data),
  listManage: () => api.get('/demo-faq/manage').then((r) => r.data),
  create: (payload) => api.post('/demo-faq', payload).then((r) => r.data),
  update: (id, payload) => api.put(`/demo-faq/${id}`, payload).then((r) => r.data),
  remove: (id) => api.delete(`/demo-faq/${id}`).then((r) => r.data),
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
