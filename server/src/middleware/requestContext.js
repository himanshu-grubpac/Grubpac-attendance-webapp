import { randomUUID } from 'crypto';
import { logInfo } from '../utils/logger.js';

/**
 * Assigns a correlation / request ID to every request and logs completion.
 */
export function requestContextMiddleware(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && incoming.trim().length > 0 && incoming.length <= 128
      ? incoming.trim()
      : randomUUID();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const startedAt = Date.now();
  res.on('finish', () => {
    logInfo('request_completed', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      userId: req.user?._id?.toString?.(),
    });
  });

  next();
}
