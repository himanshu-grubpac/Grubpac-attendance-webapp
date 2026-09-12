import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import EmployeeApplyLeave from '../pages/employee/EmployeeApplyLeave.jsx';

let previewResult = { days: 0, workingDays: [], sandwichApplied: false };
let mockedTypes = [
  { id: 'co', code: 'CO', name: 'Compensatory Off', isActive: true },
  { id: 'cl', code: 'CL', name: 'Casual Leave', isActive: true },
];

vi.mock('../services/api.js', () => ({
  leaveApi: {
    listTypes: vi.fn(() => Promise.resolve({ types: mockedTypes })),
    listPolicies: vi.fn(() => Promise.resolve({ policies: [] })),
    getMyBalances: vi.fn(() => Promise.resolve({ balances: [] })),
    listHolidays: vi.fn(() => Promise.resolve({ holidays: [] })),
    previewDays: vi.fn(() => Promise.resolve(previewResult)),
    createRequest: vi.fn(() => Promise.resolve({ request: {} })),
    updateRequest: vi.fn(() => Promise.resolve({ request: {} })),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
  getFieldErrors: () => ({}),
}));

// jsdom has no layout engine: stub scrollIntoView used by the type dropdown.
if (typeof window !== 'undefined' && !window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
}

function setup() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <EmployeeApplyLeave />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function submitButton() {
  return screen.getByRole('button', { name: /submit request|save changes/i });
}

async function selectLeaveType(user, label) {
  const combo = await screen.findByRole('combobox', { name: /leave type/i });
  await user.click(combo);
  await user.click(await screen.findByRole('option', { name: label }));
}

describe('EmployeeApplyLeave zero-working-days guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewResult = { days: 0, workingDays: [], sandwichApplied: false };
    mockedTypes = [
      { id: 'co', code: 'CO', name: 'Compensatory Off', isActive: true },
      { id: 'cl', code: 'CL', name: 'Casual Leave', isActive: true },
    ];
  });

  it('warns and disables submit when the preview resolves to zero days', async () => {
    setup();

    await waitFor(() => {
      expect(screen.getByText(/no working days/i)).toBeInTheDocument();
    });
    expect(submitButton()).toBeDisabled();
  });

  it('adds the comp-off line when CO is the selected type', async () => {
    const user = userEvent.setup();
    setup();

    await selectLeaveType(user, /CO — Compensatory Off/);

    await waitFor(() => {
      expect(screen.getByText(/comp-off credit/i)).toBeInTheDocument();
    });
    expect(submitButton()).toBeDisabled();
  });

  it('stays unblocked with no warning when working days exist', async () => {
    previewResult = { days: 2, workingDays: ['2026-09-10', '2026-09-11'], sandwichApplied: false };
    setup();

    await waitFor(() => {
      expect(screen.getByText((_, node) => node?.className === 'preview-box')).toHaveTextContent(
        /2.*leave day\(s\)/,
      );
    });
    expect(screen.queryByText(/no working days/i)).not.toBeInTheDocument();
  });

  it('exempts the WFH type from the zero-day block', async () => {
    const user = userEvent.setup();
    mockedTypes = [
      { id: 'wfh', code: 'WFH', name: 'Work From Home', isActive: true },
      { id: 'cl', code: 'CL', name: 'Casual Leave', isActive: true },
    ];
    setup();

    await selectLeaveType(user, /WFH — Work From Home/);

    // Give the debounced preview a chance to resolve inside act(),
    // then assert the WFH type never triggers the block.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(screen.queryByText(/no working days/i)).not.toBeInTheDocument();
  });
});
