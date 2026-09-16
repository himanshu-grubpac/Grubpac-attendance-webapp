import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import { ActionPopupProvider } from '../context/ActionPopupContext.jsx';
import AdminCompOffRequests from '../pages/admin/AdminCompOffRequests.jsx';

function approvedRow(id, name) {
  return {
    id,
    userId: `user-${id}`,
    userName: name,
    userEmail: `${id}@test.example`,
    leaveTypeCode: 'CO',
    leaveTypeName: 'Compensatory Off',
    startDate: '2026-09-19',
    endDate: '2026-09-20',
    days: 2,
    reason: 'Release cover',
    status: 'approved',
    pendingAction: null,
    createdAt: '2026-09-10T10:00:00.000Z',
  };
}

vi.mock('../services/api.js', () => ({
  compOffApi: {
    list: vi.fn(() =>
      Promise.resolve({
        requests: [approvedRow('co1', 'Anuj Jha')],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      }),
    ),
    cancelApproved: vi.fn(() =>
      Promise.resolve({
        request: {
          ...approvedRow('co1', 'Anuj Jha'),
          pendingAction: 'cancelled',
          decisionUndoExpiresAt: new Date(Date.now() + 15000).toISOString(),
        },
      }),
    ),
    undo: vi.fn(() => Promise.resolve({ request: approvedRow('co1', 'Anuj Jha') })),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

import { compOffApi } from '../services/api.js';

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function setup() {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/admin/leave/comp-off?queue=approved']}>
        <ToastProvider>
          <ActionPopupProvider>
            <AdminCompOffRequests />
          </ActionPopupProvider>
        </ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('AdminCompOffRequests approved cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers Cancel on approved rows and submits with a remark', async () => {
    const user = userEvent.setup();
    setup();

    await waitFor(() => {
      expect(screen.getAllByText('Anuj Jha').length).toBeGreaterThan(0);
    });

    // Mobile card + desktop row both render: one Cancel per layout.
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    expect(cancelButtons.length).toBeGreaterThan(0);
    await user.click(cancelButtons[0]);

    // The cancel dialog requires a remark before submitting (in cancel mode
    // the submit button carries btn-danger, not btn-primary).
    const dialog = await screen.findByRole('alertdialog');
    const remark = dialog.querySelector('textarea');
    await user.type(remark, 'Cover no longer needed');
    await user.click(dialog.querySelector('button.btn-danger'));

    await waitFor(() => {
      expect(compOffApi.cancelApproved).toHaveBeenCalledWith('co1', {
        comment: 'Cover no longer needed',
      });
    });
  });

  it('renders the same filter dropdowns as the Leave tab and filters by employee', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(screen.getAllByText('Anuj Jha').length).toBeGreaterThan(0);
    });

    expect(screen.getByRole('combobox', { name: /comp off queue filter/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /leave year filter/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /leave month filter/i })).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /employee filter/i }));
    await user.click(await screen.findByRole('option', { name: 'Anuj Jha' }));
    await waitFor(() => {
      expect(compOffApi.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: 'user-co1' }),
      );
    });
  });
});
