import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldEnsureMongoForLambdaEvent } from './lambdaHealthGate.js';

test('shallow GET /api/health skips Mongo connect', () => {
  assert.equal(
    shouldEnsureMongoForLambdaEvent({
      rawPath: '/api/health',
      requestContext: { http: { method: 'GET', path: '/api/health' } },
    }),
    false,
  );
});

test('deep GET /api/health?db=1 requires Mongo connect', () => {
  assert.equal(
    shouldEnsureMongoForLambdaEvent({
      rawPath: '/api/health',
      rawQueryString: 'db=1',
      requestContext: { http: { method: 'GET', path: '/api/health' } },
    }),
    true,
  );
});

test('non-health API routes require Mongo connect', () => {
  assert.equal(
    shouldEnsureMongoForLambdaEvent({
      rawPath: '/api/admin/users',
      requestContext: { http: { method: 'GET', path: '/api/admin/users' } },
    }),
    true,
  );
});

test('mutating requests to /api/health require Mongo connect', () => {
  assert.equal(
    shouldEnsureMongoForLambdaEvent({
      rawPath: '/api/health',
      requestContext: { http: { method: 'POST', path: '/api/health' } },
    }),
    true,
  );
});
