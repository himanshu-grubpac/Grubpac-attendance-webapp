import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_MIME_TYPES,
  buildS3Key,
  isAllowedMimeType,
  sanitizeFilename,
} from './helpAttachmentService.js';

test('sanitizeFilename strips path segments and unsafe characters', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Users\\docs\\report.pdf'), 'report.pdf');
  assert.equal(sanitizeFilename('screenshot (1).png'), 'screenshot (1).png');
  assert.equal(sanitizeFilename('../../../'), 'file');
  assert.equal(sanitizeFilename(''), 'file');
});

test('sanitizeFilename limits length', () => {
  const longName = `${'a'.repeat(250)}.pdf`;
  assert.equal(sanitizeFilename(longName).length, 200);
});

test('isAllowedMimeType accepts only the configured allowlist', () => {
  for (const mimeType of ALLOWED_MIME_TYPES) {
    assert.equal(isAllowedMimeType(mimeType), true);
  }
  assert.equal(isAllowedMimeType('text/html'), false);
  assert.equal(isAllowedMimeType('application/javascript'), false);
  assert.equal(isAllowedMimeType('image/gif'), false);
});

test('buildS3Key uses help-tickets prefix, ticket id, uuid, and sanitized filename', () => {
  const key = buildS3Key('507f1f77bcf86cd799439011', '../invoice.PDF', 'help-tickets');
  assert.match(key, /^help-tickets\/507f1f77bcf86cd799439011\/.+-invoice\.PDF$/);
  assert.doesNotMatch(key, /\.\./);
});
