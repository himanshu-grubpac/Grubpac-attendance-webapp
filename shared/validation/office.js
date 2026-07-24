import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from './common.js';

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
});
