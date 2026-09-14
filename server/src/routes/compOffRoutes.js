import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { requirePermission } from '../middleware/auth.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  approveCompOffRequestHandler,
  assessCompOffRequestHandler,
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
  requirePermission(PERMISSIONS.LEAVE_READ),
  asyncHandler(getCompOffEligibleDaysHandler),
);
router.post(
  '/comp-off',
  requirePermission(PERMISSIONS.LEAVE_APPLY),
  idempotencyMiddleware,
  asyncHandler(createCompOffRequestHandler),
);
router.get(
  '/comp-off',
  requirePermission(PERMISSIONS.LEAVE_READ),
  asyncHandler(listCompOffRequestsHandler),
);
router.get(
  '/comp-off/approvals/count',
  requirePermission(PERMISSIONS.LEAVE_READ),
  asyncHandler(getCompOffApprovalsCountHandler),
);
router.post(
  '/comp-off/:id/withdraw',
  requirePermission(PERMISSIONS.LEAVE_APPLY),
  asyncHandler(withdrawCompOffRequestHandler),
);
router.post(
  '/comp-off/:id/undo-withdraw',
  requirePermission(PERMISSIONS.LEAVE_APPLY),
  asyncHandler(undoCompOffWithdrawHandler),
);
router.post(
  '/comp-off/:id/approve',
  requirePermission(PERMISSIONS.LEAVE_APPROVE),
  asyncHandler(approveCompOffRequestHandler),
);
router.post(
  '/comp-off/:id/reject',
  requirePermission(PERMISSIONS.LEAVE_APPROVE),
  asyncHandler(rejectCompOffRequestHandler),
);
router.post(
  '/comp-off/:id/undo',
  requirePermission(PERMISSIONS.LEAVE_APPROVE),
  asyncHandler(undoCompOffDecisionHandler),
);
router.post(
  '/comp-off/:id/assess',
  requirePermission(PERMISSIONS.LEAVE_APPROVE),
  asyncHandler(assessCompOffRequestHandler),
);
router.post(
  '/comp-off/:id/undo-assess',
  requirePermission(PERMISSIONS.LEAVE_APPROVE),
  asyncHandler(undoCompOffAssessHandler),
);
// Single-request fetch for the email deep-link fallback. Registered last so
// it can never shadow the multi-segment routes above.
router.get(
  '/comp-off/:id',
  requirePermission(PERMISSIONS.LEAVE_READ),
  asyncHandler(getCompOffRequestHandler),
);

export default router;
