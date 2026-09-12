import { describe, it, expect } from 'vitest';
import { PERMISSIONS } from '@shared/permissions.js';
import { getVisibleNavItems } from '../config/nav.js';

const EMPLOYEE = { permissions: [PERMISSIONS.LEAVE_APPLY, PERMISSIONS.LEAVE_READ] };
const MANAGER = { permissions: [PERMISSIONS.LEAVE_APPROVE, PERMISSIONS.LEAVE_READ] };

function employeeLeaveItems() {
  return getVisibleNavItems(EMPLOYEE, 'employee').filter((item) => item.section === 'Leave');
}

describe('leave module navigation', () => {
  it('exposes Apply WFH, Apply Leave, Request comp off in order', () => {
    const items = employeeLeaveItems().filter((item) =>
      ['/employee/leave/apply-wfh', '/employee/leave/apply', '/employee/leave/comp-off'].includes(item.to),
    );
    expect(items.map((item) => item.to)).toEqual([
      '/employee/leave/apply-wfh',
      '/employee/leave/apply',
      '/employee/leave/comp-off',
    ]);
    expect(items.map((item) => item.label)).toEqual(['Apply WFH', 'Apply leave', 'Request comp off']);
  });

  it('keeps the combined Apply leave / WFH entry gone', () => {
    const items = employeeLeaveItems();
    expect(items.some((item) => item.label === 'Apply leave / WFH')).toBe(false);
  });

  it('unifies approver queues under a single Pending Requests entry', () => {
    const items = getVisibleNavItems(MANAGER, 'admin').filter((item) => item.section === 'Leaves');
    // No standalone comp-off entry — the three queues share one tab bar.
    expect(items.some((item) => item.to === '/admin/leave/comp-off')).toBe(false);
    const requests = items.find((item) => item.to === '/admin/leave/approvals');
    expect(requests).toBeDefined();
    expect(requests.label).toBe('Pending Requests');
    expect(requests.permission).toBe(PERMISSIONS.LEAVE_APPROVE);
    expect(requests.badge).toBe('approvals');
    expect(requests.matchPrefixes).toEqual(
      expect.arrayContaining(['/admin/leave/approvals', '/admin/leave/comp-off']),
    );
  });
});
