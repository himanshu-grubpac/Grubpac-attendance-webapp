import { z } from 'zod';
import { deviceIdSchema, latitudeSchema, longitudeSchema, objectIdSchema } from './common.js';

const hhmmTimeSchema = z
  .string()
  .trim()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Time must be HH:mm in 24-hour format.');

const istDayKeySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Day must be YYYY-MM-DD.');

export const ATTENDANCE_STATUS_CODES = ['P', 'HD', 'LV', ...Array.from({ length: 10 }, (_, i) => `W${i + 1}`)];

const adminAttendancePayloadFields = {
  checkInTime: hhmmTimeSchema.optional(),
  checkOutTime: hhmmTimeSchema.nullable().optional(),
  statusCode: z.enum(ATTENDANCE_STATUS_CODES).optional(),
  leaveTypeId: objectIdSchema.optional(),
  /** Admin-only: mark the day absent without a check-in (same LOP effect as implicit past absent). */
  markAbsent: z.boolean().optional(),
  attendanceMode: z.enum(['office', 'wfh']).optional().default('office'),
  lateNote: z
    .string()
    .trim()
    .max(500, 'Late note must be at most 500 characters.')
    .optional()
    .nullable()
    .transform((value) => (value ? value : null)),
};

function refineAdminAttendancePayload(data, ctx) {
  if (data.markAbsent) {
    if (data.leaveTypeId) {
      ctx.addIssue({
        code: 'custom',
        message: 'Cannot combine mark absent with a leave type.',
        path: ['markAbsent'],
      });
    }
    if (data.checkInTime) {
      ctx.addIssue({
        code: 'custom',
        message: 'Check-in time must be omitted when marking absent.',
        path: ['checkInTime'],
      });
    }
    if (data.checkOutTime) {
      ctx.addIssue({
        code: 'custom',
        message: 'Check-out time must be omitted when marking absent.',
        path: ['checkOutTime'],
      });
    }
    return;
  }

  if (!data.statusCode && !data.leaveTypeId) {
    ctx.addIssue({
      code: 'custom',
      message: 'Either attendance status or leave type is required.',
      path: ['statusCode'],
    });
  }
  if (!data.leaveTypeId && !data.checkInTime) {
    ctx.addIssue({
      code: 'custom',
      message: 'Check-in time is required unless applying leave only or marking absent.',
      path: ['checkInTime'],
    });
  }
}

export const adminAttendanceEditSchema = z
  .object(adminAttendancePayloadFields)
  .superRefine(refineAdminAttendancePayload);

/** Admin create-or-upsert attendance for a user on an IST calendar day (no existing check-in required). */
export const adminAttendanceUpsertSchema = z
  .object({
    userId: objectIdSchema,
    dayKey: istDayKeySchema,
    ...adminAttendancePayloadFields,
  })
  .superRefine(refineAdminAttendancePayload);

export const attendancePayloadSchema = z.object({
  deviceId: deviceIdSchema,
  attendanceMode: z.enum(['office', 'wfh']).optional(),
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

/** Admin reset of quarterly late-check-in warnings (Late Warning page) for selected employees. */
export const MAX_QUARTER_WARNING_RESET_USERS = 200;

export const resetQuarterWarningsSchema = z.object({
  userIds: z
    .array(objectIdSchema)
    .min(1, 'Select at least one employee.')
    .max(MAX_QUARTER_WARNING_RESET_USERS, `At most ${MAX_QUARTER_WARNING_RESET_USERS} employees per reset.`),
  reason: z.string().trim().max(500).optional(),
});
