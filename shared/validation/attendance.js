import { z } from 'zod';
import { deviceIdSchema, latitudeSchema, longitudeSchema } from './common.js';

const hhmmTimeSchema = z
  .string()
  .trim()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Time must be HH:mm in 24-hour format.');

export const ATTENDANCE_STATUS_CODES = ['P', 'HD', 'LV', ...Array.from({ length: 10 }, (_, i) => `W${i + 1}`)];

export const adminAttendanceEditSchema = z.object({
  checkInTime: hhmmTimeSchema,
  checkOutTime: hhmmTimeSchema.nullable().optional(),
  statusCode: z.enum(ATTENDANCE_STATUS_CODES),
  attendanceMode: z.enum(['office', 'wfh']),
  lateNote: z
    .string()
    .trim()
    .max(500, 'Late note must be at most 500 characters.')
    .optional()
    .nullable()
    .transform((value) => (value ? value : null)),
});

export const attendancePayloadSchema = z.object({
  deviceId: deviceIdSchema,
  attendanceMode: z.enum(['office', 'wfh']).default('office'),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  accuracyMeters: z
    .number()
    .finite()
    .positive('Location accuracy must be a positive number.'),
  clientTimestamp: z.string().datetime({ message: 'Invalid client timestamp.' }),
  lateNote: z
    .string()
    .trim()
    .max(500, 'Late note must be at most 500 characters.')
    .optional()
    .transform((value) => (value ? value : undefined)),
});
