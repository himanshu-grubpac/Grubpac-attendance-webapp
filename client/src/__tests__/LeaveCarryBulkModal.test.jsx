import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../context/ToastContext.jsx';
import LeaveCarryBulkModal from '../pages/admin/LeaveCarryBulkModal.jsx';

const onClose = vi.fn();

vi.mock('../services/api.js', () => ({
  adminApi: {
    listDepartments: vi.fn(() =>
      Promise.resolve({
        departments: [{ id: 'dept1', name: 'Engineering', isActive: true }],
      }),
    ),
    listEmployees: vi.fn(() =>
      Promise.resolve({
        employees: [{ id: 'u1', name: 'Jane Doe', employeeCode: 'EMP001' }],
        pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
      }),
    ),
  },
  leaveApi: {
    downloadCarryAuditReport: vi.fn(() => Promise.resolve(new Blob(['x']))),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

import { leaveApi } from '../services/api.js';

function setup(props = {}) {
  render(
    <ToastProvider>
      <LeaveCarryBulkModal
        open
        onClose={onClose}
        defaultYear={2026}
        yearOptions={[
          { value: '2025', label: '2025' },
          { value: '2026', label: '2026' },
        ]}
        {...props}
      />
    </ToastProvider>,
  );
}

describe('LeaveCarryBulkModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
  });

  it('closes the modal after a successful audit report download', async () => {
    const user = userEvent.setup();
    setup();

    const selectAll = await screen.findByRole('button', { name: /select all/i });
    await waitFor(() => {
      expect(selectAll).not.toBeDisabled();
    });

    await user.click(selectAll);
    await user.click(screen.getByRole('button', { name: /download audit report/i }));

    await waitFor(() => {
      expect(leaveApi.downloadCarryAuditReport).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(screen.getByText(/audit report downloaded/i)).toBeInTheDocument();
  });
});
