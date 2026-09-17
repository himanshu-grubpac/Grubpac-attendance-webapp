import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import AdminAuditLogs from '../pages/admin/AdminAuditLogs.jsx';

vi.mock('../services/api.js', () => ({
  adminApi: {
    listAuditLogs: vi.fn(() =>
      Promise.resolve({
        logs: [
          // Legacy row with no actor, status, reason, device, ip or record.
          {
            id: 'legacy1',
            action: 'lop_exported',
            email: null,
            role: null,
            userId: null,
            module: 'salary',
            recordId: null,
            status: null,
            reason: null,
            deviceId: null,
            userAgent: null,
            ip: null,
            timestamp: '2026-09-16T10:00:00.000Z',
            ipConflict: false,
            conflictWithUsers: [],
          },
          // Failed login keeps the attempted credential in metadata.
          {
            id: 'failed1',
            action: 'login_failed',
            email: null,
            role: null,
            userId: null,
            module: 'authentication',
            recordId: null,
            status: 'failed',
            reason: 'bad_password',
            deviceId: null,
            userAgent: null,
            ip: null,
            metadata: { identifier: 'ghost@example.com' },
            timestamp: '2026-09-16T10:01:00.000Z',
            ipConflict: false,
            conflictWithUsers: [],
          },
          // Actor known by id only (e.g. deleted user, pre-backfill row).
          {
            id: 'orphan1',
            action: 'logout',
            email: null,
            role: null,
            userId: '507f1f77bcf86cd799439011',
            module: 'authentication',
            recordId: null,
            status: null,
            reason: null,
            deviceId: null,
            userAgent: null,
            ip: null,
            timestamp: '2026-09-16T10:02:00.000Z',
            ipConflict: false,
            conflictWithUsers: [],
          },
        ],
        pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
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

describe('AdminAuditLogs empty-field fallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('labels actor-less rows as System instead of blank cells', async () => {
    setup();
    await screen.findByRole('table');
    expect(screen.getAllByText('System')).toHaveLength(2);
  });

  it('shows the attempted credential for failed logins and Unknown user for orphaned actors', async () => {
    setup();
    await screen.findByRole('table');
    expect(screen.getByText('ghost@example.com')).toBeInTheDocument();
    expect(screen.getByText('Unknown user')).toBeInTheDocument();
  });

  it('never renders a blank status, reason, record, device or ip cell', async () => {
    setup();
    const table = await screen.findByRole('table');
    expect(table.querySelectorAll('td')).not.toHaveLength(0);
    // Legacy + orphaned rows: unknown outcome, recorded as such — never blank.
    expect(screen.getAllByText('UNKNOWN')).toHaveLength(2);
    expect(screen.getByText('FAILED')).toBeInTheDocument();
    expect(screen.getByText('bad_password')).toBeInTheDocument();
    // Record column: events without a record read n/a.
    expect(screen.getAllByText('n/a')).toHaveLength(3);
    // No cell anywhere still renders the blank placeholder.
    const blanks = Array.from(table.querySelectorAll('tbody td')).filter(
      (cell) => cell.textContent === '—',
    );
    expect(blanks).toHaveLength(0);
  });
});
