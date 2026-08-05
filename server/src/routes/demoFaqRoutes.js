import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import {
  listForRole,
  listAll,
  createItem,
  updateItem,
  deleteItem,
} from '../controllers/demoFaqController.js';

const router = Router();

router.use(authenticate);

// Role-filtered active items for users with read or manage permission.
router.get(
  '/',
  requirePermission(PERMISSIONS.DEMO_FAQ_READ, PERMISSIONS.DEMO_FAQ_MANAGE),
  asyncHandler(listForRole),
);

// Admin manage view — all items including inactive.
router.get('/manage', requirePermission(PERMISSIONS.DEMO_FAQ_MANAGE), asyncHandler(listAll));

// CRUD — admin only.
router.post('/', requirePermission(PERMISSIONS.DEMO_FAQ_MANAGE), asyncHandler(createItem));
router.put('/:id', requirePermission(PERMISSIONS.DEMO_FAQ_MANAGE), asyncHandler(updateItem));
router.delete('/:id', requirePermission(PERMISSIONS.DEMO_FAQ_MANAGE), asyncHandler(deleteItem));

export default router;
