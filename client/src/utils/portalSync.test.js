// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  PORTAL_SYNC_EVENT,
  PORTAL_TOPICS,
  broadcastAttendancePayrollSync,
  broadcastPortalSync,
  broadcastPermissionsSync,
  broadcastPortalSyncTopics,
  shouldHandlePortalSync,
  topicMatchesSubscription,
} from './portalSync.js';

describe('broadcastPortalSync', () => {
  it('dispatches the portal event with topic and derived month', () => {
    const listener = vi.fn();
    window.addEventListener(PORTAL_SYNC_EVENT, listener);
    try {
      broadcastPortalSync({
        topic: PORTAL_TOPICS.ATTENDANCE,
        userId: 'u1',
        dayKey: '2026-03-15',
      });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].detail).toEqual({
        topic: PORTAL_TOPICS.ATTENDANCE,
        userId: 'u1',
        dayKey: '2026-03-15',
        month: '2026-03',
        at: expect.any(Number),
      });
    } finally {
      window.removeEventListener(PORTAL_SYNC_EVENT, listener);
    }
  });

  it('still dispatches when localStorage is unavailable', () => {
    const listener = vi.fn();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error('denied');
    });
    window.addEventListener(PORTAL_SYNC_EVENT, listener);
    try {
      expect(() =>
        broadcastPortalSync({ topic: PORTAL_TOPICS.LEAVE, userId: 'u2', dayKey: '2026-04-01' }),
      ).not.toThrow();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(PORTAL_SYNC_EVENT, listener);
      Storage.prototype.setItem = original;
    }
  });

  it('broadcasts attendance + payroll via helper', () => {
    const listener = vi.fn();
    window.addEventListener(PORTAL_SYNC_EVENT, listener);
    try {
      broadcastAttendancePayrollSync({ userId: 'u3', dayKey: '2026-05-10' });
      expect(listener).toHaveBeenCalledTimes(2);
      const topics = listener.mock.calls.map((call) => call[0].detail.topic);
      expect(topics).toEqual([PORTAL_TOPICS.ATTENDANCE, PORTAL_TOPICS.PAYROLL]);
    } finally {
      window.removeEventListener(PORTAL_SYNC_EVENT, listener);
    }
  });

  it('ignores payloads without topic', () => {
    const listener = vi.fn();
    window.addEventListener(PORTAL_SYNC_EVENT, listener);
    try {
      broadcastPortalSync({});
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(PORTAL_SYNC_EVENT, listener);
    }
  });
});

describe('broadcastPermissionsSync', () => {
  it('dispatches permissions topic for role save listeners', () => {
    const listener = vi.fn();
    window.addEventListener(PORTAL_SYNC_EVENT, listener);
    try {
      broadcastPermissionsSync();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].detail.topic).toBe(PORTAL_TOPICS.PERMISSIONS);
    } finally {
      window.removeEventListener(PORTAL_SYNC_EVENT, listener);
    }
  });

});

describe('topicMatchesSubscription', () => {
  it('matches payroll alias to attendance, leave, salary, holiday', () => {
    expect(topicMatchesSubscription(PORTAL_TOPICS.ATTENDANCE, [PORTAL_TOPICS.PAYROLL])).toBe(true);
    expect(topicMatchesSubscription(PORTAL_TOPICS.LEAVE, [PORTAL_TOPICS.PAYROLL])).toBe(true);
    expect(topicMatchesSubscription(PORTAL_TOPICS.SALARY, [PORTAL_TOPICS.PAYROLL])).toBe(true);
    expect(topicMatchesSubscription(PORTAL_TOPICS.HOLIDAY, [PORTAL_TOPICS.PAYROLL])).toBe(true);
    expect(topicMatchesSubscription(PORTAL_TOPICS.POLICY, [PORTAL_TOPICS.PAYROLL])).toBe(true);
    expect(topicMatchesSubscription(PORTAL_TOPICS.EMPLOYEE, [PORTAL_TOPICS.PAYROLL])).toBe(false);
  });

  it('matches explicit subscribed topics', () => {
    expect(topicMatchesSubscription(PORTAL_TOPICS.HELP, [PORTAL_TOPICS.HELP])).toBe(true);
    expect(topicMatchesSubscription(PORTAL_TOPICS.HELP, [PORTAL_TOPICS.LEAVE])).toBe(false);
  });
});

describe('shouldHandlePortalSync', () => {
  const attendanceDetail = {
    topic: PORTAL_TOPICS.ATTENDANCE,
    userId: 'u1',
    dayKey: '2026-03-15',
    month: '2026-03',
  };

  it('filters by payroll alias, userId, and month', () => {
    expect(
      shouldHandlePortalSync(attendanceDetail, {
        topics: [PORTAL_TOPICS.PAYROLL],
        userId: 'u1',
        month: '2026-03',
      }),
    ).toBe(true);
    expect(
      shouldHandlePortalSync(attendanceDetail, {
        topics: [PORTAL_TOPICS.PAYROLL],
        userId: 'u2',
        month: '2026-03',
      }),
    ).toBe(false);
    expect(
      shouldHandlePortalSync(attendanceDetail, {
        topics: [PORTAL_TOPICS.PAYROLL],
        userId: 'u1',
        month: '2026-04',
      }),
    ).toBe(false);
  });

  it('broadcastPortalSyncTopics emits one event per topic', () => {
    const listener = vi.fn();
    window.addEventListener(PORTAL_SYNC_EVENT, listener);
    try {
      broadcastPortalSyncTopics([PORTAL_TOPICS.POLICY, PORTAL_TOPICS.PAYROLL], {});
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(PORTAL_SYNC_EVENT, listener);
    }
  });
});
