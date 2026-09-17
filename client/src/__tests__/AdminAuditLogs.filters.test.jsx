import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminAuditLogs from '../pages/admin/AdminAuditLogs.jsx';

vi.mock('../services/api.js', () => ({
  adminApi: {
    listAuditLogs: vi.fn(() =>
      Promise.resolve({
        logs: [
          {
            id: 'log1',
            action: 'leave_request_approved',
            email: 'manager@test.example',
            role: 'admin',
            module: 'leave',
            recordId: '507f1f77bcf86cd799439011',
            status: 'success',
            reason: 'n/a',
            timestamp: '2026-09-15T10:00:00.000Z',
            ipConflict: false,
            conflictWithUsers: [],
          },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      }),
    ),
    exportAuditLogs: vi.fn(() => Promise.resolve(new Blob(['x']))),
    getAuditArchiveStatus: vi.fn(() =>
      Promise.resolve({ oldestRetainedAt: null, archivedMonths: [], storage: 'local:./var' }),
    ),
    runAuditArchive: vi.fn(() => Promise.resolve({ archivedEntries: 0, prunedEntries: 0 })),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

import { adminApi } from '../services/api.js';

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function setup() {
  render(
    <StrictMode>
      <AdminAuditLogs />
    </StrictMode>,
  );
}

describe('AdminAuditLogs filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders module and record columns with resolved values', async () => {
    setup();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Module')).toBeInTheDocument();
    expect(within(table).getByText('Record')).toBeInTheDocument();
    expect(within(table).getByText('Leave')).toBeInTheDocument();
    expect(within(table).getByTitle('507f1f77bcf86cd799439011')).toBeInTheDocument();
  });

  it('applies module instantly and debounces unified search text', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('table');

    await user.click(screen.getByRole('combobox', { name: /module filter/i }));
    await user.click(await screen.findByRole('option', { name: 'Leave' }));
    await waitFor(() => {
      expect(adminApi.listAuditLogs).toHaveBeenLastCalledWith(
        expect.objectContaining({ module: 'leave' }),
      );
    });

    // One search box covers email, user ID, and record ID (server `q` param);
    // the old per-field boxes are gone.
    expect(screen.queryByLabelText(/search by employee/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/search by record id/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/search audit logs/i), 'manager@test.example');
    await waitFor(
      () => {
        expect(adminApi.listAuditLogs).toHaveBeenLastCalledWith(
          expect.objectContaining({ module: 'leave', q: 'manager@test.example' }),
        );
      },
      { timeout: 3000 },
    );
  });

  it('advertises action, module, and date coverage in the search box', async () => {
    setup();
    await screen.findByRole('table');
    expect(screen.getByPlaceholderText(/action, module, or date/i)).toBeInTheDocument();
  });

  it('passes conflictsOnly through to the export call', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('table');

    await user.click(screen.getByRole('checkbox', { name: /conflicts only/i }));
    await waitFor(() => {
      expect(adminApi.listAuditLogs).toHaveBeenLastCalledWith(
        expect.objectContaining({ conflictsOnly: 'true' }),
      );
    });
    await user.click(screen.getByRole('button', { name: 'Excel' }));

    await waitFor(() => {
      expect(adminApi.exportAuditLogs).toHaveBeenCalledWith(
        expect.objectContaining({ conflictsOnly: true, format: 'xlsx' }),
      );
    });
  });

  it('passes active filters to the export call', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('table');

    await user.type(screen.getByLabelText(/search audit logs/i), 'manager@test.example');
    await waitFor(
      () => {
        expect(adminApi.listAuditLogs).toHaveBeenLastCalledWith(
          expect.objectContaining({ q: 'manager@test.example' }),
        );
      },
      { timeout: 3000 },
    );
    await user.click(screen.getByRole('button', { name: 'Excel' }));

    await waitFor(() => {
      expect(adminApi.exportAuditLogs).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'manager@test.example', format: 'xlsx' }),
      );
    });
  });
});
