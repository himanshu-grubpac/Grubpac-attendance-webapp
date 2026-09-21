import { z } from 'zod';
import { objectIdSchema, paginationSchema, pastOrCurrentYearSchema } from './common.js';

export const leaveAdjustmentGridQuerySchema = paginationSchema.extend({
  year: pastOrCurrentYearSchema,
  search: z.string().trim().max(200).optional(),
  departmentId: objectIdSchema.optional(),
});

export const leaveAdjustmentBatchItemSchema = z.object({
  userId: objectIdSchema,
  leaveTypeId: objectIdSchema,
  year: pastOrCurrentYearSchema,
  // Negative carried stock is allowed as a LOP deduction (reduces available
  // balance). Core balance math already tolerates negatives (available may go
  // negative; combined pools and carry-forward clamp per-type at 0).
  carried: z.number().min(-365, 'Carried days must be between -365 and 365.').max(365, 'Carried days must be between -365 and 365.'),
  reason: z.string().trim().min(3).max(500).optional(),
});

export const leaveAdjustmentBatchSchema = z.object({
  adjustments: z.array(leaveAdjustmentBatchItemSchema).min(1).max(500),
});

export const leaveAdjustmentHistoryQuerySchema = z.object({
  year: pastOrCurrentYearSchema.optional(),
});

export const DEFAULT_LEAVE_ADJUSTMENT_REASON = 'Manual carried adjustment via leave policies';
