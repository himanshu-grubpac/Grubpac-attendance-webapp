import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionPopupProvider, useActionPopup } from '../context/ActionPopupContext.jsx';

function Harness({ onUndo, durationMs = 15000, withUndo = true }) {
  const { showActionPopup } = useActionPopup();
  return (
    <button
      type="button"
      onClick={() =>
        showActionPopup({
          message: 'Leave request approved. If done by mistake, click Undo to revert it.',
          undoLabel: 'Undo',
          onUndo: withUndo ? onUndo : null,
          durationMs,
        })
      }
    >
      Trigger
    </button>
  );
}

describe('ActionPopup (undo confirmation)', () => {
  it('shows message + Undo and calls onUndo, then dismisses', async () => {
    const onUndo = vi.fn();
    const user = userEvent.setup();
    render(
      <ActionPopupProvider>
        <Harness onUndo={onUndo} />
      </ActionPopupProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Trigger' }));

    const undoBtn = await screen.findByRole('button', { name: 'Undo' });
    expect(undoBtn).toBeInTheDocument();
    expect(
      screen.getByText(/If done by mistake, click Undo to revert it/i),
    ).toBeInTheDocument();

    await user.click(undoBtn);
    expect(onUndo).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument(),
    );
  });

  it('auto-dismisses after its duration and does not call onUndo', async () => {
    const onUndo = vi.fn();
    const user = userEvent.setup();
    render(
      <ActionPopupProvider>
        <Harness onUndo={onUndo} durationMs={600} />
      </ActionPopupProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();

    await waitFor(
      () => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument(),
      { timeout: 2500 },
    );
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('renders without an Undo button when onUndo is null', async () => {
    const user = userEvent.setup();
    render(
      <ActionPopupProvider>
        <Harness onUndo={vi.fn()} withUndo={false} durationMs={600} />
      </ActionPopupProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(
      await screen.findByText(/If done by mistake, click Undo to revert it/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
});
