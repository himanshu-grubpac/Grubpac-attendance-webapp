import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../context/ToastContext.jsx';
import LeaveAdjustmentBulkUploadModal from '../pages/admin/LeaveAdjustmentBulkUploadModal.jsx';

const previewPayload = {
  summary: {
    total: 1,
    preview: 1,
    success: 0,
    duplicate: 0,
    validation_error: 0,
    error: 0,
    skipped: 0,
    dryRun: true,
  },
  results: [
    {
      rowNumber: 7,
      status: 'preview',
      employeeCode: 'EMP001',
      employeeName: 'Jane Doe',
      leaveTypeCode: 'CL',
      carriedDays: 2,
      message: 'Would set 2 carried day(s) for 2026.',
    },
  ],
};

vi.mock('../services/api.js', () => ({
  adminApi: {
    listDepartments: vi.fn(() => Promise.resolve({ departments: [] })),
  },
  leaveApi: {
    downloadCarryTemplate: vi.fn(() => Promise.resolve(new Blob(['x']))),
    previewCarryBulk: vi.fn(() => Promise.resolve(previewPayload)),
    uploadCarryBulk: vi.fn(() =>
      Promise.resolve({
        summary: { total: 1, success: 1, duplicate: 0, validation_error: 0, error: 0, skipped: 0 },
        results: [{ rowNumber: 7, status: 'success', employeeCode: 'EMP001', message: 'Applied.' }],
      }),
    ),
  },
  getErrorMessage: (err) => err?.message ?? 'Something went wrong.',
}));

vi.mock('../hooks/useConfirmDialog.jsx', () => ({
  useConfirmDialog: () => ({
    requestConfirm: ({ onConfirm }) => {
      void onConfirm();
      return Promise.resolve(true);
    },
    dialog: null,
  }),
}));

import { leaveApi } from '../services/api.js';

function pickFile() {
  const input = document.querySelector('.bulk-upload__file-input');
  const file = new File(['x'], 'carry.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  fireEvent.change(input, { target: { files: [file] } });
}

function setup() {
  render(
    <ToastProvider>
      <LeaveAdjustmentBulkUploadModal
        open
        onClose={vi.fn()}
        policyYear={2026}
        departmentId=""
        onImported={vi.fn()}
      />
    </ToastProvider>,
  );
}

describe('LeaveAdjustmentBulkUploadModal preview flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows preview table before apply', async () => {
    const user = userEvent.setup();
    setup();
    pickFile();

    await user.click(await screen.findByRole('button', { name: /review upload/i }));

    await waitFor(() => {
      expect(leaveApi.previewCarryBulk).toHaveBeenCalled();
    });
    expect(screen.getByText(/preview — nothing applied yet/i)).toBeInTheDocument();
    expect(screen.getByText('Jane Doe (EMP001)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm apply \(1\)/i })).toBeInTheDocument();
  });
});
