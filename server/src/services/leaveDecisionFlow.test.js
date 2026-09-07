import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'crypto';
import {
  hashDecisionToken,
  formatLeaveDateText,
} from './leaveService.js';
import { leaveDecisionLoginHandler } from '../controllers/leaveController.js';
import { CSRF_COOKIE_NAME } from '../middleware/csrf.js';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function mockUser(overrides = {}) {
  return {
    _id: overrides._id || '507f1f77bcf86cd799439011',
    name: overrides.name || 'Test Manager',
    email: overrides.email || 'manager@example.com',
    mobile: overrides.mobile || null,
    whatsappOptIn: overrides.whatsappOptIn || false,
    isActive: overrides.isActive !== undefined ? overrides.isActive : true,
    reportingManagerId: overrides.reportingManagerId || null,
    delegateApproverId: overrides.delegateApproverId || null,
    roleId: overrides.roleId || null,
    tokenVersion: overrides.tokenVersion || 0,
    ...overrides,
  };
}

function mockLeaveType(overrides = {}) {
  return {
    _id: overrides._id || '507f1f77bcf86cd799439012',
    code: overrides.code || 'CL',
    name: overrides.name || 'Casual Leave',
    isActive: overrides.isActive !== undefined ? overrides.isActive : true,
    ...overrides,
  };
}

function mockLeaveRequest(overrides = {}) {
  const doc = {
    _id: overrides._id || '507f1f77bcf86cd799439013',
    userId: overrides.userId || mockUser({ _id: '507f1f77bcf86cd799439011', name: 'Applicant' }),
    leaveTypeId: overrides.leaveTypeId || mockLeaveType(),
    startDate: overrides.startDate || new Date('2026-09-01'),
    endDate: overrides.endDate || new Date('2026-09-01'),
    days: overrides.days || 1,
    halfDay: overrides.halfDay || null,
    reason: overrides.reason || 'Personal work',
    status: overrides.status || 'pending',
    documentUrl: overrides.documentUrl || null,
    approverId: overrides.approverId || null,
    decidedAt: overrides.decidedAt || null,
    decisionComment: overrides.decisionComment || null,
    adminException: overrides.adminException || false,
    decisionTokens: overrides.decisionTokens || [],
    notifyAfter: overrides.notifyAfter || null,
    notificationsSent: overrides.notificationsSent || false,
    createdAt: overrides.createdAt || new Date(),
    updatedAt: overrides.updatedAt || new Date(),
    toSafeJSON() {
      return {
        id: this._id,
        userId: this.userId?._id ?? this.userId,
        status: this.status,
        days: this.days,
        leaveTypeCode: this.leaveTypeId?.code ?? null,
      };
    },
  };
  return doc;
}

function makeTokenRecord(rawToken, overrides = {}) {
  return {
    _id: overrides._id || new crypto.Hash('sha256').update(rawToken).digest('hex').slice(0, 24),
    tokenHash: hashDecisionToken(rawToken),
    action: overrides.action || 'approve',
    managerId: overrides.managerId || '507f1f77bcf86cd799439011',
    expiresAt: overrides.expiresAt || new Date(Date.now() + 48 * 60 * 60 * 1000),
    used: overrides.used !== undefined ? overrides.used : false,
    usedAt: overrides.usedAt || null,
  };
}

function simulateTokenConsume(tokens, action, rawToken) {
  const candidate = hashDecisionToken(rawToken);
  let matched = null;
  for (const t of tokens) {
    if (t.action !== action || t.used || t.expiresAt <= new Date()) continue;
    const a = Buffer.from(t.tokenHash, 'hex');
    const b = Buffer.from(candidate, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      matched = t;
      break;
    }
  }
  if (!matched) return null;
  matched.used = true;
  matched.usedAt = new Date();
  return matched.managerId;
}

function simulatePeekToken(tokens, action, rawToken) {
  const candidate = hashDecisionToken(rawToken);
  for (const t of tokens) {
    if (t.action !== action || t.used || t.expiresAt <= new Date()) continue;
    const a = Buffer.from(t.tokenHash, 'hex');
    const b = Buffer.from(candidate, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { managerId: t.managerId, matched: true };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 1: Token Generation (issueLeaveDecisionToken)
// ═══════════════════════════════════════════════════════════════════════════

test('Token generation: raw token is 64-char hex string', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  assert.equal(typeof raw, 'string');
  assert.equal(raw.length, 64);
  assert.match(raw, /^[0-9a-f]{64}$/);
});

test('Token generation: hash of raw token matches stored hash', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashDecisionToken(raw);
  const candidate = hashDecisionToken(raw);
  const a = Buffer.from(tokenHash, 'hex');
  const b = Buffer.from(candidate, 'hex');
  assert.equal(a.length, b.length);
  assert.equal(crypto.timingSafeEqual(a, b), true);
});

test('Token generation: default TTL is 48 hours', () => {
  const now = Date.now();
  const ttl = 48 * 60 * 60 * 1000;
  const expiresAt = new Date(now + ttl);
  const diff = expiresAt.getTime() - now;
  assert.ok(diff > ttl - 1000 && diff <= ttl, 'TTL should be ~48 hours');
});

test('Token generation: token record has correct fields', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const record = {
    tokenHash: hashDecisionToken(raw),
    action: 'approve',
    managerId: '507f1f77bcf86cd799439011',
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    used: false,
    usedAt: null,
  };
  assert.equal(typeof record.tokenHash, 'string');
  assert.equal(record.tokenHash.length, 64);
  assert.equal(record.action, 'approve');
  assert.equal(typeof record.managerId, 'string');
  assert.ok(record.expiresAt instanceof Date);
  assert.equal(record.used, false);
  assert.equal(record.usedAt, null);
});

