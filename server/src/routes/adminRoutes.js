import { Router } from 'express';
import multer from 'multer';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { singleFileUpload } from '../middleware/upload.js';
import {
  bulkUploadEmployees,
  previewBulkUploadEmployees,
  downloadEmployeeTemplate,
  exportAuditLogs,
  getOfficeSettingsHandler,
  getTeamTodayStatusAdmin,
  listAttendance,
  editAttendanceRecord,
  upsertAttendanceRecord,
  getQuarterWarningSummary,
  resetQuarterWarnings,
  listWeekConfirmations,
  confirmWeekAttendance,
  unconfirmWeekAttendance,
  listAuditLogs,
  runAuditArchiveHandler,
  getAuditArchiveStatusHandler,
  getEmployee,
  getEmployeeStats,
  listEmployees,
  listManagers,
  registerEmployee,
  resetEmployeePassword,
  resetEmployeePin,
  updateEmployee,
  updateOfficeSettings,
} from '../controllers/adminController.js';
import { getReportsSummaryHandler } from '../controllers/reportsController.js';
import {
  createDepartment,
  deleteDepartment,
  listDepartments,
  updateDepartment,
} from '../controllers/departmentsController.js';
import {
  createRole,
  deleteRole,
  listPermissions,
  listRoles,
  updateRole,
} from '../controllers/rolesController.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed =
      file.mimetype.includes('spreadsheet') ||
      file.mimetype.includes('excel') ||
      file.originalname.endsWith('.xlsx') ||
      file.originalname.endsWith('.xls');
    if (!allowed) {
      return cb(new Error('Only Excel files are allowed.'));
    }
    return cb(null, true);
  },
});

const router = Router();

router.use(authenticate);

router.get(
  '/permissions',
  requirePermission(PERMISSIONS.RBAC_CATALOG_R, PERMISSIONS.RBAC_ROLE_R),
  asyncHandler(listPermissions),
);
router.get(
  '/roles',
  requirePermission(PERMISSIONS.RBAC_ROLE_R, PERMISSIONS.RBAC_USER_R),
  asyncHandler(listRoles),
);
router.post('/roles', requirePermission(PERMISSIONS.RBAC_ROLE_C), asyncHandler(createRole));
router.patch('/roles/:id', requirePermission(PERMISSIONS.RBAC_ROLE_U), asyncHandler(updateRole));
router.delete('/roles/:id', requirePermission(PERMISSIONS.RBAC_ROLE_D), asyncHandler(deleteRole));

router.get(
  '/departments',
  requirePermission(PERMISSIONS.OPS_DEPARTMENT_R),
  asyncHandler(listDepartments),
);
router.post(
  '/departments',
  requirePermission(PERMISSIONS.OPS_DEPARTMENT_C),
  asyncHandler(createDepartment),
);
router.patch(
  '/departments/:id',
  requirePermission(PERMISSIONS.OPS_DEPARTMENT_U),
  asyncHandler(updateDepartment),
);
router.delete(
  '/departments/:id',
  requirePermission(PERMISSIONS.OPS_DEPARTMENT_D),
  asyncHandler(deleteDepartment),
);

router.post(
  '/users',
  requirePermission(PERMISSIONS.EMPLOYEES_REGISTER_C, PERMISSIONS.EMPLOYEES_RECORD_C),
  asyncHandler(registerEmployee),
);
router.get(
  '/users',
  requirePermission(PERMISSIONS.EMPLOYEES_RECORD_R, PERMISSIONS.EMPLOYEES_STATS_R),
  asyncHandler(listEmployees),
);
router.get(
  '/users/stats',
  requirePermission(PERMISSIONS.EMPLOYEES_STATS_R),
  asyncHandler(getEmployeeStats),
);
router.get(
  '/users/managers',
  requirePermission(PERMISSIONS.EMPLOYEES_EMPLOYMENT_R, PERMISSIONS.EMPLOYEES_RECORD_R),
  asyncHandler(listManagers),
);
router.get(
  '/users/template',
  requirePermission(
    PERMISSIONS.EMPLOYEES_BULK_EXPORT_X0,
    PERMISSIONS.EMPLOYEES_BULK_EXPORT_R,
    PERMISSIONS.EMPLOYEES_RECORD_X0,
  ),
  asyncHandler(downloadEmployeeTemplate),
);
router.patch(
  '/users/:id/password',
  requirePermission(PERMISSIONS.EMPLOYEES_CREDENTIALS_X0),
  asyncHandler(resetEmployeePassword),
);
router.patch(
  '/users/:id/pin',
  requirePermission(PERMISSIONS.EMPLOYEES_CREDENTIALS_X1),
  asyncHandler(resetEmployeePin),
);
router.patch(
  '/users/:id',
  requirePermission(
    PERMISSIONS.EMPLOYEES_RECORD_U,
    PERMISSIONS.EMPLOYEES_EMPLOYMENT_U,
    PERMISSIONS.EMPLOYEES_STATUS_U,
    PERMISSIONS.EMPLOYEES_DELEGATE_U,
    PERMISSIONS.EMPLOYEES_MANAGED_DEPTS_U,
  ),
  asyncHandler(updateEmployee),
);
router.post(
  '/users/bulk-upload',
  requirePermission(PERMISSIONS.EMPLOYEES_BULK_UPLOAD_C, PERMISSIONS.EMPLOYEES_BULK_UPLOAD_U),
  singleFileUpload(upload),
  asyncHandler(bulkUploadEmployees),
);
router.post(
  '/users/bulk-preview',
  requirePermission(
    PERMISSIONS.EMPLOYEES_BULK_UPLOAD_C,
    PERMISSIONS.EMPLOYEES_BULK_UPLOAD_U,
    PERMISSIONS.EMPLOYEES_BULK_UPLOAD_X0,
  ),
  singleFileUpload(upload),
  asyncHandler(previewBulkUploadEmployees),
);
router.get(
  '/users/:id',
  requirePermission(
    PERMISSIONS.EMPLOYEES_RECORD_R,
    PERMISSIONS.EMPLOYEES_ACCOUNT_R,
    PERMISSIONS.EMPLOYEES_STATS_R,
  ),
  asyncHandler(getEmployee),
);

