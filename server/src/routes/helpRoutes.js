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
  requirePermission(PERMISSIONS.HELP_TICKET_R, PERMISSIONS.EMP_TICKET_R),
  asyncHandler(listTicketsHandler),
);

router.post(
  '/tickets',
  requirePermission(PERMISSIONS.EMP_TICKET_C),
  asyncHandler(createTicketHandler),
);

router.get(
  '/tickets/:id',
  requirePermission(PERMISSIONS.HELP_TICKET_R, PERMISSIONS.EMP_TICKET_R),
  asyncHandler(getTicketHandler),
);

router.patch(
  '/tickets/:id',
  requirePermission(
    PERMISSIONS.HELP_TICKET_X1,
    PERMISSIONS.HELP_TICKET_U,
    PERMISSIONS.HELP_SET_PRIORITY,
  ),
  asyncHandler(updateTicketStatusHandler),
);

router.post(
  '/tickets/:id/comments',
  requirePermission(PERMISSIONS.HELP_TICKET_R, PERMISSIONS.EMP_TICKET_R, PERMISSIONS.EMP_TICKET_X0),
  asyncHandler(addCommentHandler),
);

router.post(
  '/tickets/:id/attachments/presign',
  requirePermission(PERMISSIONS.EMP_TICKET_C, PERMISSIONS.EMP_TICKET_X0),
  asyncHandler(presignAttachmentHandler),
);

router.post(
  '/tickets/:id/attachments/:attachmentId/confirm',
  requirePermission(PERMISSIONS.EMP_TICKET_C, PERMISSIONS.EMP_TICKET_X0),
  asyncHandler(confirmAttachmentHandler),
);

router.get(
  '/tickets/:id/attachments/:attachmentId/download',
  requirePermission(PERMISSIONS.HELP_TICKET_X2, PERMISSIONS.EMP_TICKET_R, PERMISSIONS.HELP_TICKET_R),
  asyncHandler(downloadAttachmentHandler),
);

router.post(
  '/tickets/:id/comments/:commentId/attachments/presign',
  requirePermission(PERMISSIONS.HELP_TICKET_R, PERMISSIONS.EMP_TICKET_R, PERMISSIONS.EMP_TICKET_X0),
  asyncHandler(presignCommentAttachmentHandler),
);

router.post(
  '/tickets/:id/comments/:commentId/attachments/:attachmentId/confirm',
  requirePermission(PERMISSIONS.HELP_TICKET_R, PERMISSIONS.EMP_TICKET_R, PERMISSIONS.EMP_TICKET_X0),
  asyncHandler(confirmCommentAttachmentHandler),
);

router.delete(
  '/tickets/:id',
  requirePermission(PERMISSIONS.EMP_TICKET_D, PERMISSIONS.HELP_TICKET_D),
  asyncHandler(deleteTicketHandler),
);

router.delete(
  '/tickets/:id/comments/:commentId',
  requirePermission(PERMISSIONS.HELP_TICKET_R, PERMISSIONS.EMP_TICKET_R, PERMISSIONS.EMP_TICKET_X0),
  asyncHandler(deleteCommentHandler),
);

export default router;