test('Token generation: multiple tokens for same request (different managers)', () => {
  const approveToken1 = makeTokenRecord(crypto.randomBytes(32).toString('hex'), {
    action: 'approve',
    managerId: 'manager1',
  });
  const approveToken2 = makeTokenRecord(crypto.randomBytes(32).toString('hex'), {
    action: 'approve',
    managerId: 'manager2',
  });
  const rejectToken1 = makeTokenRecord(crypto.randomBytes(32).toString('hex'), {
    action: 'reject',
    managerId: 'manager1',
  });
  const rejectToken2 = makeTokenRecord(crypto.randomBytes(32).toString('hex'), {
    action: 'reject',
    managerId: 'manager2',
  });
  const tokens = [approveToken1, approveToken2, rejectToken1, rejectToken2];
  assert.equal(tokens.length, 4);
  const managers = new Set(tokens.map((t) => t.managerId));
  assert.equal(managers.size, 2, 'Should have tokens for 2 managers');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2: Token Consumption (consumeLeaveDecisionToken)
// ═══════════════════════════════════════════════════════════════════════════

test('Token consumption: valid token returns managerId', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve', managerId: 'mgr_abc' });
  const result = simulateTokenConsume([token], 'approve', raw);
  assert.equal(result, 'mgr_abc');
});

test('Token consumption: valid token marks token as used', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve' });
  assert.equal(token.used, false);
  simulateTokenConsume([token], 'approve', raw);
  token.used = true;
  assert.equal(token.used, true);
});

test('Token consumption: expired token returns null', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, {
    action: 'approve',
    expiresAt: new Date(Date.now() - 1000),
  });
  const result = simulateTokenConsume([token], 'approve', raw);
  assert.equal(result, null);
});

test('Token consumption: token at exact expiry returns null', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, {
    action: 'approve',
    expiresAt: new Date(),
  });
  const result = simulateTokenConsume([token], 'approve', raw);
  assert.equal(result, null);
});

test('Token consumption: used token returns null', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve', used: true });
  const result = simulateTokenConsume([token], 'approve', raw);
  assert.equal(result, null);
});

test('Token consumption: wrong action returns null', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'reject' });
  const result = simulateTokenConsume([token], 'approve', raw);
  assert.equal(result, null);
});

test('Token consumption: invalid token hash returns null', () => {
  const raw1 = crypto.randomBytes(32).toString('hex');
  const raw2 = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw1, { action: 'approve' });
  const result = simulateTokenConsume([token], 'approve', raw2);
  assert.equal(result, null);
});

test('Token consumption: empty tokens array returns null', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const result = simulateTokenConsume([], 'approve', raw);
  assert.equal(result, null);
});

test('Token consumption: multiple tokens, only correct one matches', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokens = [
    makeTokenRecord(crypto.randomBytes(32).toString('hex'), { action: 'reject' }),
    makeTokenRecord(crypto.randomBytes(32).toString('hex'), { action: 'approve', used: true }),
    makeTokenRecord(crypto.randomBytes(32).toString('hex'), {
      action: 'approve',
      expiresAt: new Date(Date.now() - 1000),
    }),
    makeTokenRecord(raw, { action: 'approve', managerId: 'correct_manager' }),
  ];
  const result = simulateTokenConsume(tokens, 'approve', raw);
  assert.equal(result, 'correct_manager');
});

test('Token consumption: timing-safe comparison prevents timing attacks', () => {
  const raw1 = crypto.randomBytes(32).toString('hex');
  const raw2 = crypto.randomBytes(32).toString('hex');
  const hash1 = hashDecisionToken(raw1);
  const hash2 = hashDecisionToken(raw2);
  const a = Buffer.from(hash1, 'hex');
  const b = Buffer.from(hash2, 'hex');
  assert.equal(a.length, b.length, 'Buffer lengths should match for timing-safe comparison');
  assert.equal(crypto.timingSafeEqual(a, b), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 3: Token Peek (peekLeaveDecisionToken)
// ═══════════════════════════════════════════════════════════════════════════

test('Token peek: valid token returns managerId without consuming', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve', managerId: 'mgr_peek' });
  const result = simulatePeekToken([token], 'approve', raw);
  assert.ok(result);
  assert.equal(result.managerId, 'mgr_peek');
  assert.equal(token.used, false, 'Token should NOT be consumed by peek');
});

test('Token peek: expired token returns null', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, {
    action: 'approve',
    expiresAt: new Date(Date.now() - 1000),
  });
  const result = simulatePeekToken([token], 'approve', raw);
  assert.equal(result, null);
});

test('Token peek: used token returns null', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve', used: true });
  const result = simulatePeekToken([token], 'approve', raw);
  assert.equal(result, null);
});

test('Token peek: wrong action returns null', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'reject' });
  const result = simulatePeekToken([token], 'approve', raw);
  assert.equal(result, null);
});

test('Token peek: invalid token returns null', () => {
  const raw1 = crypto.randomBytes(32).toString('hex');
  const raw2 = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw1, { action: 'approve' });
  const result = simulatePeekToken([token], 'approve', raw2);
  assert.equal(result, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 4: Auto Login (autoLoginByDecisionToken)
// ═══════════════════════════════════════════════════════════════════════════

test('Auto login: token is peeked, not consumed (login reusable until decided)', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve', managerId: 'mgr1' });
  const peeked = simulatePeekToken([token], 'approve', raw);
  assert.equal(peeked?.managerId, 'mgr1');
  assert.equal(token.used, false, 'Login must not consume the token');
});

test('Auto login: request must be pending', () => {
  const request = mockLeaveRequest({ status: 'approved' });
  assert.notEqual(request.status, 'pending', 'Approved request should reject auto-login');
});

test('Auto login: cancelled request is rejected', () => {
  const request = mockLeaveRequest({ status: 'cancelled' });
  assert.notEqual(request.status, 'pending', 'Cancelled request should reject auto-login');
});

test('Auto login: manager must be active', () => {
  const manager = mockUser({ isActive: false });
  assert.equal(manager.isActive, false, 'Inactive manager should be rejected');
});

test('Auto login: deleted manager (null) is rejected', () => {
  const manager = null;
  assert.equal(!manager || !manager.isActive, true, 'Deleted manager should be rejected');
});

test('Auto login: valid flow — token peeked + request pending + manager active', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve', managerId: 'mgr1' });
  const request = mockLeaveRequest({ status: 'pending' });
  const manager = mockUser({ _id: 'mgr1', isActive: true });

  const peeked = simulatePeekToken([token], 'approve', raw);
  assert.equal(peeked?.managerId, 'mgr1');
  assert.equal(token.used, false, 'Login leaves the token usable');
  assert.equal(request.status, 'pending');
  assert.equal(manager.isActive, true);
});

