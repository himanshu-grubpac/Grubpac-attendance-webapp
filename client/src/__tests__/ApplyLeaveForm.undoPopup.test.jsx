import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../context/ToastContext.jsx';
import { ActionPopupProvider } from '../context/ActionPopupContext.jsx';
import ApplyLeaveForm from '../pages/employee/ApplyLeaveForm.jsx';
import { leaveApi } from '../services/api.js';

vi.mock('@shared/utils/wfhPolicy.js', () => ({
  WFH_LEAVE_TYPE_CODE: 'WFH',
  SL_LEAVE_TYPE_CODE: 'SL',
  LEAVE_APPLY_ADVANCE_ERROR: 'Advance notice required.',
  LEAVE_APPLY_DEADLINE_ERROR: 'Past cutoff.',
  isLeaveTypeExemptFromApplyDeadline: (code) => String(code ?? '').toUpperCase() === 'SL',
  validateLeaveApplyDeadline: () => null,
}));

vi.mock('../services/api.js', () => ({
  leaveApi: {
    listTypes: vi.fn(() =>
      Promise.resolve({
        types: [
          { id: '507f1f77bcf86cd799439012', code: 'WFH', name: 'Work From Home', isActive: true },
        ],
      }),
    ),
    listPolicies: vi.fn(() => Promise.resolve({ policies: [] })),
    listHolidays: vi.fn(() => Promise.resolve({ holidays: [] })),
    getMyBalances: vi.fn(() => Promise.resolve({ balances: [] })),
    previewDays: vi.fn(() => Promise.resolve({ days: 1, workingDays: ['2026-09-22'], sandwichApplied: false })),
    createRequest: vi.fn(),
    withdrawSubmitted: vi.fn(() => Promise.resolve({})),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
  getFieldErrors: () => ({}),
}));

if (typeof window !== 'undefined' && !window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
}

function setup(mode) {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ActionPopupProvider>
          <ApplyLeaveForm mode={mode} />
        </ActionPopupProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('ApplyLeaveForm submit undo (ActionPopup)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wfh submit shows ActionPopup with Undo and yellow progress bar', async () => {
    const undoExpiresAt = new Date(Date.now() + 10000).toISOString();
    leaveApi.createRequest.mockResolvedValueOnce({
      request: {
        id: '507f1f77bcf86cd799439099',
        userId: '507f1f77bcf86cd799439088',
        decisionUndoExpiresAt: undoExpiresAt,
      },
    });

    const user = userEvent.setup();
    setup('wfh');

    await waitFor(() => {
      expect(screen.getByLabelText('Leave type')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText(/reason/i), 'Focus work from home');
    await user.click(screen.getByRole('button', { name: /submit request/i }));

    await waitFor(() => {
      expect(leaveApi.createRequest).toHaveBeenCalledTimes(1);
    });

    expect(
      await screen.findByText(/WFH request submitted\. If done by mistake, click Undo to revert it\./i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(document.querySelector('.action-popup__progress-bar')).toBeInTheDocument();
  });

  it('wfh undo calls withdrawSubmitted before server expiry', async () => {
    const undoExpiresAt = new Date(Date.now() + 10000).toISOString();
    leaveApi.createRequest.mockResolvedValueOnce({
      request: {
        id: '507f1f77bcf86cd799439099',
        userId: '507f1f77bcf86cd799439088',
        decisionUndoExpiresAt: undoExpiresAt,
      },
    });

    const user = userEvent.setup();
    setup('wfh');

    await waitFor(() => {
      expect(screen.getByLabelText('Leave type')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText(/reason/i), 'Focus work from home');
    await user.click(screen.getByRole('button', { name: /submit request/i }));

    const undoBtn = await screen.findByRole('button', { name: 'Undo' });
    await user.click(undoBtn);

    await waitFor(() => {
      expect(leaveApi.withdrawSubmitted).toHaveBeenCalledWith('507f1f77bcf86cd799439099');
    });
  });
});
