import { z } from 'zod';

export const MAX_BULK_UPLOAD_ROWS = 500;
export const MAX_LOCATION_AGE_MS = 30_000;
export const MAX_FUTURE_SKEW_MS = 5_000;
export const GPS_SAMPLE_COUNT = 3;
export const GPS_SAMPLE_INTERVAL_MS = 800;

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be at most 128 characters.')
  .regex(/[A-Z]/, 'Password must include an uppercase letter.')
  .regex(/[a-z]/, 'Password must include a lowercase letter.')
  .regex(/[0-9]/, 'Password must include a number.');

export function normalizeMobile(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/^\+91/, '')
    .replace(/\D/g, '')
    .slice(-10);
}

export const indianMobileSchema = z
  .string()
  .trim()
  .transform(normalizeMobile)
  .refine(
    (value) => /^[6-9]\d{9}$/.test(value),
    'Mobile must be a valid 10-digit Indian number.',
  );

export const latitudeSchema = z
  .number()
  .finite()
  .min(-90, 'Latitude must be between -90 and 90.')
  .max(90, 'Latitude must be between -90 and 90.');

export const longitudeSchema = z
  .number()
  .finite()
  .min(-180, 'Longitude must be between -180 and 180.')
  .max(180, 'Longitude must be between -180 and 180.');

export const objectIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'Invalid identifier.');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function formatZodErrors(error) {
  return error.issues.map((issue) => issue.message).join(' ');
}