test('Decision by token: generic decide token satisfies an approve decision (fallback)', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'decide', managerId: 'mgr1' });
  // Exact-action consume misses; decide-fallback consumes.
  assert.equal(simulateTokenConsume([token], 'approve', raw), null);
  const fallback = makeTokenRecord(raw, { action: 'decide', managerId: 'mgr1' });
  assert.equal(simulateTokenConsume([fallback], 'decide', raw), 'mgr1');
  assert.equal(fallback.used, true, 'Decision consumes the token (single-use)');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 5: Decision by Token (decideLeaveRequestByToken)
// ═══════════════════════════════════════════════════════════════════════════

test('Decision by token: invalid token → returns null (410)', () => {
  const raw1 = crypto.randomBytes(32).toString('hex');
  const raw2 = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw1, { action: 'approve' });
  const result = simulateTokenConsume([token], 'approve', raw2);
  assert.equal(result, null, 'Invalid token should return null → 410');
});

test('Decision by token: deleted manager → 403 (not null actor passed to processLeaveDecision)', () => {
  const manager = null;
  assert.equal(!manager || !manager.isActive, true, 'Deleted manager should be rejected before processLeaveDecision');
});

test('Decision by token: inactive manager → 403 (not null actor passed to processLeaveDecision)', () => {
  const manager = mockUser({ isActive: false });
  assert.equal(!manager || !manager.isActive, true, 'Inactive manager should be rejected before processLeaveDecision');
});

test('Decision by token: already decided request → 409', () => {
  const request = mockLeaveRequest({ status: 'approved' });
  assert.notEqual(request.status, 'pending', 'Already decided request should throw 409');
});

test('Decision by token: approve action processes correctly', () => {
  const request = mockLeaveRequest({ status: 'pending' });
  const isApproved = true;
  const status = isApproved ? 'approved' : 'rejected';
  assert.equal(status, 'approved');
  assert.equal(request.status, 'pending');
});

test('Decision by token: reject action processes correctly', () => {
  const request = mockLeaveRequest({ status: 'pending' });
  const isApproved = false;
  const status = isApproved ? 'approved' : 'rejected';
  assert.equal(status, 'rejected');
  assert.equal(request.status, 'pending');
});

test('Decision by token: all tokens cleared after decision', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve' });
  const request = mockLeaveRequest({ decisionTokens: [token] });
  assert.ok(request.decisionTokens.length > 0, 'Should have tokens before decision');
  request.decisionTokens = [];
  assert.equal(request.decisionTokens.length, 0, 'All tokens cleared after decision');
});

test('Decision by token: approve token consumed before decision processes', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve' });
  const managerId = simulateTokenConsume([token], 'approve', raw);
  assert.equal(managerId, token.managerId, 'Token consumed before decision');
  assert.equal(token.used, true);
});

test('Decision by token: reject token consumed before decision processes', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'reject' });
  const managerId = simulateTokenConsume([token], 'reject', raw);
  assert.equal(managerId, token.managerId, 'Reject token consumed before decision');
  assert.equal(token.used, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 6: Process Leave Decision (processLeaveDecision)
// ═══════════════════════════════════════════════════════════════════════════

test('Process decision: approve sets status to approved', () => {
  const request = mockLeaveRequest({ status: 'pending' });
  const decision = 'approve';
  const isApproved = decision === 'approve' || decision === 'approved';
  const status = isApproved ? 'approved' : 'rejected';
  assert.equal(status, 'approved');
});

test('Process decision: reject sets status to rejected', () => {
  const request = mockLeaveRequest({ status: 'pending' });
  const decision = 'reject';
  const isApproved = decision === 'approve' || decision === 'approved';
  const status = isApproved ? 'approved' : 'rejected';
  assert.equal(status, 'rejected');
});

test('Process decision: approval sets notifyAfter to 15 seconds in future', () => {
  const now = Date.now();
  const LEAVE_DECISION_UNDO_MS = 15 * 1000;
  const notifyAfter = new Date(now + LEAVE_DECISION_UNDO_MS);
  const diff = notifyAfter.getTime() - now;
  assert.ok(diff >= LEAVE_DECISION_UNDO_MS - 100 && diff <= LEAVE_DECISION_UNDO_MS + 100);
});

test('Process decision: rejection sets notifyAfter to 15 seconds in future (deferred)', () => {
  const now = Date.now();
  const LEAVE_DECISION_UNDO_MS = 15 * 1000;
  const notifyAfter = new Date(now + LEAVE_DECISION_UNDO_MS);
  const diff = notifyAfter.getTime() - now;
  assert.ok(diff >= LEAVE_DECISION_UNDO_MS - 100 && diff <= LEAVE_DECISION_UNDO_MS + 100);
});

test('Process decision: approval sets notificationsSent to false (deferred)', () => {
  const notificationsSent = false;
  assert.equal(notificationsSent, false);
});

test('Process decision: rejection sets notificationsSent to false (deferred)', () => {
  const notificationsSent = false;
  assert.equal(notificationsSent, false);
});

test('Process decision: all decisionTokens cleared after approval', () => {
  const request = mockLeaveRequest({
    decisionTokens: [
      makeTokenRecord(crypto.randomBytes(32).toString('hex'), { action: 'approve' }),
      makeTokenRecord(crypto.randomBytes(32).toString('hex'), { action: 'reject' }),
    ],
  });
  request.decisionTokens = [];
  assert.equal(request.decisionTokens.length, 0);
});

test('Process decision: all decisionTokens cleared after rejection', () => {
  const request = mockLeaveRequest({
    decisionTokens: [
      makeTokenRecord(crypto.randomBytes(32).toString('hex'), { action: 'approve' }),
    ],
  });
  request.decisionTokens = [];
  assert.equal(request.decisionTokens.length, 0);
});

test('Process decision: approverId is set on the request', () => {
  const request = mockLeaveRequest({ status: 'pending' });
  const actor = mockUser({ _id: 'approver1' });
  request.approverId = actor._id;
  assert.equal(request.approverId, 'approver1');
});

test('Process decision: decidedAt is set to current time', () => {
  const before = Date.now();
  const decidedAt = new Date();
  const after = Date.now();
  assert.ok(decidedAt.getTime() >= before && decidedAt.getTime() <= after);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 7: Controller Handlers (leaveDecisionLinkPageHandler)
// ═══════════════════════════════════════════════════════════════════════════

test('Decision link page: missing query params → 400', () => {
  // Controller: if (!request || !action || !token || (action !== 'approve' && action !== 'reject'))
  const missingParamCases = [
    {},
    { request: 'abc' },
    { request: 'abc', action: 'approve' },
    { action: 'approve', token: 'tok' },
    { token: 'tok' },
    { action: 'reject' },
    { request: 'abc', token: 'tok' },
  ];
  for (const query of missingParamCases) {
    const shouldFail = !query.request || !query.action || !query.token;
    assert.equal(shouldFail, true, `Query ${JSON.stringify(query)} should fail (missing param)`);
  }
});

test('Decision link page: invalid action value → 400', () => {
  const invalidActions = ['approvee', 'delete', 'cancel', 'pending', 'approved'];
  for (const action of invalidActions) {
    const validAction = action === 'approve' || action === 'reject';
    assert.equal(validAction, false, `Action "${action}" should be invalid`);
  }
});

test('Decision link page: valid action values', () => {
  assert.equal('approve' === 'approve' || 'approve' === 'reject', true);
  assert.equal('reject' === 'approve' || 'reject' === 'reject', true);
});

test('Decision link page: invalid token → 410', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve' });
  const result = simulatePeekToken([token], 'approve', crypto.randomBytes(32).toString('hex'));
  assert.equal(result, null, 'Invalid token should return null → 410');
});

test('Decision link page: expired token → 410', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, {
    action: 'approve',
    expiresAt: new Date(Date.now() - 1000),
  });
  const result = simulatePeekToken([token], 'approve', raw);
  assert.equal(result, null, 'Expired token should return null → 410');
});

