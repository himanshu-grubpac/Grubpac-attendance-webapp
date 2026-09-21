import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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

vi.mock('../utils/portalSync.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    broadcastEmployeeSync: vi.fn(),
  };
});

vi.mock('../context/AuthContext.jsx', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useAuth: () => ({
      hasPermission: () => true,
      hasAnyPermission: () => true,
      user: { id: 'admin1', name: 'Admin' },
    }),
  };
});

import { adminApi } from '../services/api.js';

let intersectCallback;

globalThis.IntersectionObserver = class {
  constructor(callback) {
    intersectCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
};

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
    intersectCallback = undefined;
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

  it('reloads listEmployees from page 1 after deactivate when scrolled past page 1', async () => {
    adminApi.listEmployees.mockImplementation(({ page }) =>
      Promise.resolve({
        employees: [
          {
            id: `emp-p${page}`,
            name: `User Page ${page}`,
            email: `user${page}@example.com`,
            employeeCode: `EMP00${page}`,
            isActive: true,
            department: 'Development',
          },
        ],
        pagination: { page, limit: 10, total: 30, totalPages: 3 },
      }),
    );

    const user = userEvent.setup();
    setup();

    await waitFor(() => {
      expect(screen.getByText('User Page 1')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(intersectCallback).toBeTypeOf('function');
    });

    await act(async () => {
      intersectCallback([{ isIntersecting: true }]);
    });
    await waitFor(() => {
      expect(screen.getByText('User Page 2')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(intersectCallback).toBeTypeOf('function');
    });
    await act(async () => {
      intersectCallback([{ isIntersecting: true }]);
    });
    await waitFor(() => {
      expect(screen.getByText('User Page 3')).toBeInTheDocument();
    });
    expect(adminApi.listEmployees).toHaveBeenCalledWith(expect.objectContaining({ page: 3 }));

    adminApi.listEmployees.mockClear();

    const row = screen.getByText('User Page 1').closest('tr');
    const menuButton = within(row).getByRole('button', { name: /manage|actions|more/i });
    await user.click(menuButton);
    await user.click(await screen.findByRole('menuitem', { name: /deactivate/i }));

    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /deactivate/i }));

    await waitFor(() => {
      expect(adminApi.updateEmployeeStatus).toHaveBeenCalledWith('emp-p1', false);
    });

    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
    });
    expect(adminApi.listEmployees).not.toHaveBeenCalledWith(expect.objectContaining({ page: 3 }));
  });
});
