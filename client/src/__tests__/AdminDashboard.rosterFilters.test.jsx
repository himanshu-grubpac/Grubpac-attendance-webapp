import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AdminDashboard from '../pages/admin/AdminDashboard.jsx';

const ROWS = [
  { userId: 'u1', firstName: 'Anuj', employeeCode: 'EMP109', department: 'Development', roleName: 'SDE', status: 'checked_in' },
  { userId: 'u2', firstName: 'Kenny', employeeCode: 'EMP110', department: 'Design', roleName: 'Lead', status: 'absent' },
];

vi.mock('../services/api.js', () => ({
  adminApi: {
    getReportsSummary: vi.fn(() =>
      Promise.resolve({
        summary: {
          pendingLeaveRequests: 1,
          openHelpTickets: 0,
          activeEmployees: 2,
          presentToday: 1,
          absentToday: 1,
        },
      }),
    ),
    getTeamTodayStatus: vi.fn(() =>
      Promise.resolve({
        teamStatus: ROWS,
        pagination: { page: 1, limit: 10, total: 2, totalPages: 1 },
      }),
    ),
    getEmployeeStats: vi.fn(() =>
      Promise.resolve({
        stats: {
          total: 2,
          active: 2,
          inactive: 0,
          newThisMonth: 0,
          monthKey: '2026-09',
          oldestJoiningYear: 2024,
          roleBreakdown: [],
        },
      }),
    ),
    listDepartments: vi.fn(() =>
      Promise.resolve({
        departments: [{ id: 'd1', name: 'Development', isActive: true }],
      }),
    ),
    listRoles: vi.fn(() =>
      Promise.resolve({ roles: [{ id: 'r1', name: 'SDE' }] }),
    ),
  },
  leaveApi: {
    getApprovalsPendingCounts: vi.fn(() =>
      Promise.resolve({ counts: { leave: 1, wfh: 0, compOff: 0, compOffAssessment: 0, total: 1 } }),
    ),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

vi.mock('../context/AuthContext.jsx', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useAuth: () => ({
      // Admin viewer: company-wide scope plus record reads + admin role slug
      // (the scope helper checks the actor's role, not just slugs).
      user: { roleSlug: 'admin' },
      permissions: ['employees.record.r', 'attendance.record.r'],
      hasPermission: () => true,
      hasAnyPermission: () => true,
    }),
  };
});

import { adminApi } from '../services/api.js';

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function setup() {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={['/admin/dashboard']}>
        <AdminDashboard />
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('AdminDashboard roster directory filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows department and role dropdowns beside search in one toolbar', async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText('Anuj')).toBeInTheDocument();
    });
    const toolbar = screen.getByLabelText('Search team members').closest('.today-present-toolbar__row');
    expect(toolbar).not.toBeNull();
    expect(toolbar.querySelector('[aria-label="Filter by department"]')).not.toBeNull();
    expect(toolbar.querySelector('[aria-label="Filter by role"]')).not.toBeNull();
  });

  it('keeps current rows on screen while a keystroke search is in flight (no skeleton flash)', async () => {
    const user = userEvent.setup();
    const { container } = setup();
    await waitFor(() => {
      expect(screen.getByText('Anuj')).toBeInTheDocument();
    });

    // Stall the next fetch: the debounced keystroke search must not swap
    // the table for a skeleton while it is pending (Employee List parity).
    let resolvePending;
    adminApi.getTeamTodayStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
    );
    await user.type(screen.getByLabelText(/search team members/i), 'x');
    // Past the 350ms debounce: the quiet refetch has fired but not landed.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.getByText('Anuj')).toBeInTheDocument();
    expect(container.querySelector('.employees-table-skeleton')).toBeNull();

    resolvePending({
      teamStatus: ROWS,
      pagination: { page: 1, limit: 10, total: 2, totalPages: 1 },
    });
    await waitFor(() => {
      expect(screen.getByText('Kenny')).toBeInTheDocument();
    });
  });

  it('refetches page one with departmentId and roleId when filters change', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(screen.getByText('Anuj')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('combobox', { name: 'Filter by department' }));
    await user.click(await screen.findByRole('option', { name: 'Development' }));
    await waitFor(() => {
      expect(adminApi.getTeamTodayStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ departmentId: 'd1', page: 1 }),
      );
    });

    await user.click(screen.getByRole('combobox', { name: 'Filter by role' }));
    await user.click(await screen.findByRole('option', { name: 'SDE' }));
    await waitFor(() => {
      expect(adminApi.getTeamTodayStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ departmentId: 'd1', roleId: 'r1', page: 1 }),
      );
    });
  });
});
