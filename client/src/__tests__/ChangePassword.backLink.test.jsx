import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PageMetaProvider, usePageMetaContext } from '../context/PageMetaContext.jsx';

let mockUser = {
  hasPassword: true,
  hasPin: false,
  mustChangePassword: false,
};

vi.mock('../services/api.js', () => ({
  authApi: {
    changePassword: vi.fn(),
    setPin: vi.fn(),
    deletePin: vi.fn(),
  },
  getErrorMessage: (err) => err?.message ?? 'error',
}));

vi.mock('../context/ToastContext.jsx', () => ({
  useToast: () => ({ showSuccess: vi.fn() }),
}));

vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: mockUser,
    refreshUser: vi.fn(),
  }),
}));

import ChangePassword from '../pages/ChangePassword.jsx';

function MetaProbe() {
  const { meta } = usePageMetaContext();
  const backLink = meta.actions?.props?.to;
  const backLabel = meta.actions?.props?.children;
  return (
    <div
      data-testid="meta-back"
      data-to={backLink ?? ''}
      data-label={backLabel ?? ''}
      data-has-actions={meta.actions ? 'yes' : 'no'}
    />
  );
}

function renderChangePassword(pathname) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <PageMetaProvider>
        <MetaProbe />
        <ChangePassword />
      </PageMetaProvider>
    </MemoryRouter>,
  );
}

describe('ChangePassword page meta back link', () => {
  beforeEach(() => {
    cleanup();
    mockUser = {
      hasPassword: true,
      hasPin: false,
      mustChangePassword: false,
    };
  });

  it('shows toolbar back link to employee profile when password change is optional', async () => {
    renderChangePassword('/employee/change-password');

    await waitFor(() => {
      expect(screen.getByTestId('meta-back')).toHaveAttribute('data-has-actions', 'yes');
      expect(screen.getByTestId('meta-back')).toHaveAttribute('data-to', '/employee/profile');
      expect(screen.getByTestId('meta-back')).toHaveAttribute('data-label', 'Account settings');
    });
  });

  it('shows toolbar back link to admin profile on admin route', async () => {
    renderChangePassword('/admin/change-password');

    await waitFor(() => {
      expect(screen.getByTestId('meta-back')).toHaveAttribute('data-to', '/admin/profile');
    });
  });

  it('hides toolbar back link during forced first-login password change', async () => {
    mockUser = {
      hasPassword: true,
      hasPin: false,
      mustChangePassword: true,
    };

    renderChangePassword('/employee/change-password');

    await waitFor(() => {
      expect(screen.getByTestId('meta-back')).toHaveAttribute('data-has-actions', 'no');
    });
  });
});
