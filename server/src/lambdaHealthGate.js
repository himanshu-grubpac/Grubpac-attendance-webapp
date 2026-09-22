function readLambdaPath(event) {
  return (
    event?.rawPath ??
    event?.path ??
    event?.requestContext?.http?.path ??
    ''
  );
}

function readDbQueryFlag(event) {
  const params = event?.queryStringParameters;
  if (params && typeof params === 'object') {
    const value = params.db ?? params.DB;
    if (value != null) return String(value);
  }

  const rawQuery = event?.rawQueryString;
  if (typeof rawQuery === 'string' && rawQuery.length > 0) {
    const search = new URLSearchParams(rawQuery);
    const value = search.get('db');
    if (value != null) return value;
  }

  return null;
}

function isDeepHealthDbCheck(event) {
  const flag = readDbQueryFlag(event);
  return flag === '1' || flag === 'true';
}

/**
 * Shallow GET /api/health must not block on Mongo — it is used for Lambda
 * warmup and client cold-start pings. Deep checks (?db=1) still require DB.
 */
export function shouldEnsureMongoForLambdaEvent(event) {
  const method = (
    event?.requestContext?.http?.method ??
    event?.httpMethod ??
    'GET'
  ).toUpperCase();

  if (method !== 'GET' && method !== 'HEAD') {
    return true;
  }

  const path = readLambdaPath(event);
  const isHealthPath = path === '/api/health' || path.endsWith('/health');

  if (!isHealthPath) {
    return true;
  }

  return isDeepHealthDbCheck(event);
}
