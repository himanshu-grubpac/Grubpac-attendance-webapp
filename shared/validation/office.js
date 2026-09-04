import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from './common.js';

const timeStringSchema = z
  .string()
  .trim()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Enter a valid time.');

function timeToMinutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

const autoCheckoutConfigSchema = z.object({
  day: z.enum(['same', 'next']),
  time: timeStringSchema,
});

export const autoCheckoutSchema = z.object({
  enabled: z.boolean().optional(),
  office: autoCheckoutConfigSchema.optional(),
  wfh: autoCheckoutConfigSchema.optional(),
});

export const officeObjectSchema = z.object({
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
  weekendDays: z
    .array(z.number().int().min(0).max(6))
    .min(1, 'Select at least one weekend day.')
    .max(7)
    .optional(),
  autoCheckout: autoCheckoutSchema.optional(),
});

export const officeSchema = officeObjectSchema.superRefine((value, ctx) => {
  const start = value.officeStartTime ? timeToMinutes(value.officeStartTime) : null;
  const end = value.officeEndTime ? timeToMinutes(value.officeEndTime) : null;
  const warning = value.graceThresholdTime ? timeToMinutes(value.graceThresholdTime) : null;
  const halfDay = value.halfDayThresholdTime ? timeToMinutes(value.halfDayThresholdTime) : null;

  if (start != null && end != null && end <= start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['officeEndTime'], message: 'Office end must be after office start.' });
  }
  if (start != null && warning != null && warning < start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['graceThresholdTime'], message: 'Warning threshold cannot be before office start.' });
  }
  if (warning != null && halfDay != null && halfDay <= warning) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['halfDayThresholdTime'], message: 'Half-day threshold must be after the warning threshold.' });
  }
  if (end != null && halfDay != null && halfDay > end) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['halfDayThresholdTime'], message: 'Half-day threshold cannot be after office end.' });
  }
});
export const officeUpdateSchema = officeObjectSchema.partial();
