import { z } from 'zod';
import { paginationSchema } from './common.js';

export const auditLogQuerySchema = paginationSchema.extend({
  action: z.enum(['login_success', 'login_failed']).optional(),
  search: z.string().trim().max(100).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')
    .optional(),
  conflictsOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
