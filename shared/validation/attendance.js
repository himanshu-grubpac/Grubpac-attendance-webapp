import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from './common.js';

export const attendancePayloadSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  accuracyMeters: z
    .number()
    .finite()
    .positive('Location accuracy must be a positive number.'),
  clientTimestamp: z.string().datetime({ message: 'Invalid client timestamp.' }),
});
