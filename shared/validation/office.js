import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from './common.js';

const timeStringSchema = z
  .string()
  .trim()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Time must be HH:mm (24-hour).');

export const officeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Office name must be at least 2 characters.')
    .max(120),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  radiusMeters: z
    .number()
    .positive('Radius must be greater than 0.')
    .max(5000, 'Radius must be at most 5000 metres.'),
  maxAccuracyMeters: z
    .number()
    .positive('Max accuracy must be greater than 0.')
    .max(500, 'Max accuracy must be at most 500 metres.'),
  sandwichLeaveEnabled: z.boolean().optional(),
  officeStartTime: timeStringSchema.optional(),
  officeEndTime: timeStringSchema.optional(),
  graceThresholdTime: timeStringSchema.optional(),
  halfDayThresholdTime: timeStringSchema.optional(),
  warningsPerQuarter: z.number().int().min(0).max(10).optional(),
});
