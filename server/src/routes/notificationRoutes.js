import { Router } from 'express';
import { NOTIFICATIONS_PORTAL_PERMISSIONS } from '../../../shared/permissions.js';
import {
  getUnreadCountForCurrentUser,
  listForCurrentUser,
  markAllRead,
  markOneRead,
  clearAll,
} from '../controllers/notificationsController.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

router.use(authenticate, requirePermission(...NOTIFICATIONS_PORTAL_PERMISSIONS));

router.get('/', asyncHandler(listForCurrentUser));
router.get('/unread-count', asyncHandler(getUnreadCountForCurrentUser));
router.post('/read-all', asyncHandler(markAllRead));
router.delete('/clear-all', asyncHandler(clearAll));
router.post('/:id/read', asyncHandler(markOneRead));

export default router;
