import { z } from 'zod';
import { indianMobileSchema, objectIdSchema, passwordSchema } from './common.js';

export const dateInputSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.');

export const employeeInputSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(2, 'First name must be at least 2 characters.')
    .max(50, 'First name must be at most 50 characters.'),
  lastName: z
    .string()
    .trim()
    .min(1, 'Last name is required.')
    .max(50, 'Last name must be at most 50 characters.'),
  email: z.string().trim().email('Valid email is required.').max(254),
  mobile: indianMobileSchema,
  password: passwordSchema,
  employeeCode: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .optional()
    .or(z.literal('')),
  designation: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .or(z.literal('')),
  joiningDate: dateInputSchema,
  endingDate: z
    .union([dateInputSchema, z.literal('')])
    .optional()
    .transform((value) => (value ? value : undefined)),
  department: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .or(z.literal('')),
  roleId: objectIdSchema.optional(),
  departmentId: objectIdSchema.optional(),
  reportingManagerId: objectIdSchema.optional(),
});

export const updateEmployeeOrgSchema = z
  .object({
    roleId: objectIdSchema.optional(),
    departmentId: objectIdSchema.nullable().optional(),
    reportingManagerId: objectIdSchema.nullable().optional(),
    delegateApproverId: objectIdSchema.nullable().optional(),
    isActive: z.boolean().optional(),
    firstName: z
      .string()
      .trim()
      .min(2, 'First name must be at least 2 characters.')
      .max(50, 'First name must be at most 50 characters.')
      .optional(),
    lastName: z
      .string()
      .trim()
      .min(1, 'Last name is required.')
      .max(50, 'Last name must be at most 50 characters.')
      .optional(),
    designation: z.string().trim().max(100).nullable().optional(),
    joiningDate: dateInputSchema.optional(),
    endingDate: dateInputSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });
