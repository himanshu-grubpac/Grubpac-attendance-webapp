import { Router } from 'express';
import multer from 'multer';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import {
  bulkUploadEmployees,
  downloadEmployeeTemplate,
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

router.get('/permissions', requirePermission(PERMISSIONS.ROLES_MANAGE), asyncHandler(listPermissions));
router.get(
  '/roles',
  requirePermission(PERMISSIONS.ROLES_MANAGE, PERMISSIONS.USERS_WRITE),
  asyncHandler(listRoles),
);
router.post('/roles', requirePermission(PERMISSIONS.ROLES_MANAGE), asyncHandler(createRole));
router.patch('/roles/:id', requirePermission(PERMISSIONS.ROLES_MANAGE), asyncHandler(updateRole));
router.delete('/roles/:id', requirePermission(PERMISSIONS.ROLES_MANAGE), asyncHandler(deleteRole));

router.get(
  '/departments',
  requirePermission(PERMISSIONS.DEPARTMENTS_MANAGE, PERMISSIONS.USERS_READ),
  asyncHandler(listDepartments),
);
router.post(
  '/departments',
  requirePermission(PERMISSIONS.DEPARTMENTS_MANAGE),
  asyncHandler(createDepartment),
);
router.patch(
  '/departments/:id',
  requirePermission(PERMISSIONS.DEPARTMENTS_MANAGE),
  asyncHandler(updateDepartment),
);
router.delete(
  '/departments/:id',
  requirePermission(PERMISSIONS.DEPARTMENTS_MANAGE),
  asyncHandler(deleteDepartment),
);

router.post('/users', requirePermission(PERMISSIONS.USERS_WRITE), asyncHandler(registerEmployee));
router.get(
  '/users',
  requirePermission(
    PERMISSIONS.USERS_READ,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  ),
  asyncHandler(listEmployees),
);
router.get('/users/stats', requirePermission(PERMISSIONS.USERS_READ), asyncHandler(getEmployeeStats));
router.get('/users/managers', requirePermission(PERMISSIONS.USERS_READ), asyncHandler(listManagers));
router.get(
  '/users/template',
  requirePermission(PERMISSIONS.USERS_WRITE),
  asyncHandler(downloadEmployeeTemplate),
);
router.patch(
  '/users/:id/password',
  requirePermission(PERMISSIONS.USERS_WRITE),
  asyncHandler(resetEmployeePassword),
);
router.patch(
  '/users/:id/pin',
  requirePermission(PERMISSIONS.USERS_WRITE),
  asyncHandler(resetEmployeePin),
);
router.patch('/users/:id', requirePermission(PERMISSIONS.USERS_WRITE), asyncHandler(updateEmployee));
router.post(
  '/users/bulk-upload',
  requirePermission(PERMISSIONS.USERS_WRITE),
  upload.single('file'),
  asyncHandler(bulkUploadEmployees),
);
router.get('/users/:id', requirePermission(PERMISSIONS.USERS_READ), asyncHandler(getEmployee));

router.get(
  '/office-settings',
  requirePermission(
    PERMISSIONS.OFFICE_MANAGE,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  ),
  asyncHandler(getOfficeSettingsHandler),
);
router.put(
  '/office-settings',
  requirePermission(PERMISSIONS.OFFICE_MANAGE),
  asyncHandler(updateOfficeSettings),
);
router.get(
  '/attendance',
  requirePermission(PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM),
  asyncHandler(listAttendance),
);
router.post(
  '/attendance/records',
  requirePermission(PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM),
  asyncHandler(upsertAttendanceRecord),
);
router.patch(
  '/attendance/records/:id',
  requirePermission(PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM),
  asyncHandler(editAttendanceRecord),
);
router.get(
  '/attendance/quarter-warnings',
  requirePermission(PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM),
  asyncHandler(getQuarterWarningSummary),
);
router.post(
  '/attendance/quarter-warnings/reset',
  requirePermission(PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM),
  asyncHandler(resetQuarterWarnings),
);
router.get(
  '/attendance/week-confirmations',
  requirePermission(PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM),
  asyncHandler(listWeekConfirmations),
);
router.post(
  '/attendance/week-confirmations',
  requirePermission(PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM),
  asyncHandler(confirmWeekAttendance),
);
router.delete(
  '/attendance/week-confirmations',
  requirePermission(PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM),
  asyncHandler(unconfirmWeekAttendance),
);
router.get('/audit-logs', requirePermission(PERMISSIONS.AUDIT_READ), asyncHandler(listAuditLogs));
router.get(
  '/reports/summary',
  requirePermission(PERMISSIONS.USERS_READ),
  asyncHandler(getReportsSummaryHandler),
);
router.get(
  '/attendance/team-today',
  requirePermission(PERMISSIONS.ATTENDANCE_READ_ALL, PERMISSIONS.ATTENDANCE_READ_TEAM),
  asyncHandler(getTeamTodayStatusAdmin),
);

export default router;
