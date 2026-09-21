import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import { AuthProvider } from '../context/AuthContext.jsx';
import AdminRegisterEmployee from '../pages/admin/AdminRegisterEmployee.jsx';
import { adminApi } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  adminApi: {
    listRoles: vi.fn(() =>
      Promise.resolve({
        roles: [{ id: 'r-emp', name: 'Employee', slug: 'employee' }],
      }),
    ),
    listDepartments: vi.fn(() =>
      Promise.resolve({
        departments: [
          { id: 'd1', name: 'Managed Dept', isActive: true },
          { id: 'd2', name: 'Other Dept', isActive: true },
        ],
      }),
    ),
    listManagers: vi.fn(() => Promise.resolve({ managers: [] })),
    registerEmployee: vi.fn(() => Promise.resolve({ employee: { id: 'e1' } })),
  },
  salaryApi: {
    updateUserSalary: vi.fn(() => Promise.resolve({})),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
  getFieldErrors: () => ({}),
}));

// Reporting-manager viewer without employee-record write, role
// administration, or salary-structure write; one managed department.
// (New RBAC catalog slugs.)
const canSee = (permission) =>
  permission !== 'employees.record.u'
  && permission !== 'rbac.role.r'
  && permission !== 'salary.structure.u';
vi.mock('../context/AuthContext.jsx', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useAuth: () => ({
      hasPermission: canSee,
      hasAnyPermission: (permissions) => permissions.some(canSee),
      user: {
        id: 'rm1',
        name: 'Remy Manager',
        roleSlug: 'reporting-manager',
        managedDepartmentIds: ['d1'],
      },
    }),
  };
});

// jsdom has no layout engine: stub scrollIntoView used by the dropdowns.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function setup() {  render(
    <StrictMode>
      <MemoryRouter initialEntries={['/admin/users/register']}>
        <ToastProvider>
          <AuthProvider>
            <AdminRegisterEmployee />
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('AdminRegisterEmployee scoped team creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('locks role/manager, limits departments, hides team scope', async () => {
    const user = userEvent.setup();
    setup();

    // Scoped creators resolve assignable roles only — never the catalog.
    await waitFor(() => {
      expect(adminApi.listRoles).toHaveBeenCalledWith({ scope: 'creatable' });
    });
    expect(adminApi.listManagers).not.toHaveBeenCalled();

    // Role is locked to Employee.
    const roleBox = screen.getByRole('combobox', { name: 'Role' });
    expect(roleBox).toBeDisabled();
    expect(roleBox).toHaveTextContent('Employee');

    // Reporting manager is locked to self.
    const managerBox = screen.getByRole('combobox', { name: 'Reporting manager' });
    expect(managerBox).toBeDisabled();
    expect(managerBox).toHaveTextContent('Remy Manager');

    // Departments are limited to the managed set.
    await user.click(screen.getByRole('combobox', { name: 'Department' }));
    const deptOptions = await screen.findAllByRole('option');
    const labels = deptOptions.map((o) => o.textContent);
    expect(labels).toContain('Managed Dept');
    expect(labels).not.toContain('Other Dept');

    // No team-scope field for scoped creators.
    expect(screen.queryByText('Managed departments (team scope)')).not.toBeInTheDocument();
  });
});
