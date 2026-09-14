import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Avoid pulling real Leaflet (needs a layout/canvas) into jsdom.
vi.mock('../components/CheckInMap.jsx', () => ({ default: () => null }));

// Instant GPS in tests: the real hook multi-sample capture takes seconds,
// which would both slow the suite and blur the double-tap timing.
vi.mock('../hooks/useGeolocation.js', () => ({
  useGeolocation: () => ({
    getPosition: vi.fn(async () => ({
      latitude: 12.9716,
      longitude: 77.5946,
      accuracyMeters: 20,
    })),
    loading: false,
    error: null,
    position: {
      latitude: 12.9716,
      longitude: 77.5946,
      accuracyMeters: 20,
    },
    sampleInfo: null,
  }),
}));

const session = { checkIn: null, checkOut: null };
let checkInCalls = 0;
let releaseCheckIn = null;

function buildToday() {
  const { checkIn, checkOut } = session;
  return {
    checkIn,
    checkOut,
    canCheckIn: !checkIn && !checkOut,
    canCheckOut: Boolean(checkIn) && !checkOut,
    wfhApprovedToday: true,
    approvedLeaveToday: null,
    pendingLeaveToday: null,
    office: {
      name: 'HQ',
      latitude: 12.9716,
      longitude: 77.5946,
      radiusMeters: 5000,
      maxAccuracyMeters: 200,
      graceThresholdTime: '23:59',
      halfDayThresholdTime: '23:59',
      warningsPerQuarter: 3,
      weekendDays: [0, 6],
    },
    istDate: '2026-08-25',
    currentIST: new Date().toISOString(),
  };
}

vi.mock('../services/api.js', () => {
  const attendanceApi = {
    getToday: vi.fn(() => Promise.resolve({ status: buildToday() })),
    // Never-resolving-until-released promise keeps the first tap in flight
    // while the second tap lands, proving the synchronous re-entry guard.
    checkIn: vi.fn(() => {
      checkInCalls += 1;
      session.checkIn = {
        type: 'check_in',
        status: 'allowed',
        timestamp: new Date().toISOString(),
        attendanceMode: 'wfh',
        latitude: 12.9716,
        longitude: 77.5946,
        accuracyMeters: 20,
      };
      return new Promise((resolve) => {
        releaseCheckIn = () =>
          resolve({
            status: 'allowed',
            record: session.checkIn,
            quarterWarnings: { quarter: '2026-Q1', allowance: 3, used: 0, remaining: 3 },
          });
      });
    }),
    checkOut: vi.fn(() => Promise.resolve({ status: 'allowed', record: {} })),
    getMonthSummary: vi.fn(() => Promise.resolve({ days: {}, holidays: {}, birthdays: {}, today: '2026-08-25' })),
    getQuarterWarnings: vi.fn(() => Promise.resolve({ quarter: '2026-Q1', allowance: 3, used: 0, remaining: 3 })),
    undo: vi.fn(() => Promise.resolve({})),
  };
  const api = {
    get: vi.fn((url) =>
      url.includes('/auth/me')
        ? Promise.resolve({
            data: {
              user: {
                _id: 'u1',
                name: 'Test Employee',
                email: 't@e.com',
                role: 'employee',
                permissions: ['attendance.read_own'],
              },
            },
          })
        : Promise.resolve({ data: {} }),
    ),
    post: vi.fn(() => Promise.resolve({ data: {} })),
  };
  return {
    attendanceApi,
    getErrorMessage: (err) => err?.response?.data?.message ?? 'error',
    default: api,
  };
});

import EmployeeDashboard from '../pages/employee/EmployeeDashboard.jsx';
import { AuthProvider } from '../context/AuthContext.jsx';
import { ToastProvider } from '../context/ToastContext.jsx';
import { ActionPopupProvider } from '../context/ActionPopupContext.jsx';
import { attendanceApi } from '../services/api.js';

function renderDashboard() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ActionPopupProvider>
          <AuthProvider>
            <EmployeeDashboard />
          </AuthProvider>
        </ActionPopupProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('EmployeeDashboard double-tap guard + CTA color', () => {
  beforeEach(() => {
    session.checkIn = null;
    session.checkOut = null;
    checkInCalls = 0;
    releaseCheckIn = null;
    vi.clearAllMocks();
  });

  it('drops the second tap while check-in is in flight (single API call)', async () => {
    renderDashboard();
    const button = await screen.findByRole('button', { name: 'Check in', exact: true });
    // Wait for data load: taps landing while the button is still disabled
    // (today not fetched yet) never reach the handler — flaky under load.
    await waitFor(() => expect(button).toBeEnabled());

    // Two synchronous taps before React can re-render/disable the button.
    fireEvent.click(button);
    fireEvent.click(button);

    // The first tap must reach the API exactly once…
    await waitFor(() => expect(attendanceApi.checkIn).toHaveBeenCalledTimes(1));
    expect(checkInCalls).toBe(1);
    // …and the dropped second tap must never arrive late either.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(attendanceApi.checkIn).toHaveBeenCalledTimes(1);
    expect(checkInCalls).toBe(1);

    releaseCheckIn?.();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Check in', exact: true })).toBeNull());
  });

  it('check-out CTA uses the primary (orange) style, not secondary grey', async () => {
    const user = userEvent.setup();
    session.checkIn = {
      type: 'check_in',
      status: 'allowed',
      timestamp: new Date().toISOString(),
      attendanceMode: 'wfh',
    };
    renderDashboard();
    const button = await screen.findByRole('button', { name: 'Check out', exact: true });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button.className).toMatch(/btn-primary/);
    expect(button.className).not.toMatch(/btn-secondary/);
    await user.click(button);
    await waitFor(() => expect(attendanceApi.checkOut).toHaveBeenCalledTimes(1));
  });
});
