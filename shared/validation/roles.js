import { z } from 'zod';
import { ALL_PERMISSIONS, normalizePermissions } from '../permissions.js';
import { objectIdSchema } from './common.js';

const permissionsSchema = z
  .array(z.string())
  .transform((value) => normalizePermissions(value))
  .refine((value) => value.every((key) => ALL_PERMISSIONS.includes(key)), {
    message: 'One or more permissions are invalid.',
  });

export const createRoleSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Role name must be at least 2 characters.')
    .max(80, 'Role name must be at most 80 characters.'),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, 'Slug must be at least 2 characters.')
    .max(50, 'Slug must be at most 50 characters.')
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers, and hyphens.'),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  permissions: permissionsSchema.default([]),
});

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(500).optional().or(z.literal('')),
    permissions: permissionsSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });

export const roleListQuerySchema = z.object({
  includeSystem: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value !== 'false'),
});

export const assignUserOrgSchema = z.object({
  roleId: objectIdSchema.optional(),
  departmentId: objectIdSchema.nullable().optional(),
  reportingManagerId: objectIdSchema.nullable().optional(),
});

export const permissionsListSchema = z.object({});