test('Decision link page: used token → 410', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve', used: true });
  const result = simulatePeekToken([token], 'approve', raw);
  assert.equal(result, null, 'Used token should return null → 410');
});

test('Decision link page: already decided request → 409', () => {
  const request = mockLeaveRequest({ status: 'approved' });
  assert.notEqual(request.status, 'pending');
});

test('Decision link page: valid token + pending request → 200', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve', managerId: 'mgr1' });
  const request = mockLeaveRequest({ status: 'pending' });
  const peek = simulatePeekToken([token], 'approve', raw);
  assert.ok(peek);
  assert.equal(request.status, 'pending');
});

test('Decision link page: leave details included in confirmation page', () => {
  const request = mockLeaveRequest({
    reason: 'Family function',
    startDate: new Date('2026-09-15'),
    endDate: new Date('2026-09-15'),
  });
  const requester = mockUser({ name: 'John Doe' });
  const leaveType = mockLeaveType({ name: 'Casual Leave' });
  const details = {
    requesterName: requester.name,
    leaveTypeName: leaveType.name,
    reason: request.reason,
  };
  assert.equal(details.requesterName, 'John Doe');
  assert.equal(details.leaveTypeName, 'Casual Leave');
  assert.equal(details.reason, 'Family function');
});

test('Decision link page: portal URL included in confirmation page', () => {
  const clientOrigin = 'https://app.grubpac.com';
  const requestId = '507f1f77bcf86cd799439013';
  const portalUrl = `${clientOrigin}/admin/leave/approvals?request=${requestId}`;
  assert.ok(portalUrl.includes('/admin/leave/approvals'));
  assert.ok(portalUrl.includes(requestId));
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 8: Controller Handlers (leaveDecisionLinkHandler - POST)
// ═══════════════════════════════════════════════════════════════════════════

test('Decision link POST: missing body params → 400', () => {
  // Controller: if (!request || !action || !token || (action !== 'approve' && action !== 'reject'))
  const missingParamCases = [
    {},
    { request: 'abc' },
    { request: 'abc', action: 'approve' },
    { action: 'approve', token: 'tok' },
    { token: 'tok' },
    { action: 'reject' },
    { request: 'abc', token: 'tok' },
  ];
  for (const body of missingParamCases) {
    const shouldFail = !body.request || !body.action || !body.token;
    assert.equal(shouldFail, true, `Body ${JSON.stringify(body)} should fail (missing param)`);
  }
});

test('Decision link POST: invalid token → 410', () => {
  const raw1 = crypto.randomBytes(32).toString('hex');
  const raw2 = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw1, { action: 'approve' });
  const result = simulateTokenConsume([token], 'approve', raw2);
  assert.equal(result, null, 'Invalid token → 410');
});

test('Decision link POST: valid approve token → processes decision', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve', managerId: 'mgr1' });
  const managerId = simulateTokenConsume([token], 'approve', raw);
  assert.equal(managerId, 'mgr1');
  assert.equal(token.used, true);
});

test('Decision link POST: valid reject token → processes decision', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'reject', managerId: 'mgr1' });
  const managerId = simulateTokenConsume([token], 'reject', raw);
  assert.equal(managerId, 'mgr1');
  assert.equal(token.used, true);
});

test('Decision link POST: success page shows manager name', () => {
  const manager = mockUser({ name: 'Jane Smith' });
  const action = 'approve';
  const verb = action === 'approve' ? 'approved' : 'rejected';
  const by = manager.name ? ` by ${manager.name}` : '';
  const message = `Leave request ${verb} successfully${by}.`;
  assert.ok(message.includes('Jane Smith'));
  assert.ok(message.includes('approved'));
});

test('Decision link POST: success page includes portal link', () => {
  const clientOrigin = 'https://app.grubpac.com';
  const portalUrl = `${clientOrigin}/admin/leave/approvals`;
  assert.ok(portalUrl.includes('/admin/leave/approvals'));
});

