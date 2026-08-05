import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common.js';

export const leaveAdjustmentGridQuerySchema = paginationSchema.extend({
  year: z.coerce.number().int().min(2000).max(2100),
  search: z.string().trim().max(200).optional(),
  departmentId: objectIdSchema.optional(),
});

export const leaveAdjustmentBatchItemSchema = z.object({
  userId: objectIdSchema,
  leaveTypeId: objectIdSchema,
  year: z.coerce.number().int().min(2000).max(2100),
  carried: z.number().min(0).max(365),
  reason: z.string().trim().min(3).max(500).optional(),
});

export const leaveAdjustmentBatchSchema = z.object({
  adjustments: z.array(leaveAdjustmentBatchItemSchema).min(1).max(500),
});

export const DEFAULT_LEAVE_ADJUSTMENT_REASON = 'Manual carried adjustment via leave policies';
