import { z } from 'zod';

/** Stable table key identifiers — must match model ALLOWED_TABLE_KEYS. */
const ALLOWED_TABLE_KEYS = [
  'employeeList',
  'attendanceToday',
  'attendanceHistory',
  'leaveList',
];

const columnSchema = z.object({
  key: z.string().trim().min(1, 'Column key is required.'),
  order: z.number().int().min(0),
  width: z.number().int().min(0).nullable().optional(),
  pinned: z.enum(['left', 'right']).nullable().optional(),
});

const sortSchema = z.object({
  key: z.string().trim().min(1).nullable().optional(),
  direction: z.enum(['asc', 'desc']).nullable().optional(),
});

export const tableKeyParamSchema = z.object({
  tableKey: z
    .string()
    .trim()
    .refine((val) => ALLOWED_TABLE_KEYS.includes(val), {
      message: 'Invalid table key.',
    }),
});

export const updateTablePreferenceSchema = z.object({
  columns: z.array(columnSchema).max(30, 'Too many columns.').optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
  sort: sortSchema.optional(),
  filters: z.record(z.unknown()).nullable().optional(),
});
