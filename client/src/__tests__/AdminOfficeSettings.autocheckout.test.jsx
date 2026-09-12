// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminOfficeSettings from '../pages/admin/AdminOfficeSettings.jsx';
import { ToastProvider } from '../context/ToastContext.jsx';
import { OFFICE_POLICY_EVENT, OFFICE_POLICY_STORAGE_KEY } from '../utils/officePolicySync.js';
import { adminApi } from '../services/api.js';

vi.mock('../services/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    adminApi: {
      getOfficeSettings: vi.fn(),
      updateOfficeSettings: vi.fn(),
    },
  };
});

vi.mock('../hooks/useGeolocation.js', () => ({
  useGeolocation: () => ({
    getPosition: vi.fn(),
    loading: false,
    error: null,
  }),
}));

const baseSettings = {
  name: 'Grubpac HQ',
  latitude: 12.97,
  longitude: 77.59,
  radiusMeters: 100,
  maxAccuracyMeters: 50,
  sandwichLeaveEnabled: false,
  officeStartTime: '09:00',
  officeEndTime: '17:00',
  graceThresholdTime: '09:00',
  halfDayThresholdTime: '10:00',
  warningsPerQuarter: 3,
  weekendDays: [0, 6],
  autoCheckout: {
    enabled: true,
    office: { day: 'same', time: '23:59' },
    wfh: { day: 'next', time: '06:00' },
  },
};

function renderPage() {
  render(
    <ToastProvider>
      <AdminOfficeSettings />
    </ToastProvider>,
  );
}

describe('AdminOfficeSettings auto-checkout broadcast (B-006)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    adminApi.getOfficeSettings.mockResolvedValue({ settings: baseSettings });
    adminApi.updateOfficeSettings.mockImplementation(async (payload) => ({
      settings: { ...baseSettings, ...payload },
    }));
  });

  it('modal save broadcasts the full updated settings (event + storage)', async () => {
    const user = userEvent.setup();
    const events = [];
    const listener = (event) => events.push(event);
    window.addEventListener(OFFICE_POLICY_EVENT, listener);
    try {
      renderPage();

      await user.click(
        await screen.findByRole('button', { name: 'Set Auto-Checkout Timings' }),
      );
      await user.click(await screen.findByRole('button', { name: 'Save timings' }));

      await waitFor(() => expect(events).toHaveLength(1));
      expect(events[0].detail.autoCheckout).toEqual(baseSettings.autoCheckout);
      // Full-settings parity with the main form save: hours must be present.
      expect(events[0].detail.officeStartTime).toBe('09:00');

      const stored = JSON.parse(localStorage.getItem(OFFICE_POLICY_STORAGE_KEY));
      expect(stored.autoCheckout).toEqual(baseSettings.autoCheckout);
      expect(stored.officeStartTime).toBe('09:00');

      // The modal PATCHes only the autoCheckout slice.
      expect(adminApi.updateOfficeSettings).toHaveBeenCalledTimes(1);
      expect(Object.keys(adminApi.updateOfficeSettings.mock.calls[0][0])).toEqual([
        'autoCheckout',
      ]);
    } finally {
      window.removeEventListener(OFFICE_POLICY_EVENT, listener);
    }
  });

  it('main form save still broadcasts exactly once', async () => {
    const user = userEvent.setup();
    const events = [];
    const listener = (event) => events.push(event);
    window.addEventListener(OFFICE_POLICY_EVENT, listener);
    try {
      renderPage();
      await user.click(await screen.findByRole('button', { name: 'Save settings' }));
      await waitFor(() => expect(events).toHaveLength(1));
      expect(events[0].detail.officeStartTime).toBe('09:00');
    } finally {
      window.removeEventListener(OFFICE_POLICY_EVENT, listener);
    }
  });
});
