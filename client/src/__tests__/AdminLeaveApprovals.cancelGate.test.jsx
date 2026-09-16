import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import { ActionPopupProvider } from '../context/ActionPopupContext.jsx';
import AdminLeaveApprovals from '../pages/admin/AdminLeaveApprovals.jsx';

function approvedRow(id, name, endDate) {
  return {
    id,
    userId: `user-${id}`,
    userName: name,
    leaveTypeCode: 'CL',
    leaveTypeName: 'Casual Leave',
    startDate: endDate,
    endDate,
    days: 1,
    reason: 'Test leave',
    status: 'approved',
    pendingDecision: null,
  };
}

vi.mock('../services/api.js', () => ({
  adminApi: {},
  leaveApi: {
    listRequests: vi.fn(() =>
      Promise.resolve({
        // Far-past vs far-future end dates: robust regardless of today.
        requests: [
          approvedRow('past1', 'Past Person', '2020-01-10'),
          approvedRow('future1', 'Future Person', '2099-01-10'),
        ],
        pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
      }),
    ),
    getRequest: vi.fn(() => Promise.reject(new Error('not found'))),
    approveRequest: vi.fn(() => Promise.resolve({})),
    rejectRequest: vi.fn(() => Promise.resolve({})),
    cancelApproved: vi.fn(() => Promise.resolve({})),
    undoDecision: vi.fn(() => Promise.resolve({})),
    undoCancellation: vi.fn(() => Promise.resolve({})),
  },
  preferencesApi: {
    getTablePreference: vi.fn(() => Promise.reject(new Error('no saved prefs'))),
    updateTablePreference: vi.fn(() => Promise.resolve({})),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function setup() {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/admin/leave/approvals']}>
        <ToastProvider>
          <ActionPopupProvider>
            <AdminLeaveApprovals />
          </ActionPopupProvider>
        </ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('AdminLeaveApprovals cancel gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers Cancel for every approved leave, including past ones', async () => {
    const user = userEvent.setup();
    setup();

    // Switch the queue to Approved.
    await user.click(screen.getByRole('combobox', { name: /leave queue filter/i }));
    await user.click(await screen.findByRole('option', { name: 'Approved' }));

    await waitFor(() => {
      expect(screen.getAllByText('Future Person').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Past Person').length).toBeGreaterThan(0);

    // Mobile card + desktop row both render in the DOM: two Cancel buttons
    // per employee row — one for each leave, past included.
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    expect(cancelButtons).toHaveLength(4);
  });

  it('warns about settled payroll when cancelling a past leave', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('combobox', { name: /leave queue filter/i }));
    await user.click(await screen.findByRole('option', { name: 'Approved' }));

    await waitFor(() => {
      expect(screen.getAllByText('Past Person').length).toBeGreaterThan(0);
    });

    // Open the cancel dialog from one of the past leave's Cancel buttons.
    const pastCancel = screen
      .getAllByRole('button', { name: 'Cancel' })
      .find((button) => button.closest('tr')?.textContent?.includes('Past Person'));
    expect(pastCancel).toBeTruthy();
    await user.click(pastCancel);

    expect(await screen.findByText('Cancel approved leave')).toBeInTheDocument();
    expect(screen.getByText(/payroll for settled months is not adjusted automatically/)).toBeInTheDocument();
  });
});
