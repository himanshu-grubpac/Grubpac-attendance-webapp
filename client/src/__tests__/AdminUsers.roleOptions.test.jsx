import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    listRoles: vi.fn(() =>
      Promise.resolve({
        roles: [
          { id: 'r-admin', name: 'Admin', slug: 'admin' },
          { id: 'r-emp', name: 'Employee', slug: 'employee' },
        ],
      }),
    ),
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

// Team RM viewer: every permission except roles.manage, non-admin slug.
vi.mock('../context/AuthContext.jsx', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useAuth: () => ({
      hasPermission: (permission) => permission !== 'roles.manage',
      user: { roleSlug: 'reporting-manager' },
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

// jsdom has no layout engine: stub scrollIntoView used by the dropdowns.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
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

describe('AdminUsers role filter visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides the Admin option from viewers without role administration', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });
    // SelectField is a custom combobox: options render into a body portal
    // only while open.
    await user.click(screen.getByRole('combobox', { name: /role filter/i }));
    const options = await screen.findAllByRole('option');
    const labels = options.map((o) => o.textContent);
    expect(labels).toContain('All roles');
    expect(labels).toContain('Employee');
    expect(labels).not.toContain('Admin');
  });
});
