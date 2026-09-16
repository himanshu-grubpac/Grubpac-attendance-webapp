import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import {
  salaryAuditExportQuerySchema,
  salaryAuditQuerySchema,
  salaryExportQuerySchema,
  salaryHistoryParamsSchema,
  salaryHistoryQuerySchema,
  lopDetailParamsSchema,
  lopDetailQuerySchema,
  lopExportQuerySchema,
  lopListQuerySchema,
  salaryStructureQuerySchema,
  salarySummaryQuerySchema,
  salaryTransferListQuerySchema,
  generateSalaryTransfersSchema,
  updateSalaryTransferStatusSchema,
  updateSalarySettingsSchema,
  updateUserSalarySchema,
} from '../../../shared/validation/salary.js';
import { parseDateInputAsISTDay } from '../utils/istDate.js';
import { auditLog } from '../utils/auditLog.js';
import {
  buildLopExportWorkbook,
  buildSalaryExportWorkbook,
  buildSalaryMonthMeta,
  computeMonthlySalarySummary,
  generatePendingSalaryTransfers,
  getLopDetailForUser,
  getSalarySettingsPayload,
  getSalarySummaryForUser,
  listAllLopSummariesForMonth,
  listLopSummaries,
  listRecentSettlements,
  listSalaryStructure,
  listSalarySummariesForMonth,
  listSalaryTransfers,
  loadSalarySubject,
  lopDeductionRowsToExportRows,
  settleMonthPayroll,
  updateSalarySettings,
  updateSalaryTransferStatus,
  updateUserSalary,
  canViewSalarySummary,
} from '../services/salaryService.js';
import {
  getEmployeeSalaryHistory,
  getMonthlySalaryAudit,
  exportMonthlySalaryAudit,
} from '../services/salaryAuditService.js';

export async function updateUserSalaryHandler(req, res) {
  const parsed = updateUserSalarySchema.parse(req.body);
  const payload = {
    ...(parsed.monthlySalary !== undefined ? { monthlySalary: parsed.monthlySalary } : {}),
    ...(parsed.salaryEffectiveFrom !== undefined
      ? {
          salaryEffectiveFrom: parsed.salaryEffectiveFrom
            ? parseDateInputAsISTDay(parsed.salaryEffectiveFrom)
            : null,
        }
      : {}),
  };

  const user = await updateUserSalary(req.params.id, payload, req.user._id);

  auditLog('salary_updated', {
    adminId: req.user._id.toString(),
    employeeId: user._id.toString(),
    fieldsUpdated: Object.keys(parsed),
  });

  // Route is gated by SALARY_WRITE, so the caller may view salary fields.
  res.json({ employee: user.toSafeJSON({ canViewSalary: true }) });
}

export async function getSalarySummaryHandler(req, res) {
  const parsed = salarySummaryQuerySchema.parse(req.query);
  const targetUserId = parsed.userId ?? req.user._id.toString();

  const result = await getSalarySummaryForUser(
    req.user,
    req.userPermissions,
    targetUserId,
    parsed.month,
  );
  res.json(result);
}

export async function listSalarySummariesHandler(req, res) {
  const { month } = salaryExportQuerySchema.parse(req.query);
  const summaries = await listSalarySummariesForMonth(month);
  const meta = await buildSalaryMonthMeta(month, summaries);
  res.json({ month, summaries, meta });
}

export async function getSalarySettingsHandler(req, res) {
  const result = await getSalarySettingsPayload();
  res.json(result);
}

export async function updateSalarySettingsHandler(req, res) {
  const parsed = updateSalarySettingsSchema.parse(req.body);
  const result = await updateSalarySettings(parsed, req.user._id);

  auditLog('salary_settings_updated', {
    adminId: req.user._id.toString(),
    fieldsUpdated: Object.keys(parsed),
  });

  res.json(result);
}

export async function listSalaryStructureHandler(req, res) {
  const parsed = salaryStructureQuerySchema.parse(req.query);
  const result = await listSalaryStructure(parsed);
  res.json(result);
}

