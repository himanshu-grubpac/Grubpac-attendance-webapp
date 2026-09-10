import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { authenticate, requireAllPermissions, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  exportSalaryAuditHandler,
  exportSalaryHandler,
  generateSalaryTransfersHandler,
  getSalaryAuditHandler,
  getSalaryHistoryHandler,
  getSalarySettingsHandler,
  getSalarySummaryHandler,
  getUserSalaryHandler,
  listSalaryStructureHandler,
  listSalarySummariesHandler,
  listSalaryTransfersHandler,
  settleMonthHandler,
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

router.post(
  '/settle',
  requireAllPermissions(PERMISSIONS.SALARY_WRITE, PERMISSIONS.USERS_READ),
  asyncHandler(settleMonthHandler),
);

router.patch(
  '/transfers/:id',
  requirePermission(PERMISSIONS.SALARY_WRITE),
  asyncHandler(updateSalaryTransferHandler),
);

// Employee salary history — scoped by RBAC (RM sees team, Admin sees all)
router.get(
  '/history/:userId',
  requirePermission(PERMISSIONS.SALARY_READ, PERMISSIONS.SALARY_READ_TEAM),
  asyncHandler(getSalaryHistoryHandler),
);

// Monthly salary audit for RM/Admin — scoped by RBAC
router.get(
  '/audit',
  requirePermission(PERMISSIONS.SALARY_READ, PERMISSIONS.SALARY_READ_TEAM),
  asyncHandler(getSalaryAuditHandler),
);

// Audit export — same permissions as audit
router.get(
  '/audit/export',
  requirePermission(PERMISSIONS.SALARY_READ, PERMISSIONS.SALARY_READ_TEAM),
  asyncHandler(exportSalaryAuditHandler),
);

export default router;
