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
  createLeavePolicy,
  createLeaveRequestHandler,
  createLeaveType,
  deleteHoliday,
  encashLeaveBalanceHandler,
  getLeaveBalances,
  getLeaveRequestHandler,
  getMyLeaveBalances,
  getTeamCalendarHandler,
  initUserBalancesHandler,
  listHolidays,
  listLeavePolicies,
  listLeaveRequestsHandler,
  listLeaveTypes,
  previewLeaveRequestDays,
  rejectLeaveRequestHandler,
  runLeaveAccrualJobHandler,
  updateHoliday,
  updateLeavePolicy,
  updateLeaveType,
} from '../controllers/leaveController.js';

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
  requirePermission(PERMISSIONS.LEAVE_ADJUST_BALANCES),
  asyncHandler(carryForwardHandler),
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
  requirePermission(PERMISSIONS.LEAVE_READ_TEAM, PERMISSIONS.LEAVE_READ_ALL),
  asyncHandler(getTeamCalendarHandler),
);

router.get('/holidays', requirePermission(PERMISSIONS.LEAVE_READ), asyncHandler(listHolidays));
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

export default router;
