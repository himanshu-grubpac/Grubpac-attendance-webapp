import { ZodError } from 'zod';
import { duplicateFieldMessage } from '../utils/duplicateFieldMessage.js';

const MONGO_UNAVAILABLE_ERROR_NAMES = new Set([
  'MongoNetworkError',
  'MongooseServerSelectionError',
  'MongoServerSelectionError',
  'MongoParseError',
]);

export function isMongoUnavailableError(error) {
  return MONGO_UNAVAILABLE_ERROR_NAMES.has(error?.name);
}

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
    const field = error.field ?? Object.keys(error.keyPattern ?? {})[0] ?? 'field';
    return res.status(409).json({
      message: duplicateFieldMessage(field),
      field,
    });
  }

  if (error.statusCode === 409 && error.field) {
    return res.status(409).json({
      message: error.message,
      field: error.field,
    });
  }

  if (isMongoUnavailableError(error)) {
    console.warn(error);
    res.set('Retry-After', '2');
    return res.status(503).json({
      message: 'Database temporarily unavailable.',
      code: 'DB_UNAVAILABLE',
    });
  }

  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 500) {
    console.error(error);
  } else if (statusCode >= 400) {
    console.warn(error);
  }
  return res.status(statusCode).json({
    message: error.message ?? 'Internal server error.',
  });
}
