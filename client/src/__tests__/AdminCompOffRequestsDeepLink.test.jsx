import { describe, it, expect, vi } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import { ActionPopupProvider } from '../context/ActionPopupContext.jsx';
import AdminCompOffRequests from '../pages/admin/AdminCompOffRequests.jsx';

vi.mock('../services/api.js', () => ({
  compOffApi: {
    // Empty queue forces the deep-link fallback (fresh landing via email link).
    list: vi.fn(() => Promise.resolve({ requests: [], pagination: null })),
    get: vi.fn(() =>
      Promise.resolve({
        request: {
          id: 'co1',
          userName: 'Piyush Jha',
          leaveTypeCode: 'CO',
          leaveTypeName: 'Compensatory Off',
          startDate: '2026-09-12',
          endDate: '2026-09-13',
          days: 2,
          reason: 'Release cover',
          status: 'pending',
        },
      }),
    ),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

function setup() {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/admin/leave/comp-off?decision=request&requestId=co1']}>
        <ToastProvider>
          <ActionPopupProvider>
            <AdminCompOffRequests />
          </ActionPopupProvider>
        </ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('AdminCompOffRequests email deep link', () => {
  it('auto-opens the decision popup under StrictMode double-mount', async () => {
    // Same guarantee as the leave approvals page: the Take Action email link
    // must pop the decision modal on its own, even with dev double-mount.
    setup();
    await waitFor(
      () => {
        expect(screen.getByText('Leave request decision')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(screen.getByText(/Piyush Jha/)).toBeInTheDocument();
  });
});
