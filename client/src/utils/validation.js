import { ZodError } from 'zod';
import { formatZodErrors } from '@shared/validation/common.js';

export function validateForm(schema, values) {
  try {
    return { data: schema.parse(values), errors: {} };
  } catch (error) {
    if (error instanceof ZodError) {
      const errors = {};
      for (const issue of error.issues) {
        const key = issue.path[0] ?? 'form';
        if (!errors[key]) {
          errors[key] = issue.message;
        }
      }
      return { data: null, errors };
    }
    throw error;
  }
}

export function getFirstError(errors) {
  const values = Object.values(errors);
  return values[0] ?? formatZodErrors({ issues: [] });
}
