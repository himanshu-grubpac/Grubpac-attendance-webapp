import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PERMISSIONS } from '@shared/permissions.js';
import AdminUsers from '../pages/admin/AdminUsers.jsx';
import { AuthProvider } from '../context/AuthContext.jsx';
import { ToastProvider } from '../context/ToastContext.jsx';

const FILTER_STORAGE_KEY = 'grubpac.adminUsers.filters.v1';

const ROWS = [
  { id: 'e1', name: 'Aarav Kapoor', email: 'aarav@test.example', mobile: '971019678', isActive: true, joiningDate: '2026-09-05' },
  { id: 'e2', name: 'Ankit Joshi', email: 'ankit@test.example', mobile: '8499868522', isActive: true, joiningDate: '2022-05-11' },
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

function setup(entries) {
  render(
    <MemoryRouter initialEntries={entries}>
      <ToastProvider>
        <AuthProvider>
          <AdminUsers />
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('AdminUsers joining-date filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('sends the persisted joining range on first load', async () => {
    sessionStorage.setItem(
      FILTER_STORAGE_KEY,
      JSON.stringify({ joiningFrom: '2026-09-01', joiningTo: '2026-09-30' }),
    );
    setup();

    await screen.findByRole('table');

    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.objectContaining({ joiningFrom: '2026-09-01', joiningTo: '2026-09-30' }),
      );
    });
  });

  it('honors the dashboard role deep-link over remembered filters', async () => {
    const roleId = '507f1f77bcf86cd799439011';
    setup([`/admin/users?role=${roleId}`]);

    await screen.findByRole('table');

    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.objectContaining({ roleId }),
      );
    });
  });

  it('clear filters resets the joining range', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(
      FILTER_STORAGE_KEY,
      JSON.stringify({ joiningFrom: '2026-09-01', joiningTo: '2026-09-30' }),
    );
    setup();

    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ joiningFrom: expect.anything(), joiningTo: expect.anything() }),
      );
    });
    const params = adminApi.listEmployees.mock.calls.at(-1)[0];
    expect(params.joiningFrom).toBeUndefined();
    expect(params.joiningTo).toBeUndefined();
  });
});
