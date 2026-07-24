import { z } from 'zod';
import { paginationSchema } from './common.js';

export const auditLogQuerySchema = paginationSchema.extend({
  action: z.enum(['login_success', 'login_failed']).optional(),
});
