import { z } from 'zod';

export const createDepartmentSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Department name must be at least 2 characters.')
    .max(100, 'Department name must be at most 100 characters.'),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Department code must be at least 2 characters.')
    .max(20, 'Department code must be at most 20 characters.')
    .regex(/^[A-Z0-9_-]+$/, 'Code may only contain letters, numbers, underscores, and hyphens.'),
});

export const updateDepartmentSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(2)
      .max(20)
      .regex(/^[A-Z0-9_-]+$/)
      .optional(),
    isActive: z.boolean().optional(),
    leadUserId: z.string().trim().regex(/^[a-f\d]{24}$/i, 'Invalid lead user.').nullable().optional(),
    deputyUserId: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, 'Invalid deputy user.')
      .nullable()
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });
