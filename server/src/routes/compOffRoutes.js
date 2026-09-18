import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  approveCompOffRequestHandler,
  assessCompOffRequestHandler,
  cancelApprovedCompOffRequestHandler,
  createCompOffRequestHandler,
  getCompOffApprovalsCountHandler,
  getCompOffEligibleDaysHandler,
  getCompOffRequestHandler,
  listCompOffRequestsHandler,
  rejectCompOffRequestHandler,
  undoCompOffAssessHandler,
  undoCompOffDecisionHandler,
  undoCompOffWithdrawHandler,
  withdrawCompOffRequestHandler,
} from '../controllers/compOffController.js';

const router = Router();

router.get(
  '/comp-off/eligible-days',
  requirePermission(PERMISSIONS.EMP_COMPOFF_R, PERMISSIONS.LEAVE_COMPOFF_R),
  asyncHandler(getCompOffEligibleDaysHandler),
);
router.post(
  '/comp-off',
  requirePermission(PERMISSIONS.EMP_COMPOFF_C),
  idempotencyMiddleware,
  asyncHandler(createCompOffRequestHandler),
);
router.get(
  '/comp-off',
  requirePermission(PERMISSIONS.EMP_COMPOFF_R, PERMISSIONS.LEAVE_COMPOFF_R),
  asyncHandler(listCompOffRequestsHandler),
);
router.get(
  '/comp-off/approvals/count',
  requirePermission(PERMISSIONS.LEAVE_COMPOFF_R),
  asyncHandler(getCompOffApprovalsCountHandler),
);
router.post(
  '/comp-off/:id/withdraw',
  requirePermission(PERMISSIONS.EMP_COMPOFF_U, PERMISSIONS.EMP_COMPOFF_D),
  asyncHandler(withdrawCompOffRequestHandler),
);
router.post(
  '/comp-off/:id/undo-withdraw',
  requirePermission(PERMISSIONS.EMP_COMPOFF_U),
  asyncHandler(undoCompOffWithdrawHandler),
);
router.post(
  '/comp-off/:id/approve',
  requirePermission(PERMISSIONS.LEAVE_COMPOFF_APPROVE),
  asyncHandler(approveCompOffRequestHandler),
);
router.post(
  '/comp-off/:id/reject',
  requirePermission(PERMISSIONS.LEAVE_COMPOFF_REJECT),
  asyncHandler(rejectCompOffRequestHandler),
);
router.post(
  '/comp-off/:id/undo',
  requirePermission(PERMISSIONS.LEAVE_COMPOFF_APPROVE, PERMISSIONS.LEAVE_COMPOFF_REJECT),
  asyncHandler(undoCompOffDecisionHandler),
);
router.post(
  '/comp-off/:id/cancel',
  requirePermission(PERMISSIONS.LEAVE_COMPOFF_APPROVE),
  asyncHandler(cancelApprovedCompOffRequestHandler),
);
router.post(
  '/comp-off/:id/assess',
  requirePermission(PERMISSIONS.LEAVE_COMPOFF_APPROVE),
  asyncHandler(assessCompOffRequestHandler),
);
router.post(
  '/comp-off/:id/undo-assess',
  requirePermission(PERMISSIONS.LEAVE_COMPOFF_APPROVE),
  asyncHandler(undoCompOffAssessHandler),
);
router.get(
  '/comp-off/:id',
  requirePermission(PERMISSIONS.EMP_COMPOFF_R, PERMISSIONS.LEAVE_COMPOFF_R),
  asyncHandler(getCompOffRequestHandler),
);

export default router;
