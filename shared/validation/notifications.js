import { z } from 'zod';
import { objectIdSchema } from './common.js';

export const notificationIdSchema = z.object({
  id: objectIdSchema,
});
