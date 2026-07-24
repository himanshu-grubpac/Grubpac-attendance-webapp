import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import {
  salaryExportQuerySchema,
  salarySummaryQuerySchema,
  updateUserSalarySchema,
} from '../../../shared/validation/salary.js';
import { parseDateInputAsISTDay } from '../utils/istDate.js';
import { auditLog } from '../utils/auditLog.js';
import {
  buildSalaryExportWorkbook,
  getSalarySummaryForUser,
  listSalarySummariesForMonth,
  loadSalarySubject,
  updateUserSalary,
} from '../services/salaryService.js';

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

  res.json({ employee: user.toSafeJSON() });
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
  res.json({ month, summaries });
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
  res.send(buffer);
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
