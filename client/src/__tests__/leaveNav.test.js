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

  it('shows Comp off requests to approvers under admin Leaves', () => {
    const items = getVisibleNavItems(MANAGER, 'admin').filter((item) => item.section === 'Leaves');
    const compOff = items.find((item) => item.to === '/admin/leave/comp-off');
    expect(compOff).toBeDefined();
    expect(compOff.label).toBe('Comp off requests');
    expect(compOff.permission).toBe(PERMISSIONS.LEAVE_APPROVE);
  });
});
