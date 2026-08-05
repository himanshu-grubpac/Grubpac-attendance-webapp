import { z } from 'zod';
import { SYSTEM_ROLE_SLUGS } from '../permissions.js';

const VALID_ROLE_SLUGS = Object.values(SYSTEM_ROLE_SLUGS);

const CONTENT_KINDS = ['url', 'text'];

const visibleRolesSchema = z
  .array(
    z.string().trim().refine(
      (value) => VALID_ROLE_SLUGS.includes(value),
      { message: `Role slug must be one of: ${VALID_ROLE_SLUGS.join(', ')}` },
    ),
  )
  .min(1, 'At least one role must be selected.');

export const createDemoFaqSchema = z.object({
  type: z
    .string()
    .trim()
    .min(1, 'Type is required.')
    .max(100, 'Type must be at most 100 characters.'),
  title: z
    .string()
    .trim()
    .min(1, 'Title is required.')
    .max(300, 'Title must be at most 300 characters.'),
  content: z
    .string()
    .trim()
    .min(1, 'Content is required.')
    .max(5000, 'Content must be at most 5000 characters.'),
  contentKind: z
    .enum(CONTENT_KINDS)
    .optional()
    .default('text'),
  visibleRoles: visibleRolesSchema,
  sortOrder: z.coerce.number().int().min(0).max(9999).optional().default(0),
});

export const updateDemoFaqSchema = z
  .object({
    type: z.string().trim().min(1).max(100).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    content: z.string().trim().min(1).max(5000).optional(),
    contentKind: z.enum(CONTENT_KINDS).optional(),
    visibleRoles: visibleRolesSchema.optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.',
  });
