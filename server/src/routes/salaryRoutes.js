import { Router } from 'express';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  exportLopBulkHandler,
  exportLopSingleHandler,
  exportSalaryAuditHandler,
  exportSalaryHandler,
  generateSalaryTransfersHandler,
  getLopDetailHandler,
  getSalaryAuditHandler,
  getSalaryHistoryHandler,
  getSalarySettingsHandler,
  getSalarySummaryHandler,
  getUserSalaryHandler,
  listLopSummariesHandler,
  listSalaryStructureHandler,
  listSalarySummariesHandler,
  listSalaryTransfersHandler,
  listSettlementsHandler,
  settleMonthHandler,
  updateSalarySettingsHandler,
  updateSalaryTransferHandler,
  updateUserSalaryHandler,
} from '../controllers/salaryController.js';

const router = Router();

router.use(authenticate);

router.patch(
  '/users/:id',
  requirePermission(PERMISSIONS.EMPLOYEES_SALARY_U, PERMISSIONS.SALARY_STRUCTURE_U),
  asyncHandler(updateUserSalaryHandler),
);

router.get(
  '/users/:id',
  requirePermission(PERMISSIONS.EMPLOYEES_SALARY_R, PERMISSIONS.SALARY_STRUCTURE_R),
  asyncHandler(getUserSalaryHandler),
);

router.get(
  '/summary',
  requirePermission(PERMISSIONS.SALARY_PAYROLL_DETAIL_R, PERMISSIONS.SALARY_TEAM_AUDIT_R, PERMISSIONS.EMP_PAY_R),
  asyncHandler(getSalarySummaryHandler),
);

router.get(
  '/summaries',
  requirePermission(PERMISSIONS.SALARY_PAYROLL_R),
  asyncHandler(listSalarySummariesHandler),
);

router.get(
  '/settings',
  requirePermission(PERMISSIONS.SALARY_SCHEDULE_R),
  asyncHandler(getSalarySettingsHandler),
);

router.patch(
  '/settings',
  requirePermission(PERMISSIONS.SALARY_SCHEDULE_U),
  asyncHandler(updateSalarySettingsHandler),
);

router.get(
  '/structure',
  requirePermission(PERMISSIONS.SALARY_STRUCTURE_R),
  asyncHandler(listSalaryStructureHandler),
);

router.get(
  '/export',
  requirePermission(PERMISSIONS.SALARY_PAYROLL_X0),
  asyncHandler(exportSalaryHandler),
);

router.get(
  '/transfers',
  requirePermission(PERMISSIONS.SALARY_TRANSFER_R),
  asyncHandler(listSalaryTransfersHandler),
);

router.post(
  '/transfers/generate',
  requirePermission(PERMISSIONS.SALARY_TRANSFER_C, PERMISSIONS.SALARY_TRANSFER_X0),
  asyncHandler(generateSalaryTransfersHandler),
);

router.post(
  '/settle',
  requirePermission(PERMISSIONS.SALARY_SETTLEMENT_X0),
  asyncHandler(settleMonthHandler),
);

router.get(
  '/settlements',
  requirePermission(PERMISSIONS.SALARY_SETTLEMENT_R),
  asyncHandler(listSettlementsHandler),
);

router.patch(
  '/transfers/:id',
  requirePermission(
    PERMISSIONS.SALARY_TRANSFER_X1,
    PERMISSIONS.SALARY_TRANSFER_X2,
    PERMISSIONS.SALARY_TRANSFER_U,
  ),
  asyncHandler(updateSalaryTransferHandler),
);

router.get(
  '/history/:userId',
  requirePermission(PERMISSIONS.SALARY_HISTORY_R, PERMISSIONS.EMPLOYEES_SALARY_HISTORY_R),
  asyncHandler(getSalaryHistoryHandler),
);

router.get(
  '/audit',
  requirePermission(PERMISSIONS.SALARY_AUDIT_R, PERMISSIONS.SALARY_TEAM_AUDIT_R),
  asyncHandler(getSalaryAuditHandler),
);

router.get(
  '/audit/export',
  requirePermission(PERMISSIONS.SALARY_AUDIT_X0, PERMISSIONS.SALARY_TEAM_AUDIT_X0),
  asyncHandler(exportSalaryAuditHandler),
);

router.get(
  '/lop/summaries',
  requirePermission(PERMISSIONS.SALARY_PAYROLL_R),
  asyncHandler(listLopSummariesHandler),
);

router.get(
  '/lop/export',
  requirePermission(PERMISSIONS.SALARY_PAYROLL_X0),
  asyncHandler(exportLopBulkHandler),
);

router.get(
  '/lop/:userId/export',
  requirePermission(PERMISSIONS.SALARY_PAYROLL_X0, PERMISSIONS.SALARY_TEAM_AUDIT_R),
  asyncHandler(exportLopSingleHandler),
);

router.get(
  '/lop/:userId',
  requirePermission(PERMISSIONS.SALARY_PAYROLL_DETAIL_R, PERMISSIONS.SALARY_TEAM_AUDIT_R),
  asyncHandler(getLopDetailHandler),
);

export default router;
