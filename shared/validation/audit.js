import { z } from 'zod';
import { paginationSchema } from './common.js';

const istDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')
  .optional();

const auditLogFilterFields = {
  action: z.string().trim().max(100).optional(),
  search: z.string().trim().max(100).optional(),
  /**
   * Unified search box: email (partial, case-insensitive), exact user
   * ObjectId, or exact record id — matched with OR semantics. Supersedes
   * sending search/employee/entityId separately (still accepted).
   */
  q: z.string().trim().max(100).optional(),
  /** Legacy single-day filter (kept for compatibility; dateFrom/dateTo win). */
  date: istDateString,
  dateFrom: istDateString,
  dateTo: istDateString,
  /** Module value from the audit taxonomy (e.g. leave, attendance). */
  module: z.string().trim().max(50).optional(),
  /** Employee email (partial, case-insensitive) or exact user ObjectId. */
  employee: z.string().trim().max(100).optional(),
  /** Exact record id (request, ticket, policy, transfer, …). */
  entityId: z.string().trim().max(100).optional(),
};

const conflictsOnlyField = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

export const auditLogQuerySchema = paginationSchema.extend({
  ...auditLogFilterFields,
  conflictsOnly: conflictsOnlyField,
});

export const auditLogExportSchema = z.object({
  ...auditLogFilterFields,
  conflictsOnly: conflictsOnlyField,
  format: z.enum(['xlsx', 'csv']).optional().default('xlsx'),
});

export const AUDIT_LOG_EXPORT_MAX_ROWS = 10000;
