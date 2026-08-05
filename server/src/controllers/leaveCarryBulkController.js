import { leaveCarryBulkTemplateQuerySchema } from '../../../shared/validation/leaveCarryBulk.js';
import {
  applyCarryBulkRows,
  buildCarryAuditReport,
  buildCarryBulkTemplate,
  parseCarryBulkWorkbook,
} from '../services/leaveCarryBulkService.js';
import { auditLog } from '../utils/auditLog.js';

export async function downloadCarryBulkTemplate(req, res) {
  const parsed = leaveCarryBulkTemplateQuerySchema.parse(req.query);
  const buffer = await buildCarryBulkTemplate({ ...parsed, mode: 'template' });

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="carried-leave-template-${parsed.fromYear}-${parsed.toYear}.xlsx"`,
  );
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
}

export async function downloadCarryAuditReport(req, res) {
  const parsed = leaveCarryBulkTemplateQuerySchema.parse(req.query);
  const buffer = await buildCarryAuditReport(parsed);

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="leave-audit-report-${parsed.year}.xlsx"`,
  );
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
}

export async function uploadCarryBulk(req, res) {
  if (!req.file) {
    return res.status(400).json({ message: 'Excel file is required.' });
  }

  const rows = parseCarryBulkWorkbook(req.file.buffer);
  if (rows.length === 0) {
    return res.status(400).json({ message: 'No rows found in file.' });
  }

  const result = await applyCarryBulkRows(rows, req.user._id);

  auditLog('leave_carry_bulk_upload', {
    adminId: req.user._id.toString(),
    summary: result.summary,
  });

  res.json(result);
}
