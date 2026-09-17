import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import AdminUsers from '../pages/admin/AdminUsers.jsx';

vi.mock('../services/api.js', () => {
  const ACTIVE_COUNT = 12;
  const INACTIVE_COUNT = 3;
  const all = Array.from({ length: ACTIVE_COUNT + INACTIVE_COUNT }, (_, index) => ({
    id: `emp-${index + 1}`,
    name: `Employee ${index + 1}`,
    email: `emp${index + 1}@test.example`,
    mobile: `90000000${String(index + 1).padStart(2, '0')}`,
    departmentName: 'Engineering',
    isActive: index >= INACTIVE_COUNT,
    lastLoginAt: null,
  }));

  return {
    adminApi: {
      listEmployees: vi.fn((params = {}) => {
        const filtered = params.isActive === undefined
          ? all
          : all.filter((employee) => String(employee.isActive) === params.isActive);
        const page = params.page ?? 1;
        const limit = params.limit ?? 10;
        const start = (page - 1) * limit;
        return Promise.resolve({
          employees: filtered.slice(start, start + limit),
          pagination: {
            page,
            limit,
            total: filtered.length,
            totalPages: Math.max(1, Math.ceil(filtered.length / limit)),
          },
        });
      }),
      getEmployeeStats: vi.fn(() =>
        Promise.resolve({
          stats: {
            total: ACTIVE_COUNT + INACTIVE_COUNT,
            active: ACTIVE_COUNT,
            inactive: INACTIVE_COUNT,
            newThisMonth: 0,
            monthKey: '2026-09',
          },
        }),
      ),
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
  };
});

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

import { adminApi } from '../services/api.js';

if (!window.IntersectionObserver) {
  window.IntersectionObserver = class {
    constructor() {}
    observe() {}
    disconnect() {}
  };
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function setup() {
  render(
    <StrictMode>
      <MemoryRouter>
        <ToastProvider>
          <AdminUsers />
        </ToastProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

function footerText() {
  return screen.getByText(/showing \d+ of \d+ employees/i).textContent;
}

describe('AdminUsers stat cards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('total card resets status state so rows, dropdown and total stay consistent', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(footerText()).toMatch(/showing 10 of 15 employees/i);
    });

    // Inactive card: filtered request + dropdown follow the card.
    await user.click(screen.getByRole('button', { name: /inactive/i }));
    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.objectContaining({ isActive: 'false', page: 1 }),
      );
    });
    expect(
      screen.getByRole('combobox', { name: /status filter/i }),
    ).toHaveTextContent('Inactive');
    await waitFor(() => {
      expect(footerText()).toMatch(/showing 3 of 3 employees/i);
    });

    // Total card after inactive: unfiltered request, dropdown back to All,
    // and rows/total from the same response (never "10 of 5").
    await user.click(screen.getByRole('button', { name: /total employees/i }));
    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ isActive: expect.anything() }),
      );
    });
    expect(
      screen.getByRole('combobox', { name: /status filter/i }),
    ).toHaveTextContent('All');
    await waitFor(() => {
      expect(footerText()).toMatch(/showing 10 of 15 employees/i);
    });
  });

  it('total card also clears search and department state', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(footerText()).toMatch(/showing 10 of 15 employees/i);
    });

    await user.click(screen.getByRole('button', { name: /inactive/i }));
    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.objectContaining({ isActive: 'false' }),
      );
    });

    await user.click(screen.getByRole('button', { name: /total employees/i }));
    await waitFor(() => {
      const lastCall =
        adminApi.listEmployees.mock.calls[adminApi.listEmployees.mock.calls.length - 1][0];
      expect(lastCall.isActive).toBeUndefined();
      expect(lastCall.departmentId).toBeUndefined();
      expect(lastCall.search).toBeUndefined();
    });
  });
});