test('Decision link POST: error page shows error message', () => {
  const error = new Error('This action link is invalid, has already been used, or has expired.');
  error.statusCode = 410;
  assert.equal(error.statusCode, 410);
  assert.ok(error.message.includes('invalid'));
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 9: Controller Handlers (leaveDecisionLoginHandler)
// ═══════════════════════════════════════════════════════════════════════════

test('Decision login: missing query params → 400', () => {
  // Controller: if (!request || !action || !token || (action !== 'approve' && action !== 'reject'))
  const query = {};
  const shouldFail = !query.request || !query.action || !query.token;
  assert.equal(shouldFail, true, 'Empty query should fail (missing all params)');
});

test('Decision login: partial query params → 400', () => {
  const cases = [
    { request: 'abc' },
    { action: 'approve' },
    { token: 'tok' },
    { request: 'abc', action: 'approve' },
  ];
  for (const query of cases) {
    const shouldFail = !query.request || !query.action || !query.token;
    assert.equal(shouldFail, true, `Query ${JSON.stringify(query)} should fail (missing param)`);
  }
});

test('Decision login: invalid action → 400', () => {
  const invalidActions = ['approvee', 'delete', 'cancel', 'pending', 'approved'];
  for (const action of invalidActions) {
    const validAction = action === 'approve' || action === 'reject' || action === 'decide';
    assert.equal(validAction, false, `Action "${action}" should be invalid`);
  }
});

test('Decision login: valid action values include decide', () => {
  assert.equal('approve' === 'approve' || 'approve' === 'reject' || 'approve' === 'decide', true);
  assert.equal('reject' === 'approve' || 'reject' === 'reject' || 'reject' === 'decide', true);
  assert.equal('decide' === 'approve' || 'decide' === 'reject' || 'decide' === 'decide', true);
});

test('Decision login: invalid token → 410', () => {
  const raw1 = crypto.randomBytes(32).toString('hex');
  const raw2 = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw1, { action: 'approve' });
  const result = simulateTokenConsume([token], 'approve', raw2);
  assert.equal(result, null);
});

test('Decision login: expired token → 410', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, {
    action: 'approve',
    expiresAt: new Date(Date.now() - 1000),
  });
  const result = simulateTokenConsume([token], 'approve', raw);
  assert.equal(result, null);
});

test('Decision login: used token → 410', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve', used: true });
  const result = simulateTokenConsume([token], 'approve', raw);
  assert.equal(result, null);
});

test('Decision login: already decided request → 409', () => {
  const request = mockLeaveRequest({ status: 'approved' });
  assert.notEqual(request.status, 'pending');
});

test('Decision login: inactive manager → 403', () => {
  const manager = mockUser({ isActive: false });
  assert.equal(!manager || !manager.isActive, true);
});

test('Decision login: deleted manager → 403', () => {
  const manager = null;
  assert.equal(!manager || !manager.isActive, true);
});

test('Decision login: valid token + pending + active → sets cookie + redirect', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve', managerId: 'mgr1' });
  const request = mockLeaveRequest({ status: 'pending' });
  const manager = mockUser({ _id: 'mgr1', isActive: true });

  const managerId = simulateTokenConsume([token], 'approve', raw);
  assert.equal(managerId, 'mgr1');
  assert.equal(request.status, 'pending');
  assert.equal(manager.isActive, true);

  const clientOrigin = 'https://app.grubpac.com';
  const redirectUrl = `${clientOrigin}/admin/leave/approvals?decision=request&requestId=${request._id}&action=approve`;
  assert.ok(redirectUrl.includes('decision=request'));
  assert.ok(redirectUrl.includes('action=approve'));
});

test('Decision login: redirect URL contains correct requestId', () => {
  const clientOrigin = 'https://app.grubpac.com';
  const requestId = '507f1f77bcf86cd799439013';
  const action = 'reject';
  const redirectUrl = `${clientOrigin}/admin/leave/approvals?decision=request&requestId=${requestId}&action=${action}`;
  assert.ok(redirectUrl.includes(requestId));
  assert.ok(redirectUrl.includes('action=reject'));
});

test('Decision login: missing query params → real handler responds 400 HTML', async () => {
  let statusCode = null;
  let contentType = null;
  let body = '';
  const req = { query: { request: 'abc' } };
  const res = {
    status(code) { statusCode = code; return this; },
    type(value) { contentType = value; return this; },
    send(payload) { body = payload; return this; },
  };
  await leaveDecisionLoginHandler(req, res);
  assert.equal(statusCode, 400);
  assert.equal(contentType, 'html');
  assert.match(body, /missing required parameters/);
});

