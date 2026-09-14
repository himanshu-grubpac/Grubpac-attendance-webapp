import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import ApplyLeaveForm from '../pages/employee/ApplyLeaveForm.jsx';

vi.mock('../services/api.js', () => ({
  leaveApi: {
    listTypes: vi.fn(() =>
      Promise.resolve({
        types: [
          { id: 'cl', code: 'CL', name: 'Casual Leave', isActive: true },
          { id: 'wfh', code: 'WFH', name: 'Work From Home', isActive: true },
        ],
      }),
    ),
    listPolicies: vi.fn(() => Promise.resolve({ policies: [] })),
    getMyBalances: vi.fn(() => Promise.resolve({ balances: [] })),
    listHolidays: vi.fn(() => Promise.resolve({ holidays: [] })),
    previewDays: vi.fn(() => Promise.resolve({ days: 1, workingDays: [], sandwichApplied: false })),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

// jsdom has no layout engine: stub scrollIntoView used by the type dropdown.
if (typeof window !== 'undefined' && !window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
}

function setup(mode) {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ApplyLeaveForm mode={mode} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('ApplyLeaveForm leave/WFH split', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leave mode never offers the WFH type', async () => {
    const user = userEvent.setup();
    setup('leave');

    const combo = await screen.findByRole('combobox', { name: /leave type/i });
    await user.click(combo);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /CL — Casual Leave/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole('option', { name: /WFH/ })).not.toBeInTheDocument();
  });

  it('wfh mode pins WFH with the selector hidden', async () => {
    setup('wfh');

    await waitFor(() => {
      expect(screen.getByLabelText('Leave type')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Leave type')).toHaveTextContent('WFH — Work From Home');
    expect(screen.queryByRole('combobox', { name: /leave type/i })).not.toBeInTheDocument();
  });

  it('renders no page header itself (titles come from the layout pageMeta)', async () => {
    const { unmount } = render(
      <MemoryRouter>
        <ToastProvider>
          <ApplyLeaveForm mode="wfh" />
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Leave type')).toBeInTheDocument();
    });
    // Regression guard: the form must not duplicate the AppLayout page title.
    expect(screen.queryByText('Apply WFH')).not.toBeInTheDocument();
    expect(screen.queryByText('Submit a work-from-home request.')).not.toBeInTheDocument();
    unmount();
  });
});
