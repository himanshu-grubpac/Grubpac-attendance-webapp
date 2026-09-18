import { Router, urlencoded } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { leaveDecisionLimiter } from '../middleware/rateLimiters.js';
import {
  adjustLeaveBalances,
  approveLeaveRequestHandler,
  cancelLeaveRequestHandler,
  cancelApprovedLeaveByApproverHandler,
  undoLeaveCancellationHandler,
  notifyLeaveRequestHandler,
  carryForwardHandler,
  createHoliday,
  createHolidayCategory,
  createLeavePolicy,
  createLeaveRequestHandler,
  createLeaveType,
  deleteHoliday,
  deleteLeaveType,
  leaveDecisionLinkHandler,
  leaveDecisionLinkPageHandler,
  leaveDecisionLoginHandler,
  deleteHolidayCategory,
  deleteRecurringRuleHolidays,
  editLeaveRequestHandler,
  encashLeaveBalanceHandler,
  getApprovalsPendingCountsHandler,
  getLeaveBalances,
  getLeavePolicyHistory,
  getLeaveRequestHandler,
  getMyLeaveBalances,
  getLopRecordsHandler,
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
  undoLeaveDecisionHandler,
  undoSubmittedLeaveRequestHandler,
  runLeaveAccrualJobHandler,
  updateHoliday,
  updateHolidayCategory,
  updateRecurringHolidayRules,
  updateLeavePolicy,
  deleteLeavePolicy,
  updateLeaveType,
} from '../controllers/leaveController.js';
import leaveCarryBulkRoutes from './leaveCarryBulkRoutes.js';
import compOffRoutes from './compOffRoutes.js';
import { compOffDecisionLoginHandler } from '../controllers/compOffController.js';
import {
  batchAdjustLeaveCarriedHandler,
  getLeaveAdjustmentGridHandler,
  getLeaveAdjustmentHistoryHandler,
} from '../controllers/leaveAdjustmentController.js';

const router = Router();

// Public, token-protected approve/reject from email (no login required).
// GET shows a confirmation page (safe against email scanners auto-clicking links).
// POST performs the action.
router.get('/decision-link', leaveDecisionLimiter, asyncHandler(leaveDecisionLinkPageHandler));
router.post('/decision-link', leaveDecisionLimiter, urlencoded({ extended: false }), asyncHandler(leaveDecisionLinkHandler));
// Auto-login: consumes the token, issues a JWT session, redirects to admin portal.
router.get('/decision-login', leaveDecisionLimiter, asyncHandler(leaveDecisionLoginHandler));
// Comp-off take-action auto-login: same mechanics, lands on Comp off requests.
router.get('/comp-off/decision-login', leaveDecisionLimiter, asyncHandler(compOffDecisionLoginHandler));

router.use(authenticate);

router.get(
  '/types',
  requirePermission(PERMISSIONS.LEAVE_TYPE_R, PERMISSIONS.LEAVE_READ),
  asyncHandler(listLeaveTypes),
);
router.post(
  '/types',
  requirePermission(PERMISSIONS.LEAVE_TYPE_C),
  asyncHandler(createLeaveType),
);
router.patch(
  '/types/:id',
  requirePermission(PERMISSIONS.LEAVE_TYPE_U, PERMISSIONS.LEAVE_TYPE_X0),
  asyncHandler(updateLeaveType),
);
router.delete(
  '/types/:id',
  requirePermission(PERMISSIONS.LEAVE_TYPE_D),
  asyncHandler(deleteLeaveType),
);

