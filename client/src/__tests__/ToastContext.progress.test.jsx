import { describe, it, expect } from 'vitest';
import React, { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { ToastProvider, useToast } from '../context/ToastContext.jsx';

function Probe({ message, options }) {
  const { showToast } = useToast();
  useEffect(() => {
    showToast(message, options);
  }, []);
  return null;
}

function setup(message, options) {
  render(
    <ToastProvider>
      <Probe message={message} options={options} />
    </ToastProvider>,
  );
}

describe('ToastContext progress timer', () => {
  it('renders the receding timer bar matched to the toast duration', () => {
    setup('Comp off request submitted.', {
      durationMs: 15000,
      action: { label: 'Undo', onClick: () => {} },
    });

    expect(screen.getByText('Comp off request submitted.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    const bar = document.querySelector('.toast__progress-bar');
    expect(bar).not.toBeNull();
    expect(bar.style.animationDuration).toBe('15000ms');
  });

  it('uses the default success duration when none is given', () => {
    setup('Saved.');
    expect(screen.getByText('Saved.')).toBeInTheDocument();
    const bar = document.querySelector('.toast__progress-bar');
    expect(bar).not.toBeNull();
    expect(bar.style.animationDuration).toBe('4500ms');
  });

  it('omits the timer bar for persistent toasts (durationMs 0)', () => {
    setup('Stays until dismissed.', { durationMs: 0 });
    expect(screen.getByText('Stays until dismissed.')).toBeInTheDocument();
    expect(document.querySelector('.toast__progress-bar')).toBeNull();
  });
});
