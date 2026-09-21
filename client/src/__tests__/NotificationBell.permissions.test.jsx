import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PERMISSIONS } from '@shared/permissions.js';
import NotificationBell from '../components/NotificationBell.jsx';

let mockHasAnyPermission = () => false;

vi.mock('../services/api.js', () => ({
  notificationsApi: {
    getUnreadCount: vi.fn(() => Promise.resolve({ unreadCount: 0 })),
    list: vi.fn(() => Promise.resolve({ notifications: [], unreadCount: 0 })),
  },
}));

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({
    hasAnyPermission: mockHasAnyPermission,
  }),
}));

vi.mock('../hooks/usePortalSync.js', () => ({
  usePortalSync: () => {},
}));

function renderBell() {
  return render(
    <MemoryRouter>
      <NotificationBell />
    </MemoryRouter>,
  );
}

describe('NotificationBell portal gate', () => {
  beforeEach(() => {
    mockHasAnyPermission = () => false;
  });

  it('renders the bell when user has admin portal access only', () => {
    mockHasAnyPermission = (permissions) =>
      permissions.includes(PERMISSIONS.PORTAL_ADMIN);

    renderBell();
    expect(screen.getByRole('button', { name: /Notifications/i })).toBeInTheDocument();
  });

  it('renders the bell when user has employee portal access only', () => {
    mockHasAnyPermission = (permissions) =>
      permissions.includes(PERMISSIONS.PORTAL_EMPLOYEE);

    renderBell();
    expect(screen.getByRole('button', { name: /Notifications/i })).toBeInTheDocument();
  });

  it('hides the bell when user lacks both portal gates', () => {
    renderBell();
    expect(screen.queryByRole('button', { name: /Notifications/i })).not.toBeInTheDocument();
  });
});
