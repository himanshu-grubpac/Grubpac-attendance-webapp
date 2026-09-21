import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import AdminUsers from '../pages/admin/AdminUsers.jsx';

vi.mock('../services/api.js', () => ({
  adminApi: {
    listEmployees: vi.fn(() => Promise.resolve({
      employees: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 1 },
    })),
    getEmployeeStats: vi.fn(() => Promise.resolve({
      stats: { total: 10, active: 9, inactive: 1, newThisMonth: 4, monthKey: '2026-09' },
    })),
    listDepartments: vi.fn(() => Promise.resolve({ departments: [] })),
    listRoles: vi.fn(() => Promise.resolve({ roles: [] })),
    listManagers: vi.fn(() => Promise.resolve({ managers: [] })),
  },
  preferencesApi: {
    getAvailableColumns: vi.fn(() => Promise.resolve(null)),
    getTablePreference: vi.fn(() => Promise.resolve({ data: { saved: false } })),
    updateTablePreference: vi.fn(() => Promise.resolve({})),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ hasPermission: () => true, hasAnyPermission: () => true }),
}));

import { adminApi } from '../services/api.js';

if (!window.IntersectionObserver) {
  window.IntersectionObserver = class { observe() {} disconnect() {} };
}
if (!window.ResizeObserver) {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

function setup() {
  render(
    <StrictMode>
      <MemoryRouter>
        <ToastProvider><AdminUsers /></ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe('AdminUsers search', () => {
  beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });

  it('live search works right after clicking a stat card', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(adminApi.listEmployees).toHaveBeenCalled());

    // Stat cards reset the search box programmatically. The reset must not
    // swallow the user's next keystrokes.
    await user.click(screen.getByRole('button', { name: /new this month/i }));
    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.objectContaining({ createdAfter: '2026-09-01' }),
      );
    });

    await user.type(screen.getByLabelText(/search employees/i), 'admin');
    await waitFor(
      () => {
        expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
          expect.objectContaining({ search: 'admin' }),
        );
      },
      { timeout: 3000 },
    );
  });

  it('live search works right after Clear filters', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(adminApi.listEmployees).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /inactive/i }));
    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.objectContaining({ isActive: 'false' }),
      );
    });

    // Empty state renders its own Clear button — the toolbar one comes first.
    const clearButtons = screen.getAllByRole('button', { name: /^clear filters$/i });
    await user.click(clearButtons[0]);
    await user.type(screen.getByLabelText(/search employees/i), 'rahul');
    await waitFor(
      () => {
        expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
          expect.objectContaining({ search: 'rahul' }),
        );
      },
      { timeout: 3000 },
    );
  });

  it('live search keeps the month predicate instead of dropping it', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(adminApi.listEmployees).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /new this month/i }));
    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.objectContaining({ createdAfter: '2026-09-01' }),
      );
    });

    await user.type(screen.getByLabelText(/search employees/i), 'admin');
    await waitFor(
      () => {
        expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
          expect.objectContaining({ search: 'admin', createdAfter: '2026-09-01' }),
        );
      },
      { timeout: 3000 },
    );
  });
});
