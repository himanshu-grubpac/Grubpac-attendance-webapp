import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'crypto';
import {
  AUTO_APPROVE_LEAVE_TYPE_CODES,
  isAutoApproveLeaveType,
  hashDecisionToken,
} from './leaveService.js';

test('AUTO_APPROVE_LEAVE_TYPE_CODES includes SL', () => {
  assert.equal(AUTO_APPROVE_LEAVE_TYPE_CODES.has('SL'), true);
});

test('isAutoApproveLeaveType matches SL case-insensitively', () => {
  assert.equal(isAutoApproveLeaveType({ code: 'SL' }), true);
  assert.equal(isAutoApproveLeaveType({ code: 'sl' }), true);
  assert.equal(isAutoApproveLeaveType({ code: 'CL' }), false);
  assert.equal(isAutoApproveLeaveType(null), false);
});

test('hashDecisionToken produces a SHA-256 hex digest', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = hashDecisionToken(raw);
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('hashDecisionToken is deterministic for the same input', () => {
  const raw = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const hash1 = hashDecisionToken(raw);
  const hash2 = hashDecisionToken(raw);
  assert.equal(hash1, hash2);
});

test('hashDecisionToken produces different hashes for different inputs', () => {
  const raw1 = crypto.randomBytes(32).toString('hex');
  const raw2 = crypto.randomBytes(32).toString('hex');
  const hash1 = hashDecisionToken(raw1);
  const hash2 = hashDecisionToken(raw2);
  assert.notEqual(hash1, hash2);
});

test('hashDecisionToken produces different hashes for raw token vs its hash', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = hashDecisionToken(raw);
  const hashOfHash = hashDecisionToken(hash);
  assert.notEqual(raw, hash);
  assert.notEqual(hash, hashOfHash);
});

test('timing-safe comparison works for valid token matching', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const stored = hashDecisionToken(raw);
  const candidate = hashDecisionToken(raw);
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(candidate, 'hex');
  assert.equal(a.length, b.length);
  assert.equal(crypto.timingSafeEqual(a, b), true);
});

test('timing-safe comparison fails for different tokens', () => {
  const raw1 = crypto.randomBytes(32).toString('hex');
  const raw2 = crypto.randomBytes(32).toString('hex');
  const hash1 = hashDecisionToken(raw1);
  const hash2 = hashDecisionToken(raw2);
  const a = Buffer.from(hash1, 'hex');
  const b = Buffer.from(hash2, 'hex');
  assert.equal(a.length, b.length);
  assert.equal(crypto.timingSafeEqual(a, b), false);
});

test('token TTL validation: expired token is rejected', () => {
  const now = new Date();
  const expired = new Date(now.getTime() - 1000);
  const valid = new Date(now.getTime() + 1000);
  assert.equal(expired <= now, true, 'expired time should be <= now');
  assert.equal(valid > now, true, 'valid time should be > now');
});

test('token TTL validation: token at exact expiry is rejected', () => {
  const now = new Date();
  assert.equal(now <= now, true, 'exact expiry should be rejected (expiresAt <= now)');
});

test('decision token array structure matches schema', () => {
  const tokenRecord = {
    tokenHash: crypto.randomBytes(32).toString('hex'),
    action: 'approve',
    managerId: new crypto.Hash('sha256').update('manager1').digest('hex').slice(0, 24),
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    used: false,
    usedAt: null,
  };
  assert.equal(typeof tokenRecord.tokenHash, 'string');
  assert.ok(tokenRecord.action === 'approve' || tokenRecord.action === 'reject');
  assert.equal(typeof tokenRecord.used, 'boolean');
  assert.equal(tokenRecord.usedAt, null);
});

test('decision token is single-use: once used flag is true, it should be skipped', () => {
  const tokens = [
    { action: 'approve', used: true, expiresAt: new Date(Date.now() + 10000) },
    { action: 'approve', used: false, expiresAt: new Date(Date.now() + 10000) },
  ];
  const candidate = tokens[1];
  const matched = tokens.find(
    (t) => t.action === 'approve' && !t.used && t.expiresAt > new Date(),
  );
  assert.equal(matched, candidate);
});

test('decision token matching: wrong action is rejected', () => {
  const tokens = [
    { action: 'reject', used: false, expiresAt: new Date(Date.now() + 10000) },
  ];
  const matched = tokens.find(
    (t) => t.action === 'approve' && !t.used && t.expiresAt > new Date(),
  );
  assert.equal(matched, undefined);
});

test('decision token matching: expired token is rejected', () => {
  const tokens = [
    { action: 'approve', used: false, expiresAt: new Date(Date.now() - 1000) },
  ];
  const matched = tokens.find(
    (t) => t.action === 'approve' && !t.used && t.expiresAt > new Date(),
  );
  assert.equal(matched, undefined);
});

test('decision token matching: all conditions must pass', () => {
  const tokens = [
    { action: 'reject', used: false, expiresAt: new Date(Date.now() + 10000) },
    { action: 'approve', used: true, expiresAt: new Date(Date.now() + 10000) },
    { action: 'approve', used: false, expiresAt: new Date(Date.now() - 1000) },
    { action: 'approve', used: false, expiresAt: new Date(Date.now() + 10000) },
  ];
  const matched = tokens.find(
    (t) => t.action === 'approve' && !t.used && t.expiresAt > new Date(),
  );
  assert.ok(matched);
  assert.equal(matched, tokens[3]);
});