router.get(
  '/office-settings',
  requirePermission(
    PERMISSIONS.OPS_GEOFENCE_R,
    PERMISSIONS.OPS_GEOFENCE_X0,
    PERMISSIONS.OPS_HOURS_R,
    PERMISSIONS.OPS_WEEKEND_R,
    PERMISSIONS.OPS_SANDWICH_R,
    PERMISSIONS.OPS_WARNING_LIMIT_R,
    PERMISSIONS.OPS_AUTOCHECKOUT_R,
    PERMISSIONS.ATTENDANCE_RECORD_R,
  ),
  asyncHandler(getOfficeSettingsHandler),
);
router.put(
  '/office-settings',
  requirePermission(
    PERMISSIONS.OPS_GEOFENCE_U,
    PERMISSIONS.OPS_HOURS_U,
    PERMISSIONS.OPS_WEEKEND_U,
    PERMISSIONS.OPS_SANDWICH_U,
    PERMISSIONS.OPS_WARNING_LIMIT_U,
    PERMISSIONS.OPS_AUTOCHECKOUT_U,
  ),
  asyncHandler(updateOfficeSettings),
);
router.get(
  '/attendance',
  requirePermission(PERMISSIONS.ATTENDANCE_RECORD_R, PERMISSIONS.ATTENDANCE_LOG_R),
  asyncHandler(listAttendance),
);
router.post(
  '/attendance/records',
  requirePermission(PERMISSIONS.ATTENDANCE_RECORD_C),
  asyncHandler(upsertAttendanceRecord),
);
router.patch(
  '/attendance/records/:id',
  requirePermission(PERMISSIONS.ATTENDANCE_RECORD_U),
  asyncHandler(editAttendanceRecord),
);
router.get(
  '/attendance/quarter-warnings',
  requirePermission(PERMISSIONS.ATTENDANCE_WARNING_COL_R, PERMISSIONS.ATTENDANCE_LATE_WARNING_R),
  asyncHandler(getQuarterWarningSummary),
);
router.post(
  '/attendance/quarter-warnings/reset',
  requirePermission(PERMISSIONS.ATTENDANCE_LATE_WARNING_X0, PERMISSIONS.ATTENDANCE_LATE_WARNING_X1),
  asyncHandler(resetQuarterWarnings),
);
router.get(
  '/attendance/week-confirmations',
  requirePermission(PERMISSIONS.ATTENDANCE_RECORD_R),
  asyncHandler(listWeekConfirmations),
);
router.post(
  '/attendance/week-confirmations',
  requirePermission(PERMISSIONS.ATTENDANCE_RECORD_X0, PERMISSIONS.ATTENDANCE_RECORD_X1),
  asyncHandler(confirmWeekAttendance),
);
router.delete(
  '/attendance/week-confirmations',
  requirePermission(PERMISSIONS.ATTENDANCE_RECORD_X2),
  asyncHandler(unconfirmWeekAttendance),
);
router.get(
  '/audit-logs',
  requirePermission(PERMISSIONS.AUDIT_LOG_R),
  asyncHandler(listAuditLogs),
);
router.get(
  '/audit-logs/export',
  requirePermission(PERMISSIONS.AUDIT_LOG_X0),
  asyncHandler(exportAuditLogs),
);
router.get(
  '/audit-logs/archive/status',
  requirePermission(PERMISSIONS.AUDIT_LOG_R),
  asyncHandler(getAuditArchiveStatusHandler),
);
router.post(
  '/audit-logs/archive',
  requirePermission(PERMISSIONS.AUDIT_LOG_X1, PERMISSIONS.AUDIT_LOG_R),
  asyncHandler(runAuditArchiveHandler),
);
router.get(
  '/reports/summary',
  requirePermission(PERMISSIONS.DASHBOARD_ADMIN),
  asyncHandler(getReportsSummaryHandler),
);
router.get(
  '/attendance/team-today',
  requirePermission(PERMISSIONS.ATTENDANCE_TODAY_R),
  asyncHandler(getTeamTodayStatusAdmin),
);

export default router;
