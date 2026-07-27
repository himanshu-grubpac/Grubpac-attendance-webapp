import { z } from 'zod';
import { objectIdSchema } from './common.js';

export const monthInputSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM.');

export const updateUserSalarySchema = z
  .object({
    monthlySalary: z
      .number()
      .finite()
      .min(0, 'Monthly salary must be zero or positive.')
      .max(100_000_000, 'Monthly salary is too large.')
      .nullable()
      .optional(),
    salaryEffectiveFrom: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Effective date must be YYYY-MM-DD.')
      .nullable()
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });

export const salarySummaryQuerySchema = z.object({
  userId: objectIdSchema.optional(),
  month: monthInputSchema,
});

export const salaryExportQuerySchema = z.object({
  month: monthInputSchema,
});

export const salaryStructureQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(120).optional(),
});

export const updateSalarySettingsSchema = z
  .object({
    payrollDayOfMonth: z
      .number()
      .int()
      .min(1, 'Payroll day must be between 1 and 28.')
      .max(28, 'Payroll day must be between 1 and 28.')
      .nullable()
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });

export const salaryTransferStatusSchema = z.enum(['pending', 'paid', 'failed']);

export const salaryTransferListQuerySchema = z.object({
  month: monthInputSchema,
  status: salaryTransferStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const generateSalaryTransfersSchema = z.object({
  month: monthInputSchema,
});

export const updateSalaryTransferStatusSchema = z
  .object({
    status: salaryTransferStatusSchema,
    note: z.string().trim().max(500).optional(),
    failureReason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'failed' && value.failureReason === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Failure reason cannot be empty when provided.',
        path: ['failureReason'],
      });
    }
  });