export async function exportSalaryHandler(req, res) {
  const { month } = salaryExportQuerySchema.parse(req.query);
  const summaries = await listSalarySummariesForMonth(month);
  const buffer = buildSalaryExportWorkbook(summaries, month);

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="salary-summary-${month}.xlsx"`,
  );
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
}

export async function getUserSalaryHandler(req, res) {
  const user = await loadSalarySubject(req.params.id);
  const canRead =
    req.user._id.toString() === user._id.toString()
      ? hasPermission(req.userPermissions, PERMISSIONS.SALARY_READ)
      : hasPermission(req.userPermissions, PERMISSIONS.SALARY_WRITE);

  if (!canRead) {
    return res.status(403).json({ message: 'You do not have permission to view salary data.' });
  }

  res.json({
    employee: {
      id: user._id.toString(),
      name: user.name,
      monthlySalary: user.monthlySalary ?? null,
      salaryEffectiveFrom: user.salaryEffectiveFrom ?? null,
      salaryCurrency: 'INR',
    },
  });
}

export async function listSalaryTransfersHandler(req, res) {
  const parsed = salaryTransferListQuerySchema.parse(req.query);
  const result = await listSalaryTransfers(parsed);
  res.json(result);
}

export async function generateSalaryTransfersHandler(req, res) {
  const parsed = generateSalaryTransfersSchema.parse(req.body);
  const result = await generatePendingSalaryTransfers(parsed.month, req.user._id);

  auditLog('salary_transfers_generated', {
    adminId: req.user._id.toString(),
    month: parsed.month,
    created: result.created,
    skipped: result.skipped,
  });

  const listResult = await listSalaryTransfers({
    month: parsed.month,
    page: 1,
    limit: 20,
  });

  res.status(result.created > 0 ? 201 : 200).json({
    ...result,
    month: parsed.month,
    transfers: listResult.transfers,
    stats: listResult.stats,
    pagination: listResult.pagination,
  });
}

export async function updateSalaryTransferHandler(req, res) {
  const parsed = updateSalaryTransferStatusSchema.parse(req.body);
  const transfer = await updateSalaryTransferStatus(req.params.id, parsed, req.user._id);

  auditLog('salary_transfer_updated', {
    adminId: req.user._id.toString(),
    transferId: transfer.id,
    status: transfer.status,
  });

  res.json({ transfer });
}

export async function settleMonthHandler(req, res) {
  const parsed = generateSalaryTransfersSchema.parse(req.body);
  const result = await settleMonthPayroll(parsed.month, req.user._id);
  res.json(result);
}

export async function listSettlementsHandler(req, res) {
  const settlements = await listRecentSettlements(6);
  res.json({ settlements });
}

export async function getSalaryHistoryHandler(req, res) {
  const { userId } = salaryHistoryParamsSchema.parse(req.params);
  const { year } = salaryHistoryQuerySchema.parse(req.query);

  const result = await getEmployeeSalaryHistory(
    req.user,
    req.userPermissions,
    userId,
    { year },
  );

  res.json(result);
}

export async function getSalaryAuditHandler(req, res) {
  const { periodKey, departmentId } = salaryAuditQuerySchema.parse(req.query);

  const result = await getMonthlySalaryAudit(
    req.user,
    req.userPermissions,
    periodKey,
    { departmentId },
  );

  res.json(result);
}

export async function exportSalaryAuditHandler(req, res) {
  const { periodKey, departmentId } = salaryAuditExportQuerySchema.parse(req.query);

  const { buffer, filename } = await exportMonthlySalaryAudit(
    req.user,
    req.userPermissions,
    periodKey,
    { departmentId },
  );

  auditLog('salary_audit_exported', {
    adminId: req.user._id.toString(),
    periodKey,
  });

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
}

export async function listLopSummariesHandler(req, res) {
  const parsed = lopListQuerySchema.parse(req.query);
  const result = await listLopSummaries(parsed);
  res.json(result);
}

export async function getLopDetailHandler(req, res) {
  const { userId } = lopDetailParamsSchema.parse(req.params);
  const { month, asOf } = lopDetailQuerySchema.parse(req.query);
  const result = await getLopDetailForUser(req.user, req.userPermissions, userId, month, asOf);
  res.json(result);
}

export async function exportLopSingleHandler(req, res) {
  const { userId } = lopDetailParamsSchema.parse(req.params);
  const { month, asOf } = lopExportQuerySchema.parse(req.query);

  const subject = await loadSalarySubject(userId);
  if (!canViewSalarySummary(req.user, subject, req.userPermissions)) {
    return res.status(403).json({ message: 'You do not have permission to export this LOP log.' });
  }

  const summary = await computeMonthlySalarySummary(subject, month, { asOfDate: asOf });
  const exportRows = lopDeductionRowsToExportRows(summary);
  const buffer = buildLopExportWorkbook(exportRows);

  auditLog('lop_exported', {
    adminId: req.user._id.toString(),
    employeeId: userId,
    month,
    asOfDate: summary.asOfDate,
  });

  const safeName = (subject.name ?? 'employee').replace(/[^\w.-]+/g, '_');
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="lop-${safeName}-${month}.xlsx"`,
  );
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
}

export async function exportLopBulkHandler(req, res) {
  const { month, asOf } = lopExportQuerySchema.parse(req.query);
  const summaries = await listAllLopSummariesForMonth(month, asOf);
  const exportRows = summaries.flatMap((summary) =>
    lopDeductionRowsToExportRows(summary, { bulk: true }),
  );
  const buffer = buildLopExportWorkbook(exportRows, { bulk: true, sheetName: 'LOP Bulk Export' });

  auditLog('lop_bulk_exported', {
    adminId: req.user._id.toString(),
    month,
    employeeCount: summaries.length,
  });

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="lop-bulk-${month}.xlsx"`);
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
}
