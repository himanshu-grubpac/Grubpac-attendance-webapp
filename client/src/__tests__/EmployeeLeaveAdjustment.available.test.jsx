import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import EmployeeLeaveAdjustment from '../pages/admin/EmployeeLeaveAdjustment.jsx';

const CL_ID = '507f1f77bcf86cd799439011';

vi.mock('../services/api.js', () => ({
  adminApi: {
    listDepartments: vi.fn(() => Promise.resolve({ departments: [] })),
  },
  leaveApi: {
    getAdjustmentGrid: vi.fn(() =>
      Promise.resolve({
        rows: [
          {
            id: 'user1',
            name: 'Anuj Jha',
            employeeCode: 'EMP109',
            departmentName: 'Development',
            carriedByLeaveType: {
              [CL_ID]: {
                leaveTypeId: CL_ID,
                leaveTypeCode: 'CL',
                carried: -7,
                entitled: 7,
                used: 2,
                pending: 0,
                compOffEarned: 0,
                encashed: 0,
                available: -2,
              },
            },
          },
        ],
        leaveTypes: [{ id: CL_ID, code: 'CL', name: 'Casual Leave' }],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      }),
    ),
    batchAdjustCarried: vi.fn(() => Promise.resolve({ summary: { success: 1, error: 0, total: 1 }, results: [] })),
    getAdjustmentHistory: vi.fn((userId, params) =>
      Promise.resolve({
        user: {
          id: 'user1',
          name: 'Anuj Jha',
          employeeCode: 'EMP109',
          joiningDate: '2026-08-27T00:00:00.000Z',
          contractStartDate: '2026-08-27T00:00:00.000Z',
        },
        years: [
          {
            year: params?.year ?? 2026,
            balances: [
              {
                leaveTypeId: CL_ID,
                leaveTypeCode: 'CL',
                leaveTypeName: 'Casual Leave',
                hasRecord: true,
                entitled: 7,
                carried: -7,
                used: 2,
                pending: 0,
                compOffEarned: 0,
                encashed: 0,
                available: -2,
              },
              {
                leaveTypeId: '507f1f77bcf86cd799439099',
                leaveTypeCode: 'XX',
                leaveTypeName: 'No Policy Type',
                hasRecord: false,
                entitled: 0,
                carried: 0,
                used: 0,
                pending: 0,
                compOffEarned: 0,
                encashed: 0,
                available: 0,
              },
            ],
          },
        ],
      }),
    ),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

import { leaveApi } from '../services/api.js';

// jsdom has no layout engine — the custom dropdown's highlight scroll needs a stub.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function setup() {
  render(
    <StrictMode>
      <MemoryRouter>
        <ToastProvider>
          <EmployeeLeaveAdjustment policyYear="2026" onOpenAuditReport={() => {}} />
        </ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('EmployeeLeaveAdjustment available balances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the live available stock under each carried value', async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText('Anuj Jha')).toBeInTheDocument();
    });
    // Carried value stays as-is; available sub-line reflects live stock.
    expect(screen.getByText('-7')).toBeInTheDocument();
    expect(screen.getByText('Avl -2')).toBeInTheDocument();
  });

  it('opens the per-employee history drawer from the History button', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(screen.getByText('Anuj Jha')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'History' }));
    await waitFor(() => {
      expect(leaveApi.getAdjustmentHistory).toHaveBeenCalledWith('user1', { year: 2026 });
    });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Leave history/)).toBeInTheDocument();
    expect(within(dialog).getByText('Balance year 2026')).toBeInTheDocument();
  });

  it('shows em dashes for types without a balance record', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(screen.getByText('Anuj Jha')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'History' }));
    const dialog = await screen.findByRole('dialog');
    // Only the selected year renders.
    expect(within(dialog).getByText('Balance year 2026')).toBeInTheDocument();
    expect(within(dialog).queryByText('Balance year 2025')).not.toBeInTheDocument();
    // CL has a record: real values render. XX has none: dashes, never zeros.
    expect(within(dialog).getAllByText('-2').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('XX — No Policy Type')).toBeInTheDocument();
  });

  it('refetches history for the chosen balance year', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(screen.getByText('Anuj Jha')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'History' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: /balance history end year/i }));
    await user.click(await screen.findByRole('option', { name: '2025' }));
    await waitFor(() => {
      expect(leaveApi.getAdjustmentHistory).toHaveBeenLastCalledWith('user1', { year: 2025 });
    });
  });
});
