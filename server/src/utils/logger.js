/**
 * Structured JSON logging helper. Attach requestId from req.logContext when available.
 */
export function log(level, message, meta = {}) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(message, meta) {
  log('info', message, meta);
}

export function logWarn(message, meta) {
  log('warn', message, meta);
}

export function logError(message, meta) {
  log('error', message, meta);
}

export function logFromRequest(req, level, message, extra = {}) {
  log(level, message, {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    userId: req.user?._id?.toString?.(),
    ...extra,
  });
}
