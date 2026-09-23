import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PERMISSIONS } from '@shared/permissions.js';
import NotificationBell from '../components/NotificationBell.jsx';

const HELP_TEAM_LINK = '/admin/help/team/ticket-abc123';

let mockHasAnyPermission = () => false;
let mockUser = { permissions: [] };
let mockNavigate = vi.fn();

vi.mock('../services/api.js', () => ({
  notificationsApi: {
    getUnreadCount: vi.fn(() => Promise.resolve({ unreadCount: 0 })),
    list: vi.fn(() => Promise.resolve({ notifications: [], unreadCount: 0 })),
    markRead: vi.fn((id) =>
      Promise.resolve({ notification: { id, readAt: new Date().toISOString() } }),
    ),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({
    hasAnyPermission: mockHasAnyPermission,
    user: mockUser,
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
    mockUser = { permissions: [] };
    mockNavigate.mockReset();
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

describe('NotificationBell panel open behaviour', () => {
  beforeEach(() => {
    mockHasAnyPermission = (permissions) =>
      permissions.includes(PERMISSIONS.PORTAL_ADMIN);
    mockNavigate.mockReset();
  });

  it('keeps the panel open after the bell is clicked', async () => {
    const user = userEvent.setup();
    renderBell();
    await user.click(await screen.findByRole('button', { name: /Notifications/i }));

    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('shows cached notifications on reopen without a loading flash', async () => {
    const { notificationsApi } = await import('../services/api.js');
    notificationsApi.list.mockResolvedValue({
      unreadCount: 1,
      notifications: [
        {
          id: 'n-cache',
          type: 'leave.approved',
          title: 'Leave approved',
          body: 'Your leave was approved',
          link: '/employee/leave',
          createdAt: '2026-09-22T10:00:00.000Z',
        },
      ],
    });

    const user = userEvent.setup();
    renderBell();

    await user.click(await screen.findByRole('button', { name: /Notifications/i }));
    expect(await screen.findByText('Leave approved')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /Notifications/i }));
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).not.toBeInTheDocument();

    notificationsApi.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                unreadCount: 1,
                notifications: [
                  {
                    id: 'n-cache',
                    type: 'leave.approved',
                    title: 'Leave approved',
                    body: 'Your leave was approved',
                    link: '/employee/leave',
                    createdAt: '2026-09-22T10:00:00.000Z',
                  },
                ],
              }),
            100,
          );
        }),
    );

    await user.click(await screen.findByRole('button', { name: /Notifications/i }));
    expect(screen.getByText('Leave approved')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });
});

describe('NotificationBell help link rewrite', () => {
  beforeEach(() => {
    mockHasAnyPermission = (permissions) =>
      permissions.includes(PERMISSIONS.PORTAL_ADMIN);
    mockNavigate.mockReset();
  });

  it('rewrites team help links for company help access', async () => {
    mockUser = {
      permissions: [PERMISSIONS.HELP_TICKET_R, PERMISSIONS.EMPLOYEES_RECORD_R],
    };
    const { notificationsApi } = await import('../services/api.js');
    notificationsApi.list.mockResolvedValueOnce({
      unreadCount: 1,
      notifications: [
        {
          id: 'n1',
          type: 'help.comment',
          title: 'New comment',
          body: 'Update available',
          link: HELP_TEAM_LINK,
          createdAt: '2026-09-22T10:00:00.000Z',
        },
      ],
    });

    const user = userEvent.setup();
    renderBell();
    await user.click(await screen.findByRole('button', { name: /Notifications/i }));
    await user.click(await screen.findByText('New comment'));

    expect(mockNavigate).toHaveBeenCalledWith('/admin/help/tickets/ticket-abc123');
  });

  it('keeps team help links without company help access', async () => {
    mockUser = { permissions: [PERMISSIONS.HELP_TICKET_R] };
    const { notificationsApi } = await import('../services/api.js');
    notificationsApi.list.mockResolvedValueOnce({
      unreadCount: 1,
      notifications: [
        {
          id: 'n2',
          type: 'help.comment',
          title: 'Team ticket',
          body: 'Needs review',
          link: HELP_TEAM_LINK,
          createdAt: '2026-09-22T10:00:00.000Z',
        },
      ],
    });

    const user = userEvent.setup();
    renderBell();
    await user.click(await screen.findByRole('button', { name: /Notifications/i }));
    await user.click(await screen.findByText('Team ticket'));

    expect(mockNavigate).toHaveBeenCalledWith(HELP_TEAM_LINK);
  });
});
