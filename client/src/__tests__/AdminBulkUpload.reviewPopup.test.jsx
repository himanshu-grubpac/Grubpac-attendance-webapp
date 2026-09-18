import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../context/ToastContext.jsx';
import AdminBulkUpload from '../pages/admin/AdminBulkUpload.jsx';

const previewPayload = {
  summary: { total: 1, created: 1, updated: 0, unchanged: 0, duplicate: 0 },
  warnings: [],
  results: [
    {
      rowNumber: 2,
      status: 'created',
      email: 'new@test.example',
      generatedPassword: 'New@EMP1',
      message: 'Will create this employee on sync.',
    },
  ],
};

const syncPayload = {
  summary: { total: 1, created: 1, updated: 0, unchanged: 0, duplicate: 0 },
  warnings: [],
  results: [
    {
      rowNumber: 2,
      status: 'created',
      email: 'new@test.example',
      generatedPassword: 'New@EMP1',
      message: 'Employee created.',
    },
  ],
};

vi.mock('../services/api.js', () => ({
  adminApi: {
    downloadTemplate: vi.fn(() => Promise.resolve(new Blob(['x']))),
    bulkPreview: vi.fn(() => Promise.resolve(previewPayload)),
    bulkUpload: vi.fn(() => Promise.resolve(syncPayload)),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

import { adminApi } from '../services/api.js';

function setup() {
  render(
    <StrictMode>
      <ToastProvider>
        <AdminBulkUpload />
      </ToastProvider>
    </StrictMode>,
  );
}

function pickFile() {
  const input = document.querySelector('.bulk-upload__file-input');
  const file = new File(['x'], 'staff.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

describe('AdminBulkUpload review popup flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('browse button flips to Upload & review after a file is picked; no footer trailing button', async () => {
    setup();
    expect(screen.getByRole('button', { name: 'Browse Files' })).toBeInTheDocument();
    // The old footer submit is gone entirely.
    expect(screen.queryByRole('button', { name: /upload & review/i })).not.toBeInTheDocument();

    pickFile();

    expect(
      await screen.findByRole('button', { name: 'Upload & review' }),
    ).toBeInTheDocument();
    // No Reviewing… label anywhere, before or after interaction.
    expect(screen.queryByText(/reviewing/i)).not.toBeInTheDocument();
  });

  it('upload & review opens a popup with the review table and sync action', async () => {
    const user = userEvent.setup();
    setup();
    pickFile();

    await user.click(await screen.findByRole('button', { name: 'Upload & review' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Review changes — nothing applied yet');
    expect(within(dialog).getByText('new@test.example')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Confirm & Sync' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Discard' }),
    ).toBeInTheDocument();
    expect(adminApi.bulkPreview).toHaveBeenCalledTimes(1);
  });

  it('sync inside the popup confirms and shows a footer message only', async () => {
    const user = userEvent.setup();
    setup();
    pickFile();
    await user.click(await screen.findByRole('button', { name: 'Upload & review' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Confirm & Sync' }));

    // Existing confirm step stacks above the review popup.
    const confirmBox = await screen.findByRole('alertdialog');
    expect(confirmBox).toHaveTextContent('Sync reviewed changes?');
    await user.click(within(confirmBox).getByRole('button', { name: 'Sync' }));

    await waitFor(() => {
      expect(adminApi.bulkUpload).toHaveBeenCalledTimes(1);
    });
    // Popup closes; no results section or row table after sync — only the
    // footer confirmation message (next upload starts from the dropzone).
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await screen.findByText(/Sync complete — 0 updated, 1 created/)).toBeInTheDocument();
    expect(screen.queryByText('Sync results')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upload another file/i })).not.toBeInTheDocument();
  });

  it('clean sync shows no results section; footer message still confirms', async () => {
    const user = userEvent.setup();
    adminApi.bulkUpload.mockResolvedValueOnce({
      summary: {
        total: 2,
        created: 0,
        updated: 0,
        unchanged: 2,
        duplicate: 0,
        validation_error: 0,
        error: 0,
      },
      warnings: [],
      results: [
        { rowNumber: 2, status: 'unchanged', email: 'a@test.example', message: 'No changes detected.' },
        { rowNumber: 3, status: 'unchanged', email: 'b@test.example', message: 'No changes detected.' },
      ],
    });
    setup();
    pickFile();
    await user.click(await screen.findByRole('button', { name: 'Upload & review' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm & Sync' }));
    const confirmBox = await screen.findByRole('alertdialog');
    await user.click(within(confirmBox).getByRole('button', { name: 'Sync' }));
    expect(await screen.findByText(/Sync complete — 0 updated, 0 created, 2 unchanged/)).toBeInTheDocument();
    expect(screen.queryByText('Sync results')).not.toBeInTheDocument();
    // Row-level noise stays hidden; footer message confirms instead.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('a@test.example')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upload another file/i })).not.toBeInTheDocument();
  });

  it('sync with errors still shows no results section; footer names the error count', async () => {
    const user = userEvent.setup();
    adminApi.bulkUpload.mockResolvedValueOnce({
      summary: {
        total: 2,
        created: 0,
        updated: 0,
        unchanged: 1,
        duplicate: 0,
        validation_error: 1,
        error: 0,
      },
      warnings: [],
      results: [
        { rowNumber: 2, status: 'unchanged', email: 'a@test.example', message: 'No changes detected.' },
        { rowNumber: 3, status: 'validation_error', email: 'bad', message: 'Valid email is required.' },
      ],
    });
    setup();
    pickFile();
    await user.click(await screen.findByRole('button', { name: 'Upload & review' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm & Sync' }));
    const confirmBox = await screen.findByRole('alertdialog');
    await user.click(within(confirmBox).getByRole('button', { name: 'Sync' }));
    expect(await screen.findByText(/Sync complete — 0 updated, 0 created, 1 unchanged, 1 with errors/)).toBeInTheDocument();
    expect(screen.queryByText('Sync results')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upload another file/i })).not.toBeInTheDocument();
  });

  it('discard closes the popup and clears the file', async () => {    const user = userEvent.setup();
    setup();
    pickFile();
    await user.click(await screen.findByRole('button', { name: 'Upload & review' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Browse Files' })).toBeInTheDocument();
  });

  it('preview failure shows an error and never sticks on reviewing', async () => {
    const user = userEvent.setup();
    adminApi.bulkPreview.mockRejectedValueOnce(new Error('Bad file'));
    setup();
    pickFile();
    await user.click(await screen.findByRole('button', { name: 'Upload & review' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Bad file');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Button is back to its idle label — never stuck on a busy label.
    expect(screen.getByRole('button', { name: 'Upload & review' })).toBeInTheDocument();
    expect(screen.queryByText(/reviewing/i)).not.toBeInTheDocument();
  });
});
