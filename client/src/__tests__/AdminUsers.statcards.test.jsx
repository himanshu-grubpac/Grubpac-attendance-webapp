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
    departmentId: 'dept-eng',
    isActive: index >= INACTIVE_COUNT,
    lastLoginAt: null,
  }));

  return {
    adminApi: {
      listEmployees: vi.fn((params = {}) => {
        let filtered = params.isActive === undefined
          ? all
          : all.filter((employee) => String(employee.isActive) === params.isActive);
        if (params.departmentId) {
          filtered = filtered.filter((employee) => employee.departmentId === params.departmentId);
        }
        if (params.search) {
          const needle = String(params.search).toLowerCase();
          filtered = filtered.filter(
            (employee) =>
              employee.name.toLowerCase().includes(needle) ||
              employee.email.toLowerCase().includes(needle),
          );
        }
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
      listDepartments: vi.fn(() =>
        Promise.resolve({
          departments: [{ id: 'dept-eng', name: 'Engineering' }],
        }),
      ),
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
  useAuth: () => ({
    hasPermission: () => true,
    hasAnyPermission: () => true,
    user: { roleSlug: 'admin' },
  }),
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
      expect(footerText()).toMatch(/showing 10 of 12 employees/i);
    });

    // Default landing is the Active view: Active card pressed, Total not.
    expect(
      screen.getByRole('button', { name: /^active\b/i }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: /total employees/i }),
    ).toHaveAttribute('aria-pressed', 'false');

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

    // Total card after inactive: back to the default Active list — request
    // carries isActive 'true', dropdown shows Active, rows/total from the
    // same response (never "10 of 5") — but the TOTAL card stays lit
    // instead of Active.
    await user.click(screen.getByRole('button', { name: /total employees/i }));
    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.objectContaining({ isActive: 'true', page: 1 }),
      );
    });
    expect(
      screen.getByRole('combobox', { name: /status filter/i }),
    ).toHaveTextContent('Active');
    expect(
      screen.getByRole('button', { name: /total employees/i }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: /^active\b/i }),
    ).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => {
      expect(footerText()).toMatch(/showing 10 of 12 employees/i);
    });
  });

  it('keeps inactive stat card selected when department filter is applied', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(footerText()).toMatch(/showing 10 of 12 employees/i);
    });

    await user.click(screen.getByRole('button', { name: /inactive/i }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /inactive/i }),
      ).toHaveAttribute('aria-pressed', 'true');
    });

    await user.click(screen.getByRole('combobox', { name: /department filter/i }));
    await user.click(await screen.findByRole('option', { name: 'Engineering' }));

    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.objectContaining({ isActive: 'false', departmentId: 'dept-eng', page: 1 }),
      );
    });
    expect(
      screen.getByRole('button', { name: /inactive/i }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('clears inactive stat card when status changes away from inactive', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(footerText()).toMatch(/showing 10 of 12 employees/i);
    });

    await user.click(screen.getByRole('button', { name: /inactive/i }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /inactive/i }),
      ).toHaveAttribute('aria-pressed', 'true');
    });

    await user.click(screen.getByRole('combobox', { name: /status filter/i }));
    await user.click(await screen.findByRole('option', { name: 'Active' }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /^active\b/i }),
      ).toHaveAttribute('aria-pressed', 'true');
    });
    expect(
      screen.getByRole('button', { name: /inactive/i }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('inactive card clears leftover search so all inactive employees appear', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => {
      expect(footerText()).toMatch(/showing 10 of 12 employees/i);
    });

    // Leftover search text that matches nothing.
    await user.type(screen.getByLabelText(/search employees/i), 'zzz-no-match');
    await waitFor(() => {
      expect(adminApi.listEmployees).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'zzz-no-match' }),
      );
    });
    // Zero matches render the empty state instead of the footer.
    await waitFor(() => {
      expect(screen.getByText('No employees match these filters')).toBeInTheDocument();
    });

    // Inactive card must drop the search and show every inactive employee.
    await user.click(screen.getByRole('button', { name: /inactive/i }));
    await waitFor(() => {
      const lastCall =
        adminApi.listEmployees.mock.calls[adminApi.listEmployees.mock.calls.length - 1][0];
      expect(lastCall.isActive).toBe('false');
      expect(lastCall.search).toBeUndefined();
    });
    expect(screen.getByLabelText(/search employees/i)).toHaveValue('');
    expect(
      screen.getByRole('combobox', { name: /status filter/i }),
    ).toHaveTextContent('Inactive');
    await waitFor(() => {
      expect(footerText()).toMatch(/showing 3 of 3 employees/i);
    });
  });
});
