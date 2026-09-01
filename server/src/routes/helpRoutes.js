import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  addCommentHandler,
  confirmAttachmentHandler,
  confirmCommentAttachmentHandler,
  createTicketHandler,
  deleteCommentHandler,
  deleteTicketHandler,
  downloadAttachmentHandler,
  getTicketHandler,
  listTicketsHandler,
  presignAttachmentHandler,
  presignCommentAttachmentHandler,
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

router.post(
  '/tickets/:id/attachments/presign',
  requirePermission(PERMISSIONS.HELP_WRITE),
  asyncHandler(presignAttachmentHandler),
);

router.post(
  '/tickets/:id/attachments/:attachmentId/confirm',
  requirePermission(PERMISSIONS.HELP_WRITE),
  asyncHandler(confirmAttachmentHandler),
);

router.get(
  '/tickets/:id/attachments/:attachmentId/download',
  requirePermission(
    PERMISSIONS.HELP_READ,
    PERMISSIONS.HELP_WRITE,
    PERMISSIONS.HELP_MANAGE,
  ),
  asyncHandler(downloadAttachmentHandler),
);

router.post(
  '/tickets/:id/comments/:commentId/attachments/presign',
  requirePermission(
    PERMISSIONS.HELP_READ,
    PERMISSIONS.HELP_WRITE,
    PERMISSIONS.HELP_MANAGE,
  ),
  asyncHandler(presignCommentAttachmentHandler),
);

router.post(
  '/tickets/:id/comments/:commentId/attachments/:attachmentId/confirm',
  requirePermission(
    PERMISSIONS.HELP_READ,
    PERMISSIONS.HELP_WRITE,
    PERMISSIONS.HELP_MANAGE,
  ),
  asyncHandler(confirmCommentAttachmentHandler),
);

router.delete(
  '/tickets/:id',
  requirePermission(PERMISSIONS.HELP_WRITE, PERMISSIONS.HELP_MANAGE),
  asyncHandler(deleteTicketHandler),
);

router.delete(
  '/tickets/:id/comments/:commentId',
  requirePermission(
    PERMISSIONS.HELP_READ,
    PERMISSIONS.HELP_WRITE,
    PERMISSIONS.HELP_MANAGE,
  ),
  asyncHandler(deleteCommentHandler),
);

export default router;
