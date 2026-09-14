import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import { ActionPopupProvider } from '../context/ActionPopupContext.jsx';
import AdminCompOffRequests from '../pages/admin/AdminCompOffRequests.jsx';

const workedItem = {
  id: 'co1',
  userName: 'Anuj Jha',
  leaveTypeCode: 'CO',
  leaveTypeName: 'Compensatory Off',
  startDate: '2026-09-12T00:00:00.000Z',
  endDate: '2026-09-13T00:00:00.000Z',
  days: 2,
  reason: 'Release cover',
  status: 'worked',
  pendingAction: null,
  creditedDays: 0,
};

vi.mock('../services/api.js', () => ({
  compOffApi: {
    list: vi.fn(() => Promise.resolve({ requests: [workedItem], pagination: null })),
    assess: vi.fn(() => Promise.resolve({ request: workedItem })),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

function setup() {
  render(
    <MemoryRouter initialEntries={['/admin/leave/comp-off?queue=worked']}>
      <ToastProvider>
        <ActionPopupProvider>
          <AdminCompOffRequests />
        </ActionPopupProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function openAssessModal(user) {
  // The Assess button lives in the expanded row detail. The name renders in
  // both the mobile card and the desktop cell (same row), so take the first.
  const [nameCell] = await screen.findAllByText('Anuj Jha');
  await user.click(nameCell.closest('tr'));
  await user.click(await screen.findByRole('button', { name: 'Assess work' }));
  await screen.findByText('Assess comp off work');
}

describe('AdminCompOffRequests assess modal', () => {
  it('renders one rating row per worked day with a live total', async () => {
    const user = userEvent.setup();
    setup();
    await openAssessModal(user);

    // One radiogroup per worked day (Sat 12th + Sun 13th).
    expect(screen.getAllByRole('radiogroup')).toHaveLength(2);
    expect(screen.getByText(/Total credit:/)).toHaveTextContent('+2 day(s)');
  });

  it('requires a remark before recording and totals per-day rates', async () => {
    const user = userEvent.setup();
    setup();
    await openAssessModal(user);

    const recordButton = screen.getByRole('button', { name: 'Record assessment' });
    expect(recordButton).toBeDisabled();

    await user.type(screen.getByLabelText(/Assessment remark/), 'Great weekend cover.');
    expect(recordButton).toBeEnabled();

    // Rate the second day as half: total drops from +2 to +1.5.
    const groups = screen.getAllByRole('radiogroup');
    const sundayGroup = groups[1];
    await user.click(within(sundayGroup).getByRole('radio', { name: /Half work done/ }));
    expect(screen.getByText(/Total credit:/)).toHaveTextContent('+1.5 day(s)');
  });
});
