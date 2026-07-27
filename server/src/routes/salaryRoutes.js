import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { authenticate, requireAllPermissions, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  exportSalaryHandler,
  generateSalaryTransfersHandler,
  getSalarySettingsHandler,
  getSalarySummaryHandler,
  getUserSalaryHandler,
  listSalaryStructureHandler,
  listSalarySummariesHandler,
  listSalaryTransfersHandler,
  updateSalarySettingsHandler,
  updateSalaryTransferHandler,
  updateUserSalaryHandler,
} from '../controllers/salaryController.js';

const router = Router();

router.use(authenticate);

router.patch(
  '/users/:id',
  requirePermission(PERMISSIONS.SALARY_WRITE),
  asyncHandler(updateUserSalaryHandler),
);

router.get(
  '/users/:id',
  requirePermission(PERMISSIONS.SALARY_READ, PERMISSIONS.SALARY_WRITE),
  asyncHandler(getUserSalaryHandler),
);

router.get(
  '/summary',
  requirePermission(
    PERMISSIONS.SALARY_READ,
    PERMISSIONS.SALARY_READ_TEAM,
  ),
  asyncHandler(getSalarySummaryHandler),
);

// Company-wide month summaries — same admin bar as export (SALARY_READ + USERS_READ).
router.get(
  '/summaries',
  requireAllPermissions(PERMISSIONS.SALARY_READ, PERMISSIONS.USERS_READ),
  asyncHandler(listSalarySummariesHandler),
);

router.get(
  '/settings',
  requireAllPermissions(PERMISSIONS.SALARY_READ, PERMISSIONS.USERS_READ),
  asyncHandler(getSalarySettingsHandler),
);

router.patch(
  '/settings',
  requirePermission(PERMISSIONS.SALARY_WRITE),
  asyncHandler(updateSalarySettingsHandler),
);

router.get(
  '/structure',
  requireAllPermissions(PERMISSIONS.SALARY_READ, PERMISSIONS.USERS_READ),
  asyncHandler(listSalaryStructureHandler),
);

// Company-wide payroll export — must match the "view others" admin bar used by
// canViewSalarySummary (SALARY_READ + USERS_READ). SALARY_READ alone is also held
// by the Employee role for self-service pay estimates and must not unlock this.
router.get(
  '/export',
  requireAllPermissions(PERMISSIONS.SALARY_READ, PERMISSIONS.USERS_READ),
  asyncHandler(exportSalaryHandler),
);

router.get(
  '/transfers',
  requireAllPermissions(PERMISSIONS.SALARY_READ, PERMISSIONS.USERS_READ),
  asyncHandler(listSalaryTransfersHandler),
);

router.post(
  '/transfers/generate',
  requirePermission(PERMISSIONS.SALARY_WRITE),
  asyncHandler(generateSalaryTransfersHandler),
);

router.patch(
  '/transfers/:id',
  requirePermission(PERMISSIONS.SALARY_WRITE),
  asyncHandler(updateSalaryTransferHandler),
);

export default router;
