import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminDashboard from '../pages/admin/AdminDashboard.jsx';

vi.mock('../services/api.js', () => ({
  adminApi: {
    getReportsSummary: vi.fn(() =>
      Promise.resolve({
        summary: {
          // Deliberately inconsistent with the counts below (no comp-off,
          // no year filter server-side): the card must prefer counts.total.
          pendingLeaveRequests: 7,
          openHelpTickets: 0,
          activeEmployees: 1,
          presentToday: 0,
          absentToday: 1,
        },
      }),
    ),
    getTeamTodayStatus: vi.fn(() =>
      Promise.resolve({
        teamStatus: [],
        pagination: { page: 1, limit: 10, total: 0, totalPages: 1 },
      }),
    ),
    getEmployeeStats: vi.fn(() =>
      Promise.resolve({
        stats: {
          total: 10,
          active: 9,
          inactive: 1,
          newThisMonth: 2,
          monthKey: '2026-09',
          oldestJoiningYear: 2021,
          roleBreakdown: [
            { roleId: 'aaaabbbbccccddddeeeeffff', slug: 'reporting-manager', name: 'RM', count: 3 },
            { roleId: 'aaaabbbbccccddddeeee0000', slug: 'admin', name: 'Admin', count: 1 },
          ],
        },
      }),
    ),
    listDepartments: vi.fn(() =>
      Promise.resolve({
        departments: [
          { id: 'd1', name: 'Development', isActive: true },
          { id: 'd2', name: 'Design', isActive: false },
        ],
      }),
    ),
  },
  leaveApi: {
    getApprovalsPendingCounts: vi.fn(() =>
      Promise.resolve({
        counts: { leave: 6, wfh: 0, compOff: 2, compOffAssessment: 0, total: 8 },
      }),
    ),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

vi.mock('../context/AuthContext.jsx', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useAuth: () => ({
      hasPermission: () => true,
    }),
  };
});

function setup() {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/admin/dashboard']}>
        <AdminDashboard />
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('AdminDashboard pending total', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links the Active Employees card with a forced active status preset', async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText('Total Active Employees')).toBeInTheDocument();
    });
    const card = screen.getByText('Total Active Employees').closest('a');
    expect(card.getAttribute('href')).toBe('/admin/users?status=true');
  });

  it('does not show the removed workforce cards', async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText('Total Active Employees')).toBeInTheDocument();
    });
    expect(screen.queryByText('Reporting Managers')).not.toBeInTheDocument();
    expect(screen.queryByText('Admins')).not.toBeInTheDocument();
    expect(screen.queryByText('Departments')).not.toBeInTheDocument();
  });

  it('shows the counts total so it always equals its own breakdown', async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText('6 leave · 2 comp off')).toBeInTheDocument();
    });
    // 6 + 2 = 8, not the stale reports-summary value of 7.
    const card = screen.getByText('6 leave · 2 comp off').closest('a');
    expect(card.textContent).toMatch(/8/);
    expect(card.textContent).not.toMatch(/[^0-9]7[^0-9]/);
  });
});
