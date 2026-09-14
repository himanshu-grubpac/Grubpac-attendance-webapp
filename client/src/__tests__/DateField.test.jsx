import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DateField from '../components/DateField.jsx';

// 2026-09-05 is a Saturday, 2026-09-08 a Tuesday.
const SATURDAY = '2026-09-05';
const TUESDAY = '2026-09-08';

function openPicker(triggerLabel) {
  return screen.getByRole('button', { name: triggerLabel });
}

describe('DateField isDateAllowed gate', () => {
  it('disables disallowed days and only commits allowed ones', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const allowed = new Set([SATURDAY]);
    render(
      <DateField
        value={SATURDAY}
        onChange={onChange}
        isDateAllowed={(key) => allowed.has(key)}
        aria-label="Start date"
      />,
    );

    await user.click(openPicker('Start date'));

    const saturdayBtn = screen.getByRole('button', { name: SATURDAY });
    const tuesdayBtn = screen.getByRole('button', { name: TUESDAY });
    expect(saturdayBtn).toBeEnabled();
    expect(tuesdayBtn).toBeDisabled();

    await user.click(tuesdayBtn);
    expect(onChange).not.toHaveBeenCalled();

    await user.click(saturdayBtn);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(SATURDAY);
  });

  it('behaves exactly as before when isDateAllowed is absent', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateField value={SATURDAY} onChange={onChange} aria-label="Start date" />);

    await user.click(openPicker('Start date'));

    expect(screen.getByRole('button', { name: SATURDAY })).toBeEnabled();
    expect(screen.getByRole('button', { name: TUESDAY })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: TUESDAY }));
    expect(onChange).toHaveBeenCalledWith(TUESDAY);
  });

  it('ANDs the gate with min/max range checks', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateField
        value={SATURDAY}
        onChange={onChange}
        min="2026-09-06"
        isDateAllowed={() => true}
        aria-label="Start date"
      />,
    );

    await user.click(openPicker('Start date'));
    // In range + allowed by the gate → enabled; before min → disabled even
    // though the gate allows it.
    expect(screen.getByRole('button', { name: TUESDAY })).toBeEnabled();
    expect(screen.getByRole('button', { name: SATURDAY })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
