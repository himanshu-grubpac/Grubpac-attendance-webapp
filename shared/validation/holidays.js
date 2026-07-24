import { z } from 'zod';
import { istDateInputSchema } from './leave.js';

export const createHolidaySchema = z.object({
  date: istDateInputSchema,
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
});

export const updateHolidaySchema = z
  .object({
    date: istDateInputSchema.optional(),
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });

export const holidayQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
