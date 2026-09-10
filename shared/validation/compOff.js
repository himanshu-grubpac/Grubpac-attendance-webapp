import { z } from 'zod';
import { paginationSchema } from './common.js';

/** IST day input (YYYY-MM-DD). Same style as istDateInputSchema in leave.js. */
export const compOffDateInput = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD (IST).');

export const createCompOffRequestSchema = z
  .object({
    startDate: compOffDateInput,
    endDate: compOffDateInput,
    reason: z.string().trim().min(3, 'Reason must be at least 3 characters.').max(1000),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: 'End date must be on or after start date.',
    path: ['endDate'],
  });

/**
 * Approve/assess remarks are optional; reject REQUIRES a non-empty remark
 * (enforced in the service, matching the leave decision flow).
 */
export const compOffDecisionSchema = z.object({
  comment: z.string().trim().max(500).optional().nullable(),
});

export const compOffRejectSchema = z.object({
  comment: z.string().trim().min(1, 'A remark is required for rejection.').max(500),
});

export const compOffDayAssessmentSchema = z.object({
  date: compOffDateInput,
  assessment: z.enum(['completed', 'half', 'none']),
});

/**
 * Per-day assessment is the canonical form: one rate per eligible day in the
 * request range. The legacy single-rate `assessment` form (applied to every
 * day) is still accepted for backward compatibility. Remark stays optional
 * at the API layer; the admin UI requires it before submitting.
 */
export const compOffAssessSchema = z
  .object({
    assessment: z.enum(['completed', 'half', 'none']).optional(),
    assessments: z.array(compOffDayAssessmentSchema).min(1).max(366).optional(),
    comment: z.string().trim().max(500).optional().nullable(),
  })
  .refine((value) => value.assessment || value.assessments, {
    message: 'Provide an assessment rate or per-day assessments.',
    path: ['assessment'],
  });

export const compOffEligibleDaysQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const compOffQuerySchema = paginationSchema.extend({
  status: z
    .enum(['pending', 'approved', 'worked', 'assessed', 'rejected', 'lapsed', 'cancelled', 'closed', 'all'])
    .default('all'),
  scope: z.enum(['mine', 'approvals']).default('mine'),
  userId: z
    .string()
    .trim()
    .regex(/^[a-f\d]{24}$/i, 'Invalid identifier.')
    .optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM.')
    .optional(),
});
