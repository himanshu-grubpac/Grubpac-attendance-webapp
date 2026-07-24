import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
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

router.use(authenticate, requirePermission(PERMISSIONS.NOTIFICATIONS_READ));

router.get('/', asyncHandler(listForCurrentUser));
router.get('/unread-count', asyncHandler(getUnreadCountForCurrentUser));
router.post('/read-all', asyncHandler(markAllRead));
router.delete('/clear-all', asyncHandler(clearAll));
router.post('/:id/read', asyncHandler(markOneRead));

export default router;
