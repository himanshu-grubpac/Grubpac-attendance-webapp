import test from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import {
  ALLOWED_MIME_TYPES,
  buildS3Key,
  getS3Client,
  isAllowedMimeType,
  resetS3ClientForTests,
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

function stashAwsEnv() {
  const keys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
  const saved = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreAwsEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('getS3Client falls back to the default chain when no static keys exist (Lambda role)', () => {
  const saved = stashAwsEnv();
  try {
    resetS3ClientForTests();
    const client = getS3Client();
    assert.ok(client instanceof S3Client);
    assert.equal(getS3Client(), client, 'client is cached');
  } finally {
    resetS3ClientForTests();
    restoreAwsEnv(saved);
  }
});

test('getS3Client forwards static keys including the session token', async () => {
  const saved = stashAwsEnv();
  try {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret-example';
    process.env.AWS_SESSION_TOKEN = 'session-example';
    resetS3ClientForTests();
    const client = getS3Client();
    assert.ok(client instanceof S3Client);
    const credentials = await client.config.credentials();
    assert.equal(credentials.accessKeyId, 'AKIAEXAMPLE');
    assert.equal(credentials.secretAccessKey, 'secret-example');
    assert.equal(credentials.sessionToken, 'session-example');
  } finally {
    resetS3ClientForTests();
    restoreAwsEnv(saved);
  }
});