router.get(
  '/policies',
  requirePermission(PERMISSIONS.LEAVE_READ, PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(listLeavePolicies),
);
router.post(
  '/policies',
  requirePermission(PERMISSIONS.LEAVE_POLICY_C),
  asyncHandler(createLeavePolicy),
);
router.patch(
  '/policies/:id',
  requirePermission(PERMISSIONS.LEAVE_POLICY_U),
  asyncHandler(updateLeavePolicy),
);
router.delete(
  '/policies/:id',
  requirePermission(PERMISSIONS.LEAVE_POLICY_D),
  asyncHandler(deleteLeavePolicy),
);
router.get(
  '/policies/:id/history',
  requirePermission(PERMISSIONS.LEAVE_READ, PERMISSIONS.LEAVE_MANAGE_POLICIES),
  asyncHandler(getLeavePolicyHistory),
);

router.get('/balances/me', requirePermission(PERMISSIONS.EMP_BALANCE_R), asyncHandler(getMyLeaveBalances));
router.post('/balances/init', requirePermission(PERMISSIONS.EMP_BALANCE_R), asyncHandler(initUserBalancesHandler));
router.get(
  '/balances',
  requirePermission(
    PERMISSIONS.LEAVE_ADJUSTMENT_R,
    PERMISSIONS.LEAVE_REQUEST_R,
    PERMISSIONS.EMP_BALANCE_R,
  ),
  asyncHandler(getLeaveBalances),
);
router.patch(
  '/balances/:userId',
  requirePermission(PERMISSIONS.LEAVE_ADJUSTMENT_U),
  asyncHandler(adjustLeaveBalances),
);
router.post(
  '/balances/:userId/encash',
  requirePermission(PERMISSIONS.LEAVE_ADJUSTMENT_U),
  asyncHandler(encashLeaveBalanceHandler),
);
router.post(
  '/carry-forward',
  requirePermission(PERMISSIONS.LEAVE_ADJUSTMENT_U, PERMISSIONS.LEAVE_POLICY_U),
  asyncHandler(carryForwardHandler),
);
router.get(
  '/carry-forward/preview',
  requirePermission(PERMISSIONS.LEAVE_ADJUSTMENT_U, PERMISSIONS.LEAVE_POLICY_R),
  asyncHandler(previewCarryForwardHandler),
);
router.post(
  '/jobs/accrual',
  requirePermission(PERMISSIONS.LEAVE_ADJUSTMENT_U),
  asyncHandler(runLeaveAccrualJobHandler),
);

router.get(
  '/requests/preview',
  requirePermission(
    PERMISSIONS.EMP_LEAVE_C,
    PERMISSIONS.EMP_LEAVE_R,
    PERMISSIONS.EMP_WFH_C,
    PERMISSIONS.EMP_WFH_R,
  ),
  asyncHandler(previewLeaveRequestDays),
);
router.get(
  '/requests',
  requirePermission(
    PERMISSIONS.EMP_REQUESTS_R,
    PERMISSIONS.LEAVE_REQUEST_R,
    PERMISSIONS.EMP_WFH_R,
  ),
  asyncHandler(listLeaveRequestsHandler),
);
router.post(
  '/requests',
  requirePermission(PERMISSIONS.EMP_LEAVE_C, PERMISSIONS.EMP_WFH_C),
  idempotencyMiddleware,
  asyncHandler(createLeaveRequestHandler),
);
router.get(
  '/requests/pending-counts',
  requirePermission(PERMISSIONS.LEAVE_REQUEST_R),
  asyncHandler(getApprovalsPendingCountsHandler),
);
router.get(
  '/requests/:id',
  requirePermission(
    PERMISSIONS.EMP_REQUESTS_R,
    PERMISSIONS.LEAVE_REQUEST_R,
    PERMISSIONS.EMP_WFH_R,
  ),
  asyncHandler(getLeaveRequestHandler),
);
router.put(
  '/requests/:id',
  requirePermission(PERMISSIONS.EMP_LEAVE_U, PERMISSIONS.EMP_WFH_U),
  idempotencyMiddleware,
  asyncHandler(editLeaveRequestHandler),
);
router.post(
  '/requests/:id/cancel',
  requirePermission(
    PERMISSIONS.EMP_LEAVE_D,
    PERMISSIONS.EMP_LEAVE_U,
    PERMISSIONS.EMP_WFH_D,
    PERMISSIONS.EMP_WFH_U,
  ),
  asyncHandler(cancelLeaveRequestHandler),
);
router.post(
  '/requests/:id/notify',
  requirePermission(PERMISSIONS.EMP_LEAVE_C),
  asyncHandler(notifyLeaveRequestHandler),
);
router.post(
  '/requests/:id/withdraw',
  requirePermission(PERMISSIONS.EMP_REQUESTS_X0, PERMISSIONS.EMP_LEAVE_U),
  asyncHandler(undoSubmittedLeaveRequestHandler),
);
router.post(
  '/requests/:id/approve',
  requirePermission(PERMISSIONS.LEAVE_REQUEST_APPROVE),
  asyncHandler(approveLeaveRequestHandler),
);
router.post(
  '/requests/:id/reject',
  requirePermission(PERMISSIONS.LEAVE_REQUEST_REJECT),
  asyncHandler(rejectLeaveRequestHandler),
);
router.post(
  '/requests/:id/undo',
  requirePermission(PERMISSIONS.LEAVE_REQUEST_APPROVE, PERMISSIONS.LEAVE_REQUEST_REJECT),
  asyncHandler(undoLeaveDecisionHandler),
);
router.post(
  '/requests/:id/cancel-approval',
  requirePermission(PERMISSIONS.LEAVE_REQUEST_APPROVE),
  asyncHandler(cancelApprovedLeaveByApproverHandler),
);
router.post(
  '/requests/:id/undo-cancel',
  requirePermission(PERMISSIONS.LEAVE_REQUEST_APPROVE, PERMISSIONS.EMP_LEAVE_U),
  asyncHandler(undoLeaveCancellationHandler),
);

router.get(
  '/team-calendar',
  requirePermission(
    PERMISSIONS.LEAVE_HOLIDAY_R,
    PERMISSIONS.LEAVE_REQUEST_R,
    PERMISSIONS.ATTENDANCE_RECORD_R,
  ),
  asyncHandler(getTeamCalendarHandler),
);

router.get('/holidays', requirePermission(PERMISSIONS.LEAVE_HOLIDAY_R, PERMISSIONS.EMP_POLICY_SUMMARY_R), asyncHandler(listHolidays));
router.get('/holiday-categories', requirePermission(PERMISSIONS.LEAVE_CATEGORY_R), asyncHandler(listHolidayCategories));
router.post('/holiday-categories', requirePermission(PERMISSIONS.LEAVE_CATEGORY_C), asyncHandler(createHolidayCategory));
router.patch('/holiday-categories/:id', requirePermission(PERMISSIONS.LEAVE_CATEGORY_U), asyncHandler(updateHolidayCategory));
router.delete('/holiday-categories/:id', requirePermission(PERMISSIONS.LEAVE_CATEGORY_D), asyncHandler(deleteHolidayCategory));
router.post(
  '/holidays',
  requirePermission(PERMISSIONS.LEAVE_HOLIDAY_C),
  asyncHandler(createHoliday),
);
router.patch(
  '/holidays/:id',
  requirePermission(PERMISSIONS.LEAVE_HOLIDAY_U),
  asyncHandler(updateHoliday),
);
router.delete(
  '/holidays/:id',
  requirePermission(PERMISSIONS.LEAVE_HOLIDAY_D),
  asyncHandler(deleteHoliday),
);
router.get(
  '/recurring-rules',
  requirePermission(PERMISSIONS.LEAVE_RECURRING_R),
  asyncHandler(listRecurringHolidayRules),
);
router.put(
  '/recurring-rules',
  requirePermission(PERMISSIONS.LEAVE_RECURRING_C, PERMISSIONS.LEAVE_RECURRING_U),
  asyncHandler(updateRecurringHolidayRules),
);
router.post(
  '/holidays/materialize-recurring',
  requirePermission(PERMISSIONS.LEAVE_RECURRING_X0),
  asyncHandler(materializeRecurringHolidays),
);
router.post(
  '/holidays/delete-by-rule',
  requirePermission(PERMISSIONS.LEAVE_RECURRING_D),
  asyncHandler(deleteRecurringRuleHolidays),
);

router.get(
  '/adjustments/grid',
  requirePermission(PERMISSIONS.LEAVE_ADJUSTMENT_R),
  asyncHandler(getLeaveAdjustmentGridHandler),
);
router.get(
  '/adjustments/history/:userId',
  requirePermission(PERMISSIONS.LEAVE_ADJUSTMENT_R),
  asyncHandler(getLeaveAdjustmentHistoryHandler),
);
router.post(
  '/adjustments/batch',
  requirePermission(PERMISSIONS.LEAVE_ADJUSTMENT_X0, PERMISSIONS.LEAVE_ADJUSTMENT_U),
  asyncHandler(batchAdjustLeaveCarriedHandler),
);

router.use(leaveCarryBulkRoutes);
router.use(compOffRoutes);

router.get(
  '/lop-records/:userId',
  requirePermission(PERMISSIONS.LEAVE_READ_ALL, PERMISSIONS.LEAVE_ADJUST_BALANCES, PERMISSIONS.LEAVE_READ),
  asyncHandler(getLopRecordsHandler),
);

export default router;