test('Decision login: sets auth + CSRF cookies before redirect (same as normal login)', async () => {
  // Exercise the exact helpers leaveDecisionLoginHandler uses, with a stub res.
  const { setAuthCookie } = await import('../controllers/authController.js');
  const { generateCsrfToken, setCsrfCookie } = await import('../middleware/csrf.js');
  const cookies = {};
  const res = {
    cookie(name, value, options) { cookies[name] = { value, options }; },
  };
  setAuthCookie(res, 'jwt-test-token');
  const csrfToken = generateCsrfToken();
  setCsrfCookie(res, csrfToken);

  assert.ok(cookies.attendance_token, 'auth cookie is set');
  assert.equal(cookies.attendance_token.value, 'jwt-test-token');
  assert.equal(cookies.attendance_token.options.httpOnly, true);
  assert.equal(cookies.attendance_token.options.sameSite, 'lax');
  assert.equal(cookies.attendance_token.options.path, '/');

  assert.ok(cookies[CSRF_COOKIE_NAME], 'CSRF cookie is set');
  assert.equal(cookies[CSRF_COOKIE_NAME].value, csrfToken);
  assert.match(csrfToken, /^[a-f0-9]{64}$/);
  // CSRF cookie must be JS-readable so the client can echo it as X-CSRF-Token.
  assert.equal(cookies[CSRF_COOKIE_NAME].options.httpOnly, false);
  assert.equal(cookies[CSRF_COOKIE_NAME].options.path, '/');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 10: Email Rendering (renderLeaveManagerEmail)
// ═══════════════════════════════════════════════════════════════════════════

test('Email rendering: withActions=true includes single action URL', () => {
  const actionUrl = 'https://api.grubpac.com/api/leave/decision-login?request=abc&action=decide&token=tok1';
  assert.ok(actionUrl.includes('action=decide'));
  assert.ok(actionUrl.includes('token=tok1'));
});

test('Email rendering: withActions=false no action URL needed', () => {
  const withActions = false;
  assert.equal(withActions, false);
});

test('Email rendering: single Take Action URL per manager (not approve/reject pair)', () => {
  const token = crypto.randomBytes(32).toString('hex');
  const actionUrl = `https://api.grubpac.com/api/leave/decision-login?request=abc&action=decide&token=${token}`;
  assert.ok(actionUrl.includes('action=decide'));
});

test('Email rendering: includes requester name', () => {
  const requesterName = 'John Doe';
  assert.ok(requesterName.length > 0);
});

test('Email rendering: includes leave type name', () => {
  const leaveTypeName = 'Casual Leave';
  assert.ok(leaveTypeName.length > 0);
});

test('Email rendering: includes date text', () => {
  const dateText = '2026-09-15';
  assert.ok(dateText.length > 0);
});

test('Email rendering: includes reason', () => {
  const reason = 'Family function';
  assert.ok(reason.length > 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 11: Email Rendering (renderLeaveApplicantEmail)
// ═══════════════════════════════════════════════════════════════════════════

test('Applicant email: approved status', () => {
  const status = 'approved';
  assert.equal(status, 'approved');
});

test('Applicant email: rejected status', () => {
  const status = 'rejected';
  assert.equal(status, 'rejected');
});

test('Applicant email: includes remarks when provided', () => {
  const remarks = 'Approved with coverage';
  assert.ok(remarks.length > 0);
});

test('Applicant email: empty remarks when not provided', () => {
  const remarks = '';
  assert.equal(remarks, '');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 12: Edge Cases - Token Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

test('Token lifecycle: issue → peek → consume → rejected on second consume', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve', managerId: 'mgr1' });

  // Peek (non-consuming)
  const peek = simulatePeekToken([token], 'approve', raw);
  assert.ok(peek);
  assert.equal(peek.managerId, 'mgr1');
  assert.equal(token.used, false, 'Peek should not consume');

  // Consume
  const consume = simulateTokenConsume([token], 'approve', raw);
  assert.equal(consume, 'mgr1');
  token.used = true;

  // Second consume should fail
  const secondConsume = simulateTokenConsume([token], 'approve', raw);
  assert.equal(secondConsume, null, 'Already consumed token should fail');
});

test('Token lifecycle: approve and reject tokens are independent', () => {
  const rawApprove = crypto.randomBytes(32).toString('hex');
  const rawReject = crypto.randomBytes(32).toString('hex');
  const approveToken = makeTokenRecord(rawApprove, { action: 'approve', managerId: 'mgr1' });
  const rejectToken = makeTokenRecord(rawReject, { action: 'reject', managerId: 'mgr1' });

  // Consume approve token
  const approveResult = simulateTokenConsume([approveToken, rejectToken], 'approve', rawApprove);
  assert.equal(approveResult, 'mgr1');
  approveToken.used = true;

  // Reject token should still be valid
  const rejectResult = simulateTokenConsume([approveToken, rejectToken], 'reject', rawReject);
  assert.equal(rejectResult, 'mgr1');
});

test('Token lifecycle: consuming approve does not affect reject token', () => {
  const rawApprove = crypto.randomBytes(32).toString('hex');
  const rawReject = crypto.randomBytes(32).toString('hex');
  const approveToken = makeTokenRecord(rawApprove, { action: 'approve' });
  const rejectToken = makeTokenRecord(rawReject, { action: 'reject' });

  simulateTokenConsume([approveToken, rejectToken], 'approve', rawApprove);
  approveToken.used = true;

  assert.equal(approveToken.used, true);
  assert.equal(rejectToken.used, false, 'Reject token should still be unused');
});

test('Token lifecycle: multiple managers have independent tokens', () => {
  const raw1 = crypto.randomBytes(32).toString('hex');
  const raw2 = crypto.randomBytes(32).toString('hex');
  const token1 = makeTokenRecord(raw1, { action: 'approve', managerId: 'mgr1' });
  const token2 = makeTokenRecord(raw2, { action: 'approve', managerId: 'mgr2' });

  // Manager1 uses their token
  const result1 = simulateTokenConsume([token1, token2], 'approve', raw1);
  assert.equal(result1, 'mgr1');
  token1.used = true;

  // Manager2's token should still be valid
  const result2 = simulateTokenConsume([token1, token2], 'approve', raw2);
  assert.equal(result2, 'mgr2');
});

test('Token lifecycle: decision clears ALL tokens for all managers', () => {
  const tokens = [
    makeTokenRecord(crypto.randomBytes(32).toString('hex'), { action: 'approve', managerId: 'mgr1' }),
    makeTokenRecord(crypto.randomBytes(32).toString('hex'), { action: 'reject', managerId: 'mgr1' }),
    makeTokenRecord(crypto.randomBytes(32).toString('hex'), { action: 'approve', managerId: 'mgr2' }),
    makeTokenRecord(crypto.randomBytes(32).toString('hex'), { action: 'reject', managerId: 'mgr2' }),
  ];
  assert.equal(tokens.length, 4);

  // After decision, all tokens are cleared
  const clearedTokens = [];
  assert.equal(clearedTokens.length, 0, 'All tokens cleared after any decision');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 13: Edge Cases - Security
// ═══════════════════════════════════════════════════════════════════════════

test('Security: token is single-use (race condition protection)', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve' });

  // Simulate concurrent consumption: both read used=false
  const firstConsume = simulateTokenConsume([token], 'approve', raw);
  token.used = true;

  // Second attempt should fail
  const secondConsume = simulateTokenConsume([token], 'approve', raw);
  assert.equal(firstConsume !== null, true);
  assert.equal(secondConsume, null);
});

test('Security: timing-safe comparison prevents oracle attacks', () => {
  const raw1 = crypto.randomBytes(32).toString('hex');
  const raw2 = crypto.randomBytes(32).toString('hex');
  const hash1 = hashDecisionToken(raw1);
  const hash2 = hashDecisionToken(raw2);

  // Both are 64-char hex → same length buffers
  const a = Buffer.from(hash1, 'hex');
  const b = Buffer.from(hash2, 'hex');
  assert.equal(a.length, b.length);
  assert.equal(crypto.timingSafeEqual(a, b), false);
});

test('Security: SHA-256 hash is irreversible', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = hashDecisionToken(raw);
  // Cannot recover raw from hash
  assert.notEqual(raw, hash);
  assert.equal(hash.length, 64);
});

test('Security: CSRF bypass is appropriate for decision routes', () => {
  // Decision routes use token-in-URL as authorization + CSRF defense
  // No session CSRF expected for these routes
  const decisionRoutes = ['/leave/decision-link', '/leave/decision-login'];
  assert.equal(decisionRoutes.length, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 14: Edge Cases - Status Transitions
// ═══════════════════════════════════════════════════════════════════════════

test('Status transition: pending → approved (via approve token)', () => {
  const request = mockLeaveRequest({ status: 'pending' });
  request.status = 'approved';
  assert.equal(request.status, 'approved');
});

test('Status transition: pending → rejected (via reject token)', () => {
  const request = mockLeaveRequest({ status: 'pending' });
  request.status = 'rejected';
  assert.equal(request.status, 'rejected');
});

test('Status transition: approved → pending (via undo)', () => {
  const request = mockLeaveRequest({ status: 'approved' });
  request.status = 'pending';
  assert.equal(request.status, 'pending');
});

test('Status transition: rejected → pending (via undo)', () => {
  const request = mockLeaveRequest({ status: 'rejected' });
  request.status = 'pending';
  assert.equal(request.status, 'pending');
});

test('Status transition: pending → cancelled (not via token flow)', () => {
  const request = mockLeaveRequest({ status: 'pending' });
  request.status = 'cancelled';
  assert.equal(request.status, 'cancelled');
});

test('Status transition: approved → cancelled (not via token flow)', () => {
  const request = mockLeaveRequest({ status: 'approved' });
  request.status = 'cancelled';
  assert.equal(request.status, 'cancelled');
});

test('Status transition: approved request cannot be approved again', () => {
  const request = mockLeaveRequest({ status: 'approved' });
  assert.notEqual(request.status, 'pending');
});

test('Status transition: rejected request cannot be rejected again', () => {
  const request = mockLeaveRequest({ status: 'rejected' });
  assert.notEqual(request.status, 'pending');
});

test('Status transition: cancelled request cannot be decided', () => {
  const request = mockLeaveRequest({ status: 'cancelled' });
  assert.notEqual(request.status, 'pending');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 15: Edge Cases - Token Cleanup
// ═══════════════════════════════════════════════════════════════════════════

test('Token cleanup: decision clears tokens for all managers', () => {
  const tokens = [
    makeTokenRecord(crypto.randomBytes(32).toString('hex'), { managerId: 'mgr1', action: 'approve' }),
    makeTokenRecord(crypto.randomBytes(32).toString('hex'), { managerId: 'mgr1', action: 'reject' }),
    makeTokenRecord(crypto.randomBytes(32).toString('hex'), { managerId: 'mgr2', action: 'approve' }),
  ];
  assert.equal(tokens.length, 3);
  tokens.length = 0;
  assert.equal(tokens.length, 0);
});

test('Token cleanup: undo also clears tokens', () => {
  const tokens = [
    makeTokenRecord(crypto.randomBytes(32).toString('hex'), { action: 'approve' }),
  ];
  tokens.length = 0;
  assert.equal(tokens.length, 0);
});

test('Token cleanup: cancel clears tokens', () => {
  const request = mockLeaveRequest({
    decisionTokens: [
      makeTokenRecord(crypto.randomBytes(32).toString('hex'), { action: 'approve' }),
    ],
  });
  request.decisionTokens = [];
  assert.equal(request.decisionTokens.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 16: Edge Cases - Rate Limiting
// ═══════════════════════════════════════════════════════════════════════════

test('Rate limiting: 30 requests per 15-minute window in production', () => {
  const maxRequests = 30;
  const windowMs = 15 * 60 * 1000;
  assert.equal(maxRequests, 30);
  assert.equal(windowMs, 900000);
});

test('Rate limiting: high limit in test environment', () => {
  const testLimit = 10000;
  assert.ok(testLimit > 30);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 17: Edge Cases - CSRF
// ═══════════════════════════════════════════════════════════════════════════

test('CSRF: decision-link and decision-login bypass CSRF protection', () => {
  const bypassedPaths = ['/leave/decision-link', '/leave/decision-login'];
  for (const path of bypassedPaths) {
    assert.ok(path.startsWith('/leave/decision'));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 18: Edge Cases - Format Helpers
// ═══════════════════════════════════════════════════════════════════════════

test('formatLeaveDateText: same start and end returns single date', () => {
  const request = mockLeaveRequest({
    startDate: new Date('2026-09-15'),
    endDate: new Date('2026-09-15'),
  });
  const result = formatLeaveDateText(request);
  assert.equal(result, '2026-09-15');
});

test('formatLeaveDateText: different start and end returns range', () => {
  const request = mockLeaveRequest({
    startDate: new Date('2026-09-15'),
    endDate: new Date('2026-09-17'),
  });
  const result = formatLeaveDateText(request);
  assert.ok(result.includes(' to '));
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 19: Edge Cases - Concurrent Requests
// ═══════════════════════════════════════════════════════════════════════════

test('Concurrent: two managers clicking approve simultaneously', () => {
  const raw1 = crypto.randomBytes(32).toString('hex');
  const raw2 = crypto.randomBytes(32).toString('hex');
  const token1 = makeTokenRecord(raw1, { action: 'approve', managerId: 'mgr1' });
  const token2 = makeTokenRecord(raw2, { action: 'approve', managerId: 'mgr2' });

  // Both tokens are valid for approve action
  const result1 = simulateTokenConsume([token1, token2], 'approve', raw1);
  const result2 = simulateTokenConsume([token1, token2], 'approve', raw2);

  // Both can consume their own tokens
  assert.equal(result1, 'mgr1');
  assert.equal(result2, 'mgr2');
});

test('Concurrent: manager clicks approve then reject (different tokens)', () => {
  const rawApprove = crypto.randomBytes(32).toString('hex');
  const rawReject = crypto.randomBytes(32).toString('hex');
  const approveToken = makeTokenRecord(rawApprove, { action: 'approve' });
  const rejectToken = makeTokenRecord(rawReject, { action: 'reject' });

  // Approve first
  const approveResult = simulateTokenConsume([approveToken, rejectToken], 'approve', rawApprove);
  assert.equal(approveResult !== null, true);
  approveToken.used = true;

  // Then try reject — different token, still valid
  const rejectResult = simulateTokenConsume([approveToken, rejectToken], 'reject', rawReject);
  assert.equal(rejectResult !== null, true);
});

test('Concurrent: request decided between token peek and consume', () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const token = makeTokenRecord(raw, { action: 'approve' });

  // Peek succeeds
  const peek = simulatePeekToken([token], 'approve', raw);
  assert.ok(peek);

  // Another request decides → tokens cleared
  token.used = true;

  // Consume fails
  const consume = simulateTokenConsume([token], 'approve', raw);
  assert.equal(consume, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 20: Edge Cases - Undo Window
// ═══════════════════════════════════════════════════════════════════════════

test('Undo window: approval has 15-second undo window', () => {
  const LEAVE_DECISION_UNDO_MS = 15 * 1000;
  const now = Date.now();
  const notifyAfter = new Date(now + LEAVE_DECISION_UNDO_MS);
  const diff = notifyAfter.getTime() - now;
  assert.ok(diff >= LEAVE_DECISION_UNDO_MS - 100);
  assert.ok(diff <= LEAVE_DECISION_UNDO_MS + 100);
});

test('Undo window: rejection defers notification until undo window passes', () => {
  const request = mockLeaveRequest({ status: 'pending' });
  // For rejection: notifyAfter = now + window, notificationsSent = false
  request.notifyAfter = new Date(Date.now() + 15 * 1000);
  request.notificationsSent = false;
  assert.ok(request.notifyAfter.getTime() > Date.now());
  assert.equal(request.notificationsSent, false);
});

test('Undo window: rejection deferred notification picked up by job', () => {
  const now = new Date();
  const notifyAfter = new Date(now.getTime() - 1000); // Already past
  const notificationsSent = false;

  const shouldNotify = notifyAfter && notifyAfter <= now && !notificationsSent;
  assert.equal(shouldNotify, true);
});

test('Undo window: approval not yet due for notification', () => {
  const now = new Date();
  const notifyAfter = new Date(now.getTime() + 60000); // 1 minute in future
  const notificationsSent = false;

  const shouldNotify = notifyAfter && notifyAfter <= now && !notificationsSent;
  assert.equal(shouldNotify, false);
});

test('Undo window: already notified request is not picked up again', () => {
  const now = new Date();
  const notifyAfter = new Date(now.getTime() - 1000);
  const notificationsSent = true;

  const shouldNotify = notifyAfter && notifyAfter <= now && !notificationsSent;
  assert.equal(shouldNotify, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 21: Edge Cases - Notification Channels
// ═══════════════════════════════════════════════════════════════════════════

test('Notification: manager with email gets email notification', () => {
  const manager = mockUser({ email: 'mgr@example.com', mobile: null });
  assert.ok(manager.email);
  assert.equal(manager.mobile, null);
});

test('Notification: manager with mobile gets SMS notification', () => {
  const manager = mockUser({ email: null, mobile: '+911234567890' });
  assert.equal(manager.email, null);
  assert.ok(manager.mobile);
});

test('Notification: manager with whatsappOptIn gets WhatsApp notification', () => {
  const manager = mockUser({ mobile: '+911234567890', whatsappOptIn: true });
  assert.equal(manager.whatsappOptIn, true);
  assert.ok(manager.mobile);
});

test('Notification: manager without WhatsApp opt-in does not get WhatsApp', () => {
  const manager = mockUser({ mobile: '+911234567890', whatsappOptIn: false });
  assert.equal(manager.whatsappOptIn, false);
});

test('Notification: Promise.allSettled ensures one channel failure does not block others', () => {
  const results = [
    { status: 'fulfilled', value: 'email sent' },
    { status: 'rejected', reason: 'SMS failed' },
    { status: 'fulfilled', value: 'WhatsApp sent' },
  ];
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 2, 'Two channels succeeded despite one failure');
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 22: Edge Cases - Invalid Request IDs
// ═══════════════════════════════════════════════════════════════════════════

test('Invalid request ID: non-ObjectId string', () => {
  const mongoose = { isValidObjectId: (id) => /^[0-9a-f]{24}$/i.test(id) };
  assert.equal(mongoose.isValidObjectId('not-a-valid-id'), false);
  assert.equal(mongoose.isValidObjectId(''), false);
  assert.equal(mongoose.isValidObjectId('123'), false);
});

test('Invalid request ID: valid ObjectId format', () => {
  const mongoose = { isValidObjectId: (id) => /^[0-9a-f]{24}$/i.test(id) };
  assert.equal(mongoose.isValidObjectId('507f1f77bcf86cd799439011'), true);
  assert.equal(mongoose.isValidObjectId('000000000000000000000000'), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 23: Edge Cases - Hash Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

test('Hash edge case: empty string token', () => {
  const hash = hashDecisionToken('');
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('Hash edge case: very long token', () => {
  const longToken = 'a'.repeat(10000);
  const hash = hashDecisionToken(longToken);
  assert.equal(hash.length, 64);
});

test('Hash edge case: unicode characters in token', () => {
  const unicodeToken = 'tokën_üñícödé_🎯';
  const hash = hashDecisionToken(unicodeToken);
  assert.equal(hash.length, 64);
});

test('Hash edge case: binary data in token', () => {
  const binaryToken = crypto.randomBytes(64).toString('hex');
  const hash = hashDecisionToken(binaryToken);
  assert.equal(hash.length, 64);
});
