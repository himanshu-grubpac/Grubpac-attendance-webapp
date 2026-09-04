import { z } from 'zod';

/**
 * Optional department lead/deputy selector value.
 * The UI sends '' for "None" — normalize empty/blank to null so "no selection"
 * validates as "not set" instead of failing the ObjectId check. Only name and
 * code are mandatory; lead and deputy stay optional.
 */
function optionalDepartmentUserIdField(message) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, message)
      .nullable()
      .optional(),
  );
}

export const createDepartmentSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Department name must be at least 2 characters.')
    .max(100, 'Department name must be at most 100 characters.'),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Department code must be at least 2 characters.')
    .max(20, 'Department code must be at most 20 characters.')
    .regex(/^[A-Z0-9_-]+$/, 'Code may only contain letters, numbers, underscores, and hyphens.'),

  leadUserId: optionalDepartmentUserIdField('Invalid lead user.'),
  deputyUserId: optionalDepartmentUserIdField('Invalid deputy user.'),
});

export const updateDepartmentSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(2)
      .max(20)
      .regex(/^[A-Z0-9_-]+$/)
      .optional(),
    isActive: z.boolean().optional(),
    leadUserId: optionalDepartmentUserIdField('Invalid lead user.'),
    deputyUserId: optionalDepartmentUserIdField('Invalid deputy user.'),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });
