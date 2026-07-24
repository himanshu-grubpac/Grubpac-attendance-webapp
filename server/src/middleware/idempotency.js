import { IdempotencyRecord } from '../models/IdempotencyRecord.js';
import { logWarn } from '../utils/logger.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_MAX_LEN = 128;
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Optional Idempotency-Key support for mutating routes.
 * Replays stored responses when the same user repeats the same key on the same route.
 */
export function idempotencyMiddleware(req, res, next) {
  const rawKey = req.headers[IDEMPOTENCY_HEADER];
  if (!rawKey || typeof rawKey !== 'string') {
    return next();
  }

  const key = rawKey.trim();
  if (!key || key.length > KEY_MAX_LEN) {
    return res.status(400).json({ message: 'Invalid Idempotency-Key header.' });
  }

  if (!req.user?._id) {
    return res.status(401).json({ message: 'Authentication required for idempotent requests.' });
  }

  const userId = req.user._id;
  const route = `${req.method}:${req.baseUrl}${req.path}`;

  IdempotencyRecord.findOne({ key, userId })
    .then(async (existing) => {
      if (existing) {
        if (existing.route !== route) {
          return res.status(409).json({ message: 'Idempotency-Key was already used for a different operation.' });
        }
        return res.status(existing.statusCode).json(existing.body);
      }

      const originalJson = res.json.bind(res);
      res.json = (body) => {
        const statusCode = res.statusCode || 200;
        if (statusCode >= 200 && statusCode < 300) {
          IdempotencyRecord.create({
            key,
            userId,
            route,
            statusCode,
            body,
            expiresAt: new Date(Date.now() + TTL_MS),
          }).catch((error) => {
            logWarn('idempotency_persist_failed', {
              requestId: req.requestId,
              key,
              error: error.message,
            });
          });
        }
        return originalJson(body);
      };

      next();
    })
    .catch((error) => {
      logWarn('idempotency_lookup_failed', {
        requestId: req.requestId,
        error: error.message,
      });
      next();
    });
}
