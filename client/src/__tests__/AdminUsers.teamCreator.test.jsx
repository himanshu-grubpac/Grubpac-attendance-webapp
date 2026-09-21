import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import { AuthProvider } from '../context/AuthContext.jsx';
import AdminUsers from '../pages/admin/AdminUsers.jsx';

const EMPLOYEE = {
  id: 'emp1',
  name: 'Test User',
  email: 'test@example.com',
  employeeCode: 'EMP001',
  roleSlug: 'employee',
  isActive: true,
  department: 'Development',
};

vi.mock('../services/api.js', () => ({
  adminApi: {
    listEmployees: vi.fn(() =>
      Promise.resolve({
        employees: [EMPLOYEE],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      }),
    ),
    getEmployeeStats: vi.fn(() =>
      Promise.resolve({ stats: { total: 1, active: 1, inactive: 0, newThisMonth: 0 } }),
    ),
    listDepartments: vi.fn(() => Promise.resolve({ departments: [] })),
    listRoles: vi.fn(() => Promise.resolve({ roles: [] })),
    listManagers: vi.fn(() => Promise.resolve({ managers: [] })),
    updateEmployeeStatus: vi.fn(() => Promise.resolve({})),
  },
  preferencesApi: {
    getAvailableColumns: vi.fn(() => Promise.resolve(null)),
    getTablePreference: vi.fn(() => Promise.reject(new Error('no saved prefs'))),
    updateTablePreference: vi.fn(() => Promise.resolve({})),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

// Reporting-manager viewer: no users.write, non-admin slug.
vi.mock('../context/AuthContext.jsx', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useAuth: () => ({
      hasPermission: (permission) => permission !== 'users.write' && permission !== 'roles.manage',
      user: { id: 'rm1', roleSlug: 'reporting-manager', managedDepartmentIds: ['d1'] },
    }),
  };
});

if (typeof IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

function setup() {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/admin/users']}>
        <ToastProvider>
          <AuthProvider>
            <AdminUsers />
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('AdminUsers team-creator entry points', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows + Add Employee to reporting managers without users.write', async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });
    const addLink = screen.getByRole('link', { name: /add employee/i });
    expect(addLink).toHaveAttribute('href', '/admin/users/register');
  });
});
