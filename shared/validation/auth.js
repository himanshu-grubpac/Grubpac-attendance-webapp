import { z } from 'zod';
import { deviceIdSchema, emailSchema, indianMobileSchema, passwordSchema } from './common.js';

/** System PIN is strictly 4 digits — 6-digit PINs were retired. */
const pinRegex = /^\d{4}$/;
export const pinSchema = z
  .string()
  .regex(pinRegex, 'PIN must be exactly 4 digits.');

export const fourDigitPinSchema = pinSchema;

/**
 * Employee self-service PIN setup/change.
 * `currentPin` is required only when the user already has a PIN (change flow);
 * the server also enforces that rule.
 */
export const setPinSchema = z
  .object({
    pin: fourDigitPinSchema,
    confirmPin: z.string().min(1, 'Please confirm the PIN.'),
    // Supplied so the server can re-verify identity when saving the PIN.
    currentPin: fourDigitPinSchema.optional(),
    currentPassword: z.string().min(1).max(128).optional(),
  })
  .refine((data) => data.pin === data.confirmPin, {
    message: 'PINs do not match.',
    path: ['confirmPin'],
  });

/**
 * Login accepts a single identifier that may be an email, a 10-digit Indian
 * mobile number, or an employee code. Detection order: email (contains @) →
 * mobile (10 digits, optionally with +91/spaces/dashes) → employeeCode.
 */
export function detectIdentifierType(identifier) {
  const value = String(identifier ?? '').trim();
  if (value.includes('@')) {
    return 'email';
  }
  const digitsOnly = value.replace(/[\s-]/g, '').replace(/^\+91/, '');
  if (/^[6-9]\d{9}$/.test(digitsOnly)) {
    return 'mobile';
  }
  return 'employeeCode';
}

export const loginSchema = z
  .object({
    identifier: z.string().trim().max(254).optional(),
    // Legacy alias — older clients/scripts send `email`. Accepted as a fallback
    // so the same field can carry an email, mobile number, or employee code.
    email: z.string().trim().max(254).optional(),
    password: z.string().min(1, 'Password is required.').max(128),
    deviceId: deviceIdSchema,
  })
  .transform(({ identifier, email, password, deviceId }) => ({
    identifier: (identifier || email || '').trim(),
    password,
    deviceId,
  }))
  .refine((data) => data.identifier.length > 0, {
    message: 'Email, mobile number, or employee ID is required.',
    path: ['identifier'],
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required.').max(128),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, 'Please confirm the new password.').max(128),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must be different from the current password.',
    path: ['newPassword'],
  });

export const adminResetPasswordSchema = z
  .object({
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, 'Please confirm the new password.').max(128),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

export const adminResetPinSchema = z
  .object({
    newPin: pinSchema,
    confirmPin: z.string(),
  })
  .refine((data) => data.newPin === data.confirmPin, {
    message: 'PINs do not match.',
    path: ['confirmPin'],
  });

/** Self-service profile edits — never accepts role, permissions, email, or org fields. */
export const updateProfileSchema = z
  .object({
    firstName: z
      .string()
      .trim()
      .min(2, 'First name must be at least 2 characters.')
      .max(50, 'First name must be at most 50 characters.')
      .optional(),
    lastName: z
      .string()
      .trim()
      .max(50, 'Last name must be at most 50 characters.')
      .optional(),
    mobile: indianMobileSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });

/** Employee self-service password reset — step 1: request a magic link. */
export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

/** Employee self-service password reset — step 2: validate a magic-link token. */
export const resetPasswordVerifySchema = z.object({
  token: z.string().min(1, 'Reset token is required.'),
});

/** Employee self-service password reset — step 3: set a new password. */
export const resetPasswordSchema = z
  .object({
    token: z.string().min(1, 'Reset token is required.'),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, 'Please confirm the new password.').max(128),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });
