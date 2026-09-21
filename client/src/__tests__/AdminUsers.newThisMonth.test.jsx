import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PERMISSIONS } from '@shared/permissions.js';
import AdminUsers from '../pages/admin/AdminUsers.jsx';
import { AuthProvider } from '../context/AuthContext.jsx';
import { ToastProvider } from '../context/ToastContext.jsx';

const FILTER_STORAGE_KEY = 'grubpac.adminUsers.filters.v1';

const ROWS = [
  { id: 'e1', name: 'Aarav Kapoor', email: 'aarav@test.example', mobile: '971019678', isActive: false, joiningDate: '2026-08-12' },
  { id: 'e2', name: 'Ankit Joshi', email: 'ankit@test.example', mobile: '8499868522', isActive: false, joiningDate: '2022-05-11' },
  { id: 'e3', name: 'Kajal Shetty', email: 'kajal@test.example', mobile: '913651262', isActive: false, joiningDate: '2025-04-15' },
  { id: 'e4', name: 'Kirti Jain', email: 'kirti@test.example', mobile: '996991351', isActive: false, joiningDate: '2026-03-17' },
];

vi.mock('../services/api.js', () => ({
  adminApi: {
    listEmployees: vi.fn(() =>
      Promise.resolve({
        employees: ROWS,
        pagination: { page: 1, limit: 10, total: ROWS.length, totalPages: 1 },
      }),
    ),
    getEmployeeStats: vi.fn(() =>
      Promise.resolve({
        stats: {
          total: 153,
          active: 148,
          inactive: 5,
          newThisMonth: 116,
          monthKey: '2026-09',
        },
      }),
    ),
    listDepartments: vi.fn(() => Promise.resolve({ departments: [] })),
    listRoles: vi.fn(() => Promise.resolve({ roles: [] })),
    listManagers: vi.fn(() => Promise.resolve({ managers: [] })),
    updateEmployeeStatus: vi.fn(() => Promise.resolve({})),
  },
  preferencesApi: {
    getAvailableColumns: vi.fn(() => Promise.resolve(null)),
    getTablePreference: vi.fn(() => Promise.resolve({ data: { saved: false } })),
    updateTablePreference: vi.fn(() => Promise.resolve({})),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
  default: {
    get: vi.fn((url) =>
      url.includes('/auth/me')
        ? Promise.resolve({
            data: {
              user: {
                _id: 'admin1',
                name: 'Test Admin',
                email: 'admin@test.example',
                role: 'admin',
                permissions: Object.values(PERMISSIONS),
              },
            },
          })
        : Promise.resolve({ data: {} }),
    ),
    post: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

import { adminApi } from '../services/api.js';

if (typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof window.IntersectionObserver === 'undefined') {
  window.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

function setup() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <AuthProvider>
          <AdminUsers />
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('AdminUsers new-this-month filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('combines the month filter with status and says so in the notice', async () => {
    sessionStorage.setItem(
      FILTER_STORAGE_KEY,
      JSON.stringify({ statusFilter: 'false', newThisMonthFilter: true }),
    );
    setup();

    await screen.findByRole('table');

    // Registration-based predicate (createdAt), sent alongside the status.
    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.objectContaining({ createdAfter: '2026-09-01', isActive: 'false' }),
      );
    });

    // Stat counts registrations; the notice reconciles it with the table.
    expect(screen.getByText('116')).toBeInTheDocument();
    expect(screen.getByText('Registered since Sept 1st')).toBeInTheDocument();
    expect(
      screen.getByText('Showing 4 of 116 employees registered since sept 1st — other filters applied.'),
    ).toBeInTheDocument();
  });

  it('combines the month filter with the default Active status', async () => {
    sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ newThisMonthFilter: true }));
    setup();

    await screen.findByRole('table');

    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.objectContaining({ createdAfter: '2026-09-01', isActive: 'true' }),
      );
    });
    // Default Active is not an "other" filter, so the plain notice shows.
    expect(
      screen.getByText('Showing employees registered since sept 1st.'),
    ).toBeInTheDocument();
  });
});
