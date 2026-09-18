import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  ADMIN_PORTAL_PERMISSIONS,
  PERMISSIONS,
  SYSTEM_ROLE_SLUGS,
} from '@shared/permissions.js';

let mockUser = null;

vi.mock('../services/api.js', () => ({
  authApi: {},
  getErrorMessage: (err) => err?.message ?? 'error',
  startSessionKeepalive: () => () => {},
  default: {
    get: vi.fn((url) =>
      url.includes('/auth/me')
        ? Promise.resolve({ data: { user: mockUser } })
        : Promise.resolve({ data: {} }),
    ),
    post: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

import { AuthProvider, useAuth } from '../context/AuthContext.jsx';

function Probe() {
  const { canSwitchPortal, loading } = useAuth();
  if (loading) return <p>loading</p>;
  return <p data-testid="switch-flag">{canSwitchPortal ? 'yes' : 'no'}</p>;
}

function setup(user) {
  mockUser = user;
  // AuthProvider skips session restore on public paths without a stored
  // portal — seed both signals so /auth/me is actually probed.
  localStorage.setItem('attendance.loginPortal', 'admin');
  document.cookie = 'attendance_csrf=test';
  render(
    <MemoryRouter>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const DUAL_PERMS = [...ADMIN_PORTAL_PERMISSIONS, PERMISSIONS.ATTENDANCE_READ_OWN];

function dualUser(role) {
  return {
    _id: 'u1',
    name: 'Test User',
    email: 'test@grubpac.com',
    role,
    permissions: DUAL_PERMS,
  };
}

describe('AuthContext canSwitchPortal (TEMP admin hide)', () => {
  beforeEach(() => {
    cleanup();
    mockUser = null;
    localStorage.clear();
    document.cookie = 'attendance_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  it('hides the switch for Admin role even with dual-portal permissions', async () => {
    setup(dualUser(SYSTEM_ROLE_SLUGS.ADMIN));
    await waitFor(() => expect(screen.getByTestId('switch-flag')).toHaveTextContent('no'));
  });

  it('keeps the switch for HR role with dual-portal permissions', async () => {
    setup(dualUser(SYSTEM_ROLE_SLUGS.HR));
    await waitFor(() => expect(screen.getByTestId('switch-flag')).toHaveTextContent('yes'));
  });

  it('keeps the switch for reporting-manager role with dual-portal permissions', async () => {
    setup(dualUser(SYSTEM_ROLE_SLUGS.REPORTING_MANAGER));
    await waitFor(() => expect(screen.getByTestId('switch-flag')).toHaveTextContent('yes'));
  });

  it('hides the switch for admin-only permissions (pre-existing behavior)', async () => {
    setup({ ...dualUser(SYSTEM_ROLE_SLUGS.ADMIN), permissions: [...ADMIN_PORTAL_PERMISSIONS] });
    await waitFor(() => expect(screen.getByTestId('switch-flag')).toHaveTextContent('no'));
  });

  it('hides the switch when logged out', async () => {
    mockUser = null;
    document.cookie = 'attendance_csrf=test';
    render(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('switch-flag')).toHaveTextContent('no'));
  });
});
