import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Avoid pulling real Leaflet (needs a layout/canvas) into jsdom.
vi.mock('../components/CheckInMap.jsx', () => ({ default: () => null }));

const session = { checkIn: null, checkOut: null };

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
    checkIn: vi.fn(() => {
      session.checkIn = {
        type: 'check_in',
        status: 'allowed',
        timestamp: new Date().toISOString(),
        attendanceMode: 'wfh',
        latitude: 12.9716,
        longitude: 77.5946,
        accuracyMeters: 20,
      };
      return Promise.resolve({
        status: 'allowed',
        record: session.checkIn,
        quarterWarnings: { quarter: '2026-Q1', allowance: 3, used: 0, remaining: 3 },
      });
    }),
    checkOut: vi.fn(() => {
      session.checkOut = {
        type: 'check_out',
        status: 'allowed',
        timestamp: new Date().toISOString(),
        attendanceMode: 'wfh',
      };
      return Promise.resolve({ status: 'allowed', record: session.checkOut });
    }),
    getMonthSummary: vi.fn(() => Promise.resolve({ days: {}, holidays: {}, birthdays: {}, today: '2026-08-25' })),
    getQuarterWarnings: vi.fn(() => Promise.resolve({ quarter: '2026-Q1', allowance: 3, used: 0, remaining: 3 })),
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

function renderDashboard() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AuthProvider>
          <EmployeeDashboard />
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function checkInButton() {
  return screen.queryByRole('button', { name: 'Check in', exact: true });
}
function checkOutButton() {
  return screen.queryByRole('button', { name: 'Check out', exact: true });
}

describe('EmployeeDashboard single toggle button', () => {
  beforeEach(() => {
    session.checkIn = null;
    session.checkOut = null;
  });

  it('toggles Check in -> Check out -> Check in and reflects auto-checkout', async () => {
    const user = userEvent.setup();
    const { unmount } = renderDashboard();

    // 1. Initial: single enabled "Check in" button, no "Check out".
    await waitFor(() => expect(checkInButton()).toBeEnabled());
    expect(checkOutButton()).toBeNull();

    // 2. Check in -> button becomes "Check out".
    await user.click(checkInButton());
    await waitFor(() => expect(checkOutButton()).toBeEnabled(), { timeout: 15000 });
    expect(screen.queryByRole('button', { name: 'Check in', exact: true })).toBeNull();

    // 3. Check out -> button becomes "Check in" again, disabled (one session/day),
    //    with a completion hint.
    await user.click(checkOutButton());
    await waitFor(() => expect(checkInButton()).toBeDisabled(), { timeout: 15000 });
    expect(checkOutButton()).toBeNull();
    expect(
      screen.getByText(/You have completed your attendance for today/i),
    ).toBeInTheDocument();

    // 4. Auto-checkout reflection: a fresh load (session already closed) shows
    //    "Check in" disabled with the same hint.
    unmount();
    renderDashboard();
    await waitFor(() => expect(checkInButton()).toBeDisabled(), { timeout: 15000 });
    expect(checkOutButton()).toBeNull();
    expect(
      screen.getByText(/You have completed your attendance for today/i),
    ).toBeInTheDocument();
  });
});
