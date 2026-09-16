import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import { AuthProvider } from '../context/AuthContext.jsx';
import AdminUsers from '../pages/admin/AdminUsers.jsx';

vi.mock('../services/api.js', () => ({
  adminApi: {
    listEmployees: vi.fn(() =>
      Promise.resolve({
        employees: [
          {
            id: 'emp1',
            name: 'Test User',
            email: 'test@example.com',
            employeeCode: 'EMP001',
            isActive: true,
            department: 'Development',
          },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      }),
    ),
    getEmployeeStats: vi.fn(() => Promise.resolve({ total: 1 })),
    listDepartments: vi.fn(() => Promise.resolve({ departments: [] })),
    listRoles: vi.fn(() => Promise.resolve({ roles: [] })),
    listManagers: vi.fn(() => Promise.resolve({ managers: [] })),
    updateEmployeeStatus: vi.fn(() => Promise.resolve({})),
  },
  preferencesApi: {
    getTablePreference: vi.fn(() => Promise.reject(new Error('no saved prefs'))),
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

describe('AdminUsers status toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a success toast after deactivating an employee', async () => {
    const user = userEvent.setup();
    setup();

    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });

    // Open the row action menu and choose Deactivate.
    const row = screen.getByText('Test User').closest('tr');
    const menuButton = within(row).getByRole('button', { name: /manage|actions|more/i });
    await user.click(menuButton);
    await user.click(await screen.findByRole('menuitem', { name: /deactivate/i }));

    // Confirm in the dialog.
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /deactivate/i }));

    await waitFor(() => {
      expect(adminApi.updateEmployeeStatus).toHaveBeenCalledWith('emp1', false);
    });
    await waitFor(() => {
      expect(screen.getByText(/deactivated\. they can no longer sign in/i)).toBeInTheDocument();
    });
  });
});
