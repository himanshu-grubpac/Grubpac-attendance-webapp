import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import AdminLeavePolicies from '../pages/admin/AdminLeavePolicies.jsx';
import { getISTYear } from '../utils/datetime.js';

vi.mock('../services/api.js', () => ({
  leaveApi: {
    listPolicies: vi.fn(() => Promise.resolve({ policies: [] })),
    listTypes: vi.fn(() =>
      Promise.resolve({
        types: [{ id: 't1', code: 'CL', name: 'Casual Leave', description: 'Casual', isActive: true }],
      }),
    ),
    getAdjustmentGrid: vi.fn(() =>
      Promise.resolve({ rows: [], leaveTypes: [], pagination: null, policyFallback: null }),
    ),
  },
  adminApi: {
    listDepartments: vi.fn(() => Promise.resolve({ departments: [] })),
    getEmployeeStats: vi.fn(() =>
      Promise.resolve({ stats: { oldestJoiningYear: 2021 } }),
    ),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

function setup() {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/admin/leave/policies']}>
        <ToastProvider>
          <AdminLeavePolicies />
        </ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('AdminLeavePolicies tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('defaults to Leave types with the other sections hidden', async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText('CL')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Policy year')).toBeNull();
  });

  it('policy year dropdown excludes future years', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(screen.getByText('CL')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Policies' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Policy year')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Policy year'));
    const currentYear = String(getISTYear());
    expect(screen.getByRole('option', { name: currentYear })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: String(getISTYear() + 1) })).not.toBeInTheDocument();
  });

  it('switches between Types, Policies and Adjustments sections', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(screen.getByText('CL')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Policies' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Policy year')).toBeInTheDocument();
    });
    expect(screen.queryByText('CL')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Adjustments' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('Policy year')).toBeNull();
    });
  });
});
