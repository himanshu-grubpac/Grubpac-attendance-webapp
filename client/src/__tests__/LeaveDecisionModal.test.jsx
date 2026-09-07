import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LeaveDecisionModal from '../pages/admin/LeaveDecisionModal.jsx';

const item = {
  id: 'req1',
  userName: 'Jane Doe',
  leaveTypeCode: 'CL',
  leaveTypeName: 'Casual Leave',
  startDate: '2026-09-10',
  endDate: '2026-09-10',
  days: 1,
  reason: 'Family function',
};

function setup(props = {}) {
  const handlers = {
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onCancel: vi.fn(),
    onCommentChange: vi.fn(),
    ...props.handlers,
  };
  render(
    <LeaveDecisionModal
      open
      item={item}
      initialComment="Looks good"
      onApprove={handlers.onApprove}
      onReject={handlers.onReject}
      onCancel={handlers.onCancel}
      onCommentChange={handlers.onCommentChange}
      {...props.modal}
    />,
  );
  return handlers;
}

describe('LeaveDecisionModal dismiss vs decision actions', () => {
  it('Cancel button dismisses without approving or rejecting', async () => {
    const user = userEvent.setup();
    const { onCancel, onReject, onApprove } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('Reject button rejects without approving (separate labeled action)', async () => {
    const user = userEvent.setup();
    const { onReject, onApprove, onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Escape dismisses without rejecting', () => {
    const { onCancel, onReject } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('cancel mode shows no Reject button', () => {
    setup({ modal: { action: 'cancel' } });
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel leave' })).toBeInTheDocument();
  });
});
