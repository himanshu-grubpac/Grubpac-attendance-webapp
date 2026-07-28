import assert from 'node:assert/strict';
import test from 'node:test';
import { LAMBDA_BINARY_CONTENT_TYPES } from '../config/lambdaBinarySettings.js';

function matchesBinaryContentType(contentType) {
  const binaryContentTypesRegexes = LAMBDA_BINARY_CONTENT_TYPES.map((binaryContentType) =>
    new RegExp(`^${binaryContentType.replace(/\*/g, '.*')}$`),
  );
  return binaryContentTypesRegexes.some((pattern) => pattern.test(contentType));
}

test('Lambda binary settings include spreadsheet MIME types', () => {
  assert.equal(
    matchesBinaryContentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    true,
  );
  assert.equal(matchesBinaryContentType('application/vnd.ms-excel'), true);
  assert.equal(matchesBinaryContentType('application/json'), false);
});
