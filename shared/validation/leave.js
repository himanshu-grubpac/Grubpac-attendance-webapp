import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common.js';

export const istDateInputSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD (IST).');

export const createLeaveTypeSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,5}$/, 'Leave type code must be 2–5 uppercase letters.'),
  name: z.string().trim().min(2).max(100),
  isActive: z.boolean().optional(),
});

export const updateLeaveTypeSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });

export const leavePolicyQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const createLeavePolicySchema = z.object({
  leaveTypeId: objectIdSchema,
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  annualQuota: z.number().min(0).max(365),
  accrualPerMonth: z.number().min(0).max(31).default(0),
  carryForwardMax: z.number().min(0).max(365).default(0),
  maxAccumulation: z.number().min(0).max(365).default(0),
  requireDocAfterConsecutiveDays: z.number().int().min(1).max(30).nullable().optional(),
  paid: z.boolean().default(true),
  encashmentMaxPerYear: z.number().min(0).max(365).default(0),
  combinedCarryGroup: z.string().trim().max(20).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const updateLeavePolicySchema = z
  .object({
    annualQuota: z.number().min(0).max(365).optional(),
    accrualPerMonth: z.number().min(0).max(31).optional(),
    carryForwardMax: z.number().min(0).max(365).optional(),
    maxAccumulation: z.number().min(0).max(365).optional(),
    requireDocAfterConsecutiveDays: z.number().int().min(1).max(30).nullable().optional(),
    paid: z.boolean().optional(),
    encashmentMaxPerYear: z.number().min(0).max(365).optional(),
    combinedCarryGroup: z.string().trim().max(20).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });

export const createLeaveRequestSchema = z
  .object({
    leaveTypeId: objectIdSchema,
    startDate: istDateInputSchema,
    endDate: istDateInputSchema,
    halfDay: z.enum(['am', 'pm']).optional().nullable(),
    reason: z.string().trim().min(3, 'Reason must be at least 3 characters.').max(1000),
    documentUrl: z.string().trim().url('Document URL must be valid.').max(500).optional().nullable(),
    adminException: z.boolean().optional(),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: 'End date must be on or after start date.',
    path: ['endDate'],
  })
  .refine((value) => !value.halfDay || value.startDate === value.endDate, {
    message: 'Half-day leave must use the same start and end date.',
    path: ['halfDay'],
  });

export const previewLeaveDaysQuerySchema = z.object({
  startDate: istDateInputSchema,
  endDate: istDateInputSchema,
  halfDay: z.enum(['am', 'pm']).optional().nullable(),
});

export const encashLeaveSchema = z.object({
  leaveTypeId: objectIdSchema,
  year: z.coerce.number().int().min(2000).max(2100),
  days: z.number().min(0.5).max(365),
  reason: z.string().trim().min(3).max(500),
});

export const carryForwardPreviewQuerySchema = z.object({
  fromYear: z.coerce.number().int().min(2000).max(2100),
  userId: objectIdSchema.optional(),
});

export const carryForwardSchema = z.object({
  fromYear: z.coerce.number().int().min(2000).max(2100),
  userId: objectIdSchema.optional(),
  userIds: z.array(objectIdSchema).min(1).max(500).optional(),
});

export const leaveDecisionSchema = z.object({
  comment: z.string().trim().min(1, 'A remark is required.').max(500),
  adminException: z.boolean().optional(),
});

export const adjustLeaveBalanceSchema = z.object({
  leaveTypeId: objectIdSchema,
  year: z.coerce.number().int().min(2000).max(2100),
  entitled: z.number().min(0).max(365).optional(),
  used: z.number().min(0).max(365).optional(),
  pending: z.number().min(0).max(365).optional(),
  carried: z.number().min(0).max(365).optional(),
  encashed: z.number().min(0).max(365).optional(),
  reason: z.string().trim().min(3).max(500),
});

export const leaveBalanceQuerySchema = z.object({
  userId: objectIdSchema.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const leaveRequestQuerySchema = paginationSchema.extend({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('all'),
  userId: objectIdSchema.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM.')
    .optional(),
  scope: z.enum(['mine', 'team', 'all', 'approvals']).default('mine'),
});

export const teamCalendarQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM.')
    .optional(),
  departmentId: objectIdSchema.optional(),
});
