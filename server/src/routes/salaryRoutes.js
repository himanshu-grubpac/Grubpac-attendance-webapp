import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { authenticate, requireAllPermissions, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  exportSalaryHandler,
  getSalarySummaryHandler,
  getUserSalaryHandler,
  listSalarySummariesHandler,
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

// Company-wide payroll export — must match the "view others" admin bar used by
// canViewSalarySummary (SALARY_READ + USERS_READ). SALARY_READ alone is also held
// by the Employee role for self-service pay estimates and must not unlock this.
router.get(
  '/export',
  requireAllPermissions(PERMISSIONS.SALARY_READ, PERMISSIONS.USERS_READ),
  asyncHandler(exportSalaryHandler),
);

export default router;
