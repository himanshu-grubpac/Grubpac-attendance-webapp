import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AdminDashboard from '../pages/admin/AdminDashboard.jsx';

let allowRoster = true;

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
        teamStatus: [
          { userId: 'u1', firstName: 'Anuj', employeeCode: 'EMP109', department: 'Development', roleName: 'SDE', status: 'checked_in' },
          { userId: 'u2', firstName: 'Kenny', employeeCode: 'EMP110', department: 'Development', roleName: 'SDE', status: 'absent' },
        ],
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
    listDepartments: vi.fn(() => Promise.resolve({ departments: [] })),
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
      hasPermission: (permission) => {
        if (permission === 'attendance.read_all') return allowRoster;
        return true;
      },
    }),
  };
});

import { adminApi } from '../services/api.js';

function setup() {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/admin/dashboard']}>
        <AdminDashboard />
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('AdminDashboard roster preview', () => {
  beforeEach(() => {
    allowRoster = true;
    vi.clearAllMocks();
  });

  it('shows the first roster rows with a view-all link for admins', async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText('Today present')).toBeInTheDocument();
    });
    expect(screen.getByText('Anuj')).toBeInTheDocument();
    expect(screen.getByText('Kenny')).toBeInTheDocument();
    expect(
      screen.getByText((_, node) => node?.textContent === 'Showing 2 of 2 team members · View all'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all' })).toHaveAttribute(
      'href',
      '/admin/attendance/today-present',
    );
    expect(adminApi.getTeamTodayStatus).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 10 }),
    );
  });

  it('searches the roster and refetches page one', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(screen.getByText('Anuj')).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/search team members/i), 'Kenny');
    await waitFor(
      () => {
        expect(adminApi.getTeamTodayStatus).toHaveBeenLastCalledWith(
          expect.objectContaining({ search: 'Kenny' }),
        );
      },
      { timeout: 3000 },
    );
  });

  it('hides the roster section without full-read permission', async () => {
    allowRoster = false;
    setup();
    await waitFor(() => {
      expect(screen.getByText('Total Active Employees')).toBeInTheDocument();
    });
    expect(screen.queryByText('Today present')).not.toBeInTheDocument();
    expect(adminApi.getTeamTodayStatus).not.toHaveBeenCalled();
  });

  it('keeps KPI cards when the roster fetch fails', async () => {
    // Reject every call: StrictMode double-mounts, so Once would let the
    // retry succeed and rows would (correctly) render.
    adminApi.getTeamTodayStatus.mockRejectedValue(new Error('roster down'));
    setup();
    await waitFor(() => {
      expect(screen.getByText('Total Active Employees')).toBeInTheDocument();
    });
    expect(await screen.findByText('roster down')).toBeInTheDocument();
    expect(screen.queryByText('Anuj')).not.toBeInTheDocument();
  });
});
