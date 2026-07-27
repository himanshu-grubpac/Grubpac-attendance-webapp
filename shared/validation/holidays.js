import { z } from 'zod';
import { istDateInputSchema } from './leave.js';

export const holidayTypeSchema = z.string().trim().regex(/^[a-z0-9-]+$/).min(1).max(50);

export const createHolidayCategorySchema = z.object({
  name: z.string().trim().min(2).max(50),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
});

export const updateHolidayCategorySchema = createHolidayCategorySchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field is required.' },
);

export const createHolidaySchema = z.object({
  date: istDateInputSchema,
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(500).optional().nullable(),
  type: holidayTypeSchema.optional(),
  isActive: z.boolean().optional(),
});

export const updateHolidaySchema = z
  .object({
    date: istDateInputSchema.optional(),
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    type: holidayTypeSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });

export const holidayQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const recurringHolidayRuleSchema = z.object({
  nth: z.number().int().min(-1).max(5),
  weekday: z.number().int().min(0).max(6),
  months: z.union([
    z.literal('all'),
    z.array(z.number().int().min(1).max(12)).min(1),
  ]),
  type: holidayTypeSchema.optional(),
  name: z.string().trim().min(2).max(200),
});

export const recurringHolidayRulesSchema = z.object({
  rules: z.array(recurringHolidayRuleSchema),
});

export const materializeRecurringSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
});
