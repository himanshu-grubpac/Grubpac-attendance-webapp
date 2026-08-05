import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import {
  adjustLeaveBalances,
  approveLeaveRequestHandler,
  cancelLeaveRequestHandler,
  carryForwardHandler,
  createHoliday,
  createHolidayCategory,
  createLeavePolicy,
  createLeaveRequestHandler,
  createLeaveType,
  deleteHoliday,
  deleteHolidayCategory,
  encashLeaveBalanceHandler,
  getLeaveBalances,
  getLeaveRequestHandler,
  getMyLeaveBalances,
  getTeamCalendarHandler,
  initUserBalancesHandler,
  listHolidays,
  materializeRecurringHolidays,
  listHolidayCategories,
  listRecurringHolidayRules,
  listLeavePolicies,
  listLeaveRequestsHandler,
  listLeaveTypes,
  previewCarryForwardHandler,
  previewLeaveRequestDays,
  rejectLeaveRequestHandler,
  runLeaveAccrualJobHandler,
  updateHoliday,
  updateHolidayCategory,
  updateRecurringHolidayRules,
  updateLeavePolicy,
  updateLeaveType,
} from '../controllers/leaveController.js';
import leaveCarryBulkRoutes from './leaveCarryBulkRoutes.js';
import {
  batchAdjustLeaveCarriedHandler,
  getLeaveAdjustmentGridHandler,
} from '../controllers/leaveAdjustmentController.js';

const router = Router();

router.use(authenticate);

router.get('/types', requirePermission(PERMISSIONS.LEAVE_READ), asyncHandler(listLeaveTypes));
router.post(
  '/types',
  requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(createLeaveType),
);
router.patch(
  '/types/:id',
  requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(updateLeaveType),
);

router.get(
  '/policies',
  requirePermission(PERMISSIONS.LEAVE_READ, PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(listLeavePolicies),
);
router.post(
  '/policies',
  requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(createLeavePolicy),
);
router.patch(
  '/policies/:id',
  requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(updateLeavePolicy),
);

router.get('/balances/me', requirePermission(PERMISSIONS.LEAVE_READ), asyncHandler(getMyLeaveBalances));
router.post('/balances/init', requirePermission(PERMISSIONS.LEAVE_READ), asyncHandler(initUserBalancesHandler));
router.get(
  '/balances',
  requirePermission(PERMISSIONS.LEAVE_READ_ALL, PERMISSIONS.LEAVE_ADJUST_BALANCES),
  asyncHandler(getLeaveBalances),
);
router.patch(
  '/balances/:userId',
  requirePermission(PERMISSIONS.LEAVE_ADJUST_BALANCES),
  asyncHandler(adjustLeaveBalances),
);
router.post(
  '/balances/:userId/encash',
  requirePermission(PERMISSIONS.LEAVE_ADJUST_BALANCES),
  asyncHandler(encashLeaveBalanceHandler),
);
router.post(
  '/carry-forward',
  requirePermission(PERMISSIONS.LEAVE_ADJUST_BALANCES, PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(carryForwardHandler),
);
router.get(
  '/carry-forward/preview',
  requirePermission(PERMISSIONS.LEAVE_ADJUST_BALANCES, PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(previewCarryForwardHandler),
);
router.post(
  '/jobs/accrual',
  requirePermission(PERMISSIONS.LEAVE_ADJUST_BALANCES),
  asyncHandler(runLeaveAccrualJobHandler),
);

router.get(
  '/requests/preview',
  requirePermission(PERMISSIONS.LEAVE_APPLY, PERMISSIONS.LEAVE_READ),
  asyncHandler(previewLeaveRequestDays),
);
router.get(
  '/requests',
  requirePermission(PERMISSIONS.LEAVE_READ),
  asyncHandler(listLeaveRequestsHandler),
);
router.post(
  '/requests',
  requirePermission(PERMISSIONS.LEAVE_APPLY),
  idempotencyMiddleware,
  asyncHandler(createLeaveRequestHandler),
);
router.get(
  '/requests/:id',
  requirePermission(PERMISSIONS.LEAVE_READ),
  asyncHandler(getLeaveRequestHandler),
);
router.post(
  '/requests/:id/cancel',
  requirePermission(PERMISSIONS.LEAVE_APPLY),
  asyncHandler(cancelLeaveRequestHandler),
);
router.post(
  '/requests/:id/approve',
  requirePermission(PERMISSIONS.LEAVE_APPROVE),
  asyncHandler(approveLeaveRequestHandler),
);
router.post(
  '/requests/:id/reject',
  requirePermission(PERMISSIONS.LEAVE_APPROVE),
  asyncHandler(rejectLeaveRequestHandler),
);

router.get(
  '/team-calendar',
  requirePermission(
    PERMISSIONS.LEAVE_READ_TEAM,
    PERMISSIONS.LEAVE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_ALL,
  ),
  asyncHandler(getTeamCalendarHandler),
);

router.get('/holidays', requirePermission(PERMISSIONS.LEAVE_READ), asyncHandler(listHolidays));
router.get('/holiday-categories', requirePermission(PERMISSIONS.LEAVE_READ), asyncHandler(listHolidayCategories));
router.post('/holiday-categories', requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES), asyncHandler(createHolidayCategory));
router.patch('/holiday-categories/:id', requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES), asyncHandler(updateHolidayCategory));
router.delete('/holiday-categories/:id', requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES), asyncHandler(deleteHolidayCategory));
router.post(
  '/holidays',
  requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(createHoliday),
);
router.patch(
  '/holidays/:id',
  requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(updateHoliday),
);
router.delete(
  '/holidays/:id',
  requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(deleteHoliday),
);
router.get(
  '/recurring-rules',
  requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(listRecurringHolidayRules),
);
router.put(
  '/recurring-rules',
  requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(updateRecurringHolidayRules),
);
router.post(
  '/holidays/materialize-recurring',
  requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(materializeRecurringHolidays),
);

router.get(
  '/adjustments/grid',
  requirePermission(PERMISSIONS.LEAVE_ADJUST_BALANCES),
  asyncHandler(getLeaveAdjustmentGridHandler),
);
router.post(
  '/adjustments/batch',
  requirePermission(PERMISSIONS.LEAVE_ADJUST_BALANCES),
  asyncHandler(batchAdjustLeaveCarriedHandler),
);

router.use(leaveCarryBulkRoutes);

export default router;
