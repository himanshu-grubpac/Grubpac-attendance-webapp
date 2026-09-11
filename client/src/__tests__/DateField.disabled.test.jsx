import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DateField from '../components/DateField.jsx';

// 2026-09-12 is a Saturday, 2026-09-14 a Monday, 2026-09-16 a Wednesday.
function setup(props = {}) {
  const onChange = vi.fn();
  render(
    <DateField
      value="2026-09-14"
      onChange={onChange}
      aria-label="Pick a date"
      disableWeekends
      disabledDates={['2026-09-16']}
      disabledDateTitles={{ '2026-09-16': 'Company holiday' }}
      {...props}
    />,
  );
  return { onChange };
}

async function openPicker(user) {
  await user.click(screen.getByRole('button', { name: /pick a date/i }));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '2026-09-14' })).toBeInTheDocument();
  });
}

describe('DateField non-working days', () => {
  it('disables Saturdays while keeping weekdays pickable', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await openPicker(user);

    const saturday = screen.getByRole('button', { name: '2026-09-12' });
    expect(saturday).toBeDisabled();
    expect(saturday.title).toMatch(/weekend/i);

    const monday = screen.getByRole('button', { name: '2026-09-14' });
    expect(monday).toBeEnabled();

    await user.click(saturday);
    expect(onChange).not.toHaveBeenCalled();
    await user.click(monday);
    expect(onChange).toHaveBeenCalledWith('2026-09-14');
  });

  it('disables admin holidays with their names as tooltips', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    await openPicker(user);

    const holiday = screen.getByRole('button', { name: '2026-09-16' });
    expect(holiday).toBeDisabled();
    expect(holiday.title).toBe('Company holiday');

    await user.click(holiday);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves every day enabled by default (other consumers unaffected)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateField value="2026-09-14" onChange={onChange} aria-label="Pick a date" />);
    await user.click(screen.getByRole('button', { name: /pick a date/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '2026-09-12' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '2026-09-12' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '2026-09-16' })).toBeEnabled();
  });
});
