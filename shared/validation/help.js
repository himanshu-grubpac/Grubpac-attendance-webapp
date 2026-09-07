import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common.js';

export const HELP_CATEGORIES = ['Login', 'Attendance', 'Leave', 'Salary', 'Other'];
export const HELP_PRIORITIES = ['low', 'medium', 'high'];
export const HELP_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

export const createHelpTicketSchema = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters.').max(200),
  category: z.enum(HELP_CATEGORIES, {
    errorMap: () => ({ message: 'Invalid category.' }),
  }),
  description: z
    .string()
    .trim()
    .min(10, 'Description must be at least 10 characters.')
    .max(5000),
  priority: z.enum(HELP_PRIORITIES).optional(),
});

export const updateHelpTicketStatusSchema = z
  .object({
    status: z
      .enum(HELP_STATUSES, {
        errorMap: () => ({ message: 'Invalid status.' }),
      })
      .optional(),
    priority: z
      .enum(HELP_PRIORITIES, {
        errorMap: () => ({ message: 'Invalid priority.' }),
      })
      .optional(),
    assignedTo: objectIdSchema.optional().nullable(),
  })
  .refine((data) => data.status !== undefined || data.priority !== undefined, {
    message: 'At least one of status or priority must be provided.',
  });

export const createHelpCommentSchema = z.object({
  body: z.string().trim().min(1, 'Comment cannot be empty.').max(5000),
});

export const helpTicketQuerySchema = paginationSchema.extend({
  scope: z.enum(['mine', 'team', 'all']).default('mine'),
  status: z.enum(HELP_STATUSES).optional(),
});

export const HELP_ATTACHMENT_MAX_BYTES = 5_242_880;

export const presignHelpAttachmentSchema = z.object({
  fileName: z.string().trim().min(1, 'File name is required.').max(255),
  mimeType: z.string().trim().min(1, 'File type is required.'),
  sizeBytes: z
    .number()
    .int('File size must be a whole number.')
    .positive('File size must be greater than zero.')
    .max(HELP_ATTACHMENT_MAX_BYTES, 'File exceeds the 5 MB limit.'),
});
