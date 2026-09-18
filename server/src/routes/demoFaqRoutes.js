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

router.get(
  '/',
  requirePermission(PERMISSIONS.EMP_FAQ_R, PERMISSIONS.OPS_FAQ_R, PERMISSIONS.OPS_GUIDE_R),
  asyncHandler(listForRole),
);

router.get('/manage', requirePermission(PERMISSIONS.OPS_FAQ_R), asyncHandler(listAll));

router.post('/', requirePermission(PERMISSIONS.OPS_FAQ_C), asyncHandler(createItem));
router.put('/:id', requirePermission(PERMISSIONS.OPS_FAQ_U), asyncHandler(updateItem));
router.delete('/:id', requirePermission(PERMISSIONS.OPS_FAQ_D), asyncHandler(deleteItem));

export default router;
