import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import ApplyLeaveForm from '../pages/employee/ApplyLeaveForm.jsx';
import { leaveApi } from '../services/api.js';

// Neutralize the advance-notice deadline (same-day defaults would otherwise
// keep Submit disabled): the unit under test is the zero-working-days guard,
// not deadline policy (covered by wfhPolicyService.test.js server-side).
// Full manual mock (no importOriginal): deterministic regardless of aliasing.
vi.mock('@shared/utils/wfhPolicy.js', () => ({
  WFH_LEAVE_TYPE_CODE: 'WFH',
  SL_LEAVE_TYPE_CODE: 'SL',
  LEAVE_APPLY_ADVANCE_ERROR: 'Advance notice required.',
  LEAVE_APPLY_DEADLINE_ERROR: 'Past cutoff.',
  isLeaveTypeExemptFromApplyDeadline: (code) => String(code ?? '').toUpperCase() === 'SL',
  validateLeaveApplyDeadline: () => null,
}));

vi.mock('../services/api.js', () => ({
  leaveApi: {
    listTypes: vi.fn(() =>
      Promise.resolve({
        // IDs must satisfy objectIdSchema or client validation fails first.
        types: [
          { id: '507f1f77bcf86cd799439011', code: 'CL', name: 'Casual Leave', isActive: true },
          { id: '507f1f77bcf86cd799439012', code: 'WFH', name: 'Work From Home', isActive: true },
        ],
      }),
    ),
    listPolicies: vi.fn(() => Promise.resolve({ policies: [] })),
    listHolidays: vi.fn(() => Promise.resolve({ holidays: [] })),
    getMyBalances: vi.fn(() => Promise.resolve({ balances: [] })),
    // Zero working days whatever the range (e.g. a Saturday-only range).
    previewDays: vi.fn(() => Promise.resolve({ days: 0, workingDays: [], sandwichApplied: false })),
    createRequest: vi.fn(),
    updateRequest: vi.fn(),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
  getFieldErrors: () => ({}),
}));

// jsdom has no layout engine: stub scrollIntoView used by dropdowns and the
// submit-error alert.
if (typeof window !== 'undefined' && !window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
}

function setup(mode) {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ApplyLeaveForm mode={mode} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function fillReasonAndSubmit(user) {
  const reason = screen.getByLabelText(/reason/i);
  await user.type(reason, 'Family function visit');
  await user.click(screen.getByRole('button', { name: /submit request/i }));
}

describe('ApplyLeaveForm submit guards (leave + WFH parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leave mode never POSTs a zero-working-day range and shows the reason', async () => {
    const user = userEvent.setup();
    setup('leave');

    await waitFor(() => {
      expect(leaveApi.listTypes).toHaveBeenCalled();
    });
    await fillReasonAndSubmit(user);

    await waitFor(() => {
      expect(screen.getByText(/no working days/i)).toBeInTheDocument();
    });
    expect(leaveApi.createRequest).not.toHaveBeenCalled();
  });

  it('wfh mode blocks zero-working-day ranges exactly like leave mode', async () => {
    const user = userEvent.setup();
    setup('wfh');

    await waitFor(() => {
      expect(leaveApi.listTypes).toHaveBeenCalled();
    });
    await fillReasonAndSubmit(user);

    await waitFor(() => {
      expect(screen.getByText(/no working days/i)).toBeInTheDocument();
    });
    expect(leaveApi.createRequest).not.toHaveBeenCalled();
  });
});
