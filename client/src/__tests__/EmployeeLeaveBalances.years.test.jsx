import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmployeeLeaveBalances from '../pages/employee/EmployeeLeaveBalances.jsx';

const getMyYears = vi.fn();
const getMyBalances = vi.fn(() => Promise.resolve({ balances: [] }));
const listPolicies = vi.fn(() => Promise.resolve({ policies: [] }));

vi.mock('../services/api.js', () => ({
  leaveApi: {
    getMyYears: (...args) => getMyYears(...args),
    getMyBalances: (...args) => getMyBalances(...args),
    listPolicies: (...args) => listPolicies(...args),
  },
  getErrorMessage: (err) => err?.message ?? 'Error',
}));

vi.mock('../hooks/usePortalSync.js', () => ({
  usePortalSync: () => {},
}));

if (typeof window !== 'undefined' && !window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
}
Element.prototype.scrollIntoView = function scrollIntoView() {};

describe('EmployeeLeaveBalances year selector', () => {
  beforeEach(() => {
    getMyYears.mockReset();
    getMyBalances.mockClear();
    listPolicies.mockClear();
  });

  it('loads year options from GET /leave/years/me and includes current IST year', async () => {
    getMyYears.mockResolvedValue({ years: [2023, 2024] });

    render(<EmployeeLeaveBalances />);

    await waitFor(() => {
      expect(getMyYears).toHaveBeenCalledTimes(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Year' }));

    expect(screen.getByRole('option', { name: '2026' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '2024' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '2023' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '2022' })).not.toBeInTheDocument();
  });

  it('falls back to current year only when years API fails', async () => {
    getMyYears.mockRejectedValue(new Error('network'));

    render(<EmployeeLeaveBalances />);

    await waitFor(() => {
      expect(getMyYears).toHaveBeenCalledTimes(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Year' }));

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('2026');
    expect(getMyBalances).toHaveBeenCalled();
  });
});
