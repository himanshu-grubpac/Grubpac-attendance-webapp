import { describe, it, expect, vi } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import { ActionPopupProvider } from '../context/ActionPopupContext.jsx';
import AdminLeaveApprovals from '../pages/admin/AdminLeaveApprovals.jsx';

vi.mock('../services/api.js', () => ({
  adminApi: {
    listEmployees: vi.fn(() => Promise.resolve({ employees: [] })),
  },
  leaveApi: {
    // Empty queue forces the deep-link fallback (fresh landing via email link).
    listRequests: vi.fn(() => Promise.resolve({ requests: [], pagination: null })),
    getRequest: vi.fn(() =>
      Promise.resolve({
        request: {
          id: 'req1',
          userName: 'Piyush Jha',
          leaveTypeCode: 'CL',
          leaveTypeName: 'Casual Leave',
          startDate: '2026-09-10',
          endDate: '2026-09-10',
          days: 1,
          reason: 'Family function',
          status: 'pending',
        },
      }),
    ),
  },
  preferencesApi: {
    getTablePreference: vi.fn(() => Promise.reject(new Error('no saved prefs'))),
    updateTablePreference: vi.fn(() => Promise.resolve({})),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

function setup() {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/admin/leave/approvals?decision=request&requestId=req1']}>
        <ToastProvider>
          <ActionPopupProvider>
            <AdminLeaveApprovals />
          </ActionPopupProvider>
        </ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('AdminLeaveApprovals email deep link', () => {
  it('auto-opens the decision popup under StrictMode double-mount', async () => {
    // Reproduces the Take Action email flow in dev: StrictMode mounts,
    // unmounts and remounts, which used to cancel the only fetch and leave
    // the popup permanently closed.
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
