import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import EmployeeApplyLeave from '../pages/employee/EmployeeApplyLeave.jsx';
import { leaveApi } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  leaveApi: {
    listTypes: vi.fn(() =>
      Promise.resolve({
        types: [{ id: 'cl', code: 'CL', name: 'Casual Leave', isActive: true }],
      }),
    ),
    listPolicies: vi.fn(() => Promise.resolve({ policies: [] })),
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

function setup() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <EmployeeApplyLeave />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('EmployeeApplyLeave submit guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never POSTs a zero-working-day range and shows the reason visibly', async () => {
    const user = userEvent.setup();
    setup();

    await waitFor(() => {
      expect(leaveApi.listTypes).toHaveBeenCalled();
    });

    const reason = screen.getByLabelText(/reason/i);
    await user.type(reason, 'Family function visit');

    const submit = screen.getByRole('button', { name: /submit request/i });
    await user.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/no working days/i)).toBeInTheDocument();
    });
    expect(leaveApi.createRequest).not.toHaveBeenCalled();
  });
});
