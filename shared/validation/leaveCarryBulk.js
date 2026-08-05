import { z } from 'zod';
import { MAX_BULK_UPLOAD_ROWS, objectIdSchema } from './common.js';

export const MAX_CARRY_BULK_USERS = 500;

export const leaveCarryBulkTemplateQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(2100),
    fromYear: z.coerce.number().int().min(2000).max(2100),
    toYear: z.coerce.number().int().min(2000).max(2100),
    departmentId: objectIdSchema.optional(),
    userIds: z
      .union([z.string(), z.array(objectIdSchema)])
      .optional()
      .transform((value) => {
        if (!value) return undefined;
        if (Array.isArray(value)) return value;
        const ids = value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        return ids.length > 0 ? ids : undefined;
      })
      .pipe(z.array(objectIdSchema).min(1).max(MAX_CARRY_BULK_USERS).optional()),
  })
  .refine((value) => value.toYear >= value.fromYear, {
    message: 'To year must be on or after from year.',
    path: ['toYear'],
  });

export const leaveCarryBulkRowSchema = z
  .object({
    employeeCode: z.string().trim().min(1, 'Employee code is required.'),
    employeeName: z.string().trim().optional(),
    fromYear: z.coerce.number().int().min(2000).max(2100),
    toYear: z.coerce.number().int().min(2000).max(2100),
    leaveType: z.string().trim().min(1, 'Leave type is required.'),
    carriedDays: z.coerce.number().min(0).max(365),
    reason: z.string().trim().max(500).optional().default(''),
    leaveTypeCode: z.string().trim().optional(),
  })
  .refine((value) => value.toYear >= value.fromYear, {
    message: 'To year must be on or after from year.',
    path: ['toYear'],
  });

export const leaveCarryBulkUploadBodySchema = z.object({
  rows: z.array(leaveCarryBulkRowSchema).min(1).max(MAX_BULK_UPLOAD_ROWS),
});
