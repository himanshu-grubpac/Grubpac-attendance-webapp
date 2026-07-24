import { ZodError } from 'zod';

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      message: 'Validation failed.',
      errors: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  if (error.code === 11000) {
    const field = Object.keys(error.keyPattern ?? {})[0] ?? 'field';
    return res.status(409).json({
      message: `Duplicate value for ${field}.`,
    });
  }

  console.error(error);
  return res.status(error.statusCode ?? 500).json({
    message: error.message ?? 'Internal server error.',
  });
}
