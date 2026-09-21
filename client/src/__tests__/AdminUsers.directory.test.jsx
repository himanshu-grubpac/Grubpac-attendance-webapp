import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
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

const ADMIN_ROW = {
  id: 'admin1',
  name: 'Sys Admin',
  email: 'admin@example.com',
  employeeCode: 'ADM001',
  roleSlug: 'admin',
  isActive: true,
  department: 'Development',
};

let savedColumns = null;

vi.mock('../services/api.js', () => ({
  adminApi: {
    listEmployees: vi.fn(() =>
      Promise.resolve({
        employees: [EMPLOYEE, ADMIN_ROW],
        pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
      }),
    ),
    getEmployeeStats: vi.fn(() =>
      Promise.resolve({ stats: { total: 2, active: 2, inactive: 0, newThisMonth: 0 } }),
    ),
    listDepartments: vi.fn(() => Promise.resolve({ departments: [] })),
    listRoles: vi.fn(() => Promise.resolve({ roles: [] })),
    listManagers: vi.fn(() => Promise.resolve({ managers: [] })),
    updateEmployeeStatus: vi.fn(() => Promise.resolve({})),
  },
  preferencesApi: {
    getAvailableColumns: vi.fn(() => Promise.resolve(null)),
    getTablePreference: vi.fn(() =>
      savedColumns
        ? Promise.resolve({ data: { saved: true, columns: savedColumns } })
        : Promise.reject(new Error('no saved prefs')),
    ),
    updateTablePreference: vi.fn(() => Promise.resolve({})),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

vi.mock('../context/AuthContext.jsx', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useAuth: () => ({
      hasPermission: () => true,
      hasAnyPermission: () => true,
    }),
  };
});

import { adminApi } from '../services/api.js';

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

describe('AdminUsers directory', () => {
  beforeEach(() => {
    savedColumns = null;
    vi.clearAllMocks();
  });

  it('defaults the status filter to Active', async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });
    expect(adminApi.listEmployees).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: 'true' }),
    );
    // Default Active is not a "filter": no Clear button on load.
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it('searches live on partial input without a skeleton flash', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });

    // Partial keystrokes fire the search (debounced) with the partial query.
    await user.type(screen.getByLabelText(/search employees/i), 'Tes');
    await waitFor(
      () => {
        expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
          expect.objectContaining({ search: 'Tes' }),
        );
      },
      { timeout: 3000 },
    );
    // Current rows stay on screen while the quiet refresh lands.
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('disables admin row actions with a tooltip and no detail link', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(screen.getByText('Sys Admin')).toBeInTheDocument();
    });

    // Name is plain text, not a link to the (blocked) detail page.
    const nameCell = screen.getByText('Sys Admin').closest('td');
    expect(within(nameCell).queryByRole('link')).not.toBeInTheDocument();

    // Every menu item is disabled with the lock tooltip.
    const adminRow = screen.getByText('Sys Admin').closest('tr');
    const menuButtons = within(adminRow).getAllByRole('button');
    const manageButton = menuButtons.find((button) =>
      (button.getAttribute('aria-label') ?? '').startsWith('Manage'),
    );
    await user.click(manageButton);
    const items = await screen.findAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute('title', 'System admin — managed elsewhere');
    }
  });

  it('renders the employee-code column when enabled in preferences', async () => {
    savedColumns = [{ key: 'name' }, { key: 'email' }, { key: 'employeeCode' }];
    setup();
    await waitFor(() => {
      expect(screen.getByText('Emp code')).toBeInTheDocument();
    });
    expect(screen.getByText('EMP001')).toBeInTheDocument();
    expect(screen.getByText('ADM001')).toBeInTheDocument();
  });
});
