import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate, requireEmployeePortalAccess, requirePermission } from '../middleware/auth.js';
import { attendanceLimiter } from '../middleware/rateLimiters.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import {
  checkIn,
  checkOut,
  getHistory,
  getMonthSummary,
  getMyQuarterWarnings,
  getTeamTodayStatus,
  getToday,
  undoAttendanceAction,
} from '../controllers/attendanceController.js';

const router = Router();

router.get(
  '/month-summary',
  authenticate,
  requirePermission(PERMISSIONS.EMP_CALENDAR_R),
  asyncHandler(getMonthSummary),
);

router.use(authenticate, requireEmployeePortalAccess);

router.get(
  '/today',
  requirePermission(PERMISSIONS.EMP_DASHBOARD_R, PERMISSIONS.EMP_PUNCH_C, PERMISSIONS.EMP_PUNCH_U),
  asyncHandler(getToday),
);
router.get(
  '/team-today',
  requirePermission(PERMISSIONS.EMP_TEAM_TODAY_R),
  asyncHandler(getTeamTodayStatus),
);
router.post(
  '/check-in',
  requirePermission(PERMISSIONS.EMP_PUNCH_C),
  attendanceLimiter,
  idempotencyMiddleware,
  asyncHandler(checkIn),
);
router.post(
  '/check-out',
  requirePermission(PERMISSIONS.EMP_PUNCH_U),
  attendanceLimiter,
  idempotencyMiddleware,
  asyncHandler(checkOut),
);
router.get(
  '/history',
  requirePermission(PERMISSIONS.EMP_ATTENDANCE_R),
  asyncHandler(getHistory),
);
router.get(
  '/quarter-warnings',
  requirePermission(PERMISSIONS.EMP_DASHBOARD_R, PERMISSIONS.EMP_CALENDAR_R),
  asyncHandler(getMyQuarterWarnings),
);
router.post(
  '/undo',
  requirePermission(PERMISSIONS.EMP_PUNCH_X0),
  asyncHandler(undoAttendanceAction),
);

export default router;
