import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConflictsForLog } from './deviceConflictService.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

function makeLog(overrides) {
  return {
    _id: overrides.id ?? 'log-1',
    action: 'login_success',
    userId: 'user-a',
    email: 'a@company.com',
    ip: '203.0.113.10',
    deviceId: 'device-shared',
    timestamp: new Date('2026-07-27T10:00:00.000Z'),
    metadata: null,
    ...overrides,
  };
}

test('resolveConflictsForLog flags same device used by different users', () => {
  const log = makeLog({ _id: 'log-a' });
  const other = makeLog({
    _id: 'log-b',
    userId: 'user-b',
    email: 'b@company.com',
    ip: '203.0.113.99',
    timestamp: new Date('2026-07-27T11:00:00.000Z'),
  });

  const result = resolveConflictsForLog(log, [log, other], WINDOW_MS);
  assert.equal(result.ipConflict, true);
  assert.equal(result.conflictWithUsers.length, 1);
  assert.equal(result.conflictWithUsers[0].email, 'b@company.com');
  assert.deepEqual(result.conflictWithUsers[0].reasons, ['device']);
});

test('resolveConflictsForLog flags same public IP used by different users', () => {
  const log = makeLog({ _id: 'log-a', deviceId: 'device-a' });
  const other = makeLog({
    _id: 'log-b',
    userId: 'user-b',
    email: 'b@company.com',
    deviceId: 'device-b',
    timestamp: new Date('2026-07-27T11:00:00.000Z'),
  });

  const result = resolveConflictsForLog(log, [log, other], WINDOW_MS);
  assert.equal(result.ipConflict, true);
  assert.deepEqual(result.conflictWithUsers[0].reasons, ['ip']);
});

test('resolveConflictsForLog ignores events outside the conflict window', () => {
  const log = makeLog({ _id: 'log-a' });
  const other = makeLog({
    _id: 'log-b',
    userId: 'user-b',
    email: 'b@company.com',
    timestamp: new Date('2026-07-25T10:00:00.000Z'),
  });

  const result = resolveConflictsForLog(log, [log, other], WINDOW_MS);
  assert.equal(result.ipConflict, false);
  assert.equal(result.conflictWithUsers.length, 0);
});

test('resolveConflictsForLog ignores same-user repeat logins', () => {
  const log = makeLog({ _id: 'log-a' });
  const other = makeLog({
    _id: 'log-b',
    timestamp: new Date('2026-07-27T11:00:00.000Z'),
  });

  const result = resolveConflictsForLog(log, [log, other], WINDOW_MS);
  assert.equal(result.ipConflict, false);
});

test('resolveConflictsForLog includes check-in events in candidate set', () => {
  const log = makeLog({ _id: 'log-a' });
  const checkIn = {
    _id: 'log-checkin',
    action: 'attendance_marked',
    userId: 'user-b',
    email: 'b@company.com',
    ip: '203.0.113.10',
    deviceId: 'device-shared',
    timestamp: new Date('2026-07-27T10:30:00.000Z'),
    metadata: { type: 'check_in' },
  };

  const result = resolveConflictsForLog(log, [log, checkIn], WINDOW_MS);
  assert.equal(result.ipConflict, true);
  assert.equal(result.conflictWithUsers[0].email, 'b@company.com');
});
