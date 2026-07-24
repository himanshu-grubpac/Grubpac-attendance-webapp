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
