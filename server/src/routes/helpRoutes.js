import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  addCommentHandler,
  createTicketHandler,
  getTicketHandler,
  listTicketsHandler,
  updateTicketStatusHandler,
} from '../controllers/helpController.js';

const router = Router();

router.use(authenticate);

router.get(
  '/tickets',
  requirePermission(
    PERMISSIONS.HELP_READ,
    PERMISSIONS.HELP_WRITE,
    PERMISSIONS.HELP_MANAGE,
  ),
  asyncHandler(listTicketsHandler),
);

router.post(
  '/tickets',
  requirePermission(PERMISSIONS.HELP_WRITE),
  asyncHandler(createTicketHandler),
);

router.get(
  '/tickets/:id',
  requirePermission(
    PERMISSIONS.HELP_READ,
    PERMISSIONS.HELP_WRITE,
    PERMISSIONS.HELP_MANAGE,
  ),
  asyncHandler(getTicketHandler),
);

router.patch(
  '/tickets/:id',
  requirePermission(PERMISSIONS.HELP_MANAGE),
  asyncHandler(updateTicketStatusHandler),
);

router.post(
  '/tickets/:id/comments',
  requirePermission(
    PERMISSIONS.HELP_READ,
    PERMISSIONS.HELP_WRITE,
    PERMISSIONS.HELP_MANAGE,
  ),
  asyncHandler(addCommentHandler),
);

export default router;
