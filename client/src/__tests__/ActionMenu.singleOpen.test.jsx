import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ActionMenu from '../components/ActionMenu.jsx';

const ITEMS = [
  { key: 'view', label: 'View details', onClick: () => {} },
  { key: 'edit', label: 'Edit', onClick: () => {} },
];

function setup() {
  render(
    <>
      <ActionMenu label="Manage Aarav" items={ITEMS} />
      <ActionMenu label="Manage Suresh" items={ITEMS} />
    </>,
  );
}

describe('ActionMenu single-open', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('closes the previously opened menu when another trigger is clicked', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Manage Aarav' }));
    expect(await screen.findAllByRole('menuitem')).toHaveLength(2);

    // Opening the second row's menu must close the first — never two panels.
    // waitFor (not findAllByRole): the closing panel unmounts a beat after
    // the new one mounts, and find* resolves on first sight.
    await user.click(screen.getByRole('button', { name: 'Manage Suresh' }));
    await waitFor(() => {
      expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    });
    expect(screen.getByRole('button', { name: 'Manage Aarav' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Manage Suresh' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('toggles closed when its own trigger is clicked again', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'Manage Aarav' }));
    expect(await screen.findAllByRole('menuitem')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Manage Aarav' }));
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });
});
