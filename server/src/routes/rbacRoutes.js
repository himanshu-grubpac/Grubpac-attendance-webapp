import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  createRole,
  deleteRole,
  getCatalog,
  listRbacUsers,
  listRoles,
  updateRole,
} from '../controllers/rbacController.js';

const router = Router();

router.use(authenticate);

router.get('/catalog', requirePermission(PERMISSIONS.RBAC_CATALOG_R, PERMISSIONS.RBAC_ROLE_R), asyncHandler(getCatalog));
router.get('/roles', requirePermission(PERMISSIONS.RBAC_ROLE_R, PERMISSIONS.RBAC_USER_U), asyncHandler(listRoles));
router.post('/roles', requirePermission(PERMISSIONS.RBAC_ROLE_C), asyncHandler(createRole));
router.patch('/roles/:id', requirePermission(PERMISSIONS.RBAC_ROLE_U), asyncHandler(updateRole));
router.delete('/roles/:id', requirePermission(PERMISSIONS.RBAC_ROLE_D), asyncHandler(deleteRole));
router.get('/users', requirePermission(PERMISSIONS.RBAC_USER_R), asyncHandler(listRbacUsers));

export default router;
