import { useState } from 'react';
import { MAX_BULK_UPLOAD_ROWS } from '@shared/validation/common.js';
import PasswordGeneratorPanel from '../../components/PasswordGeneratorPanel.jsx';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function statusPillClass(status) {
  if (status === 'success') return 'stat-pill stat-pill--success';
  if (status === 'duplicate') return 'stat-pill stat-pill--warning';
  if (status === 'validation_error' || status === 'error') return 'stat-pill stat-pill--error';
  return 'stat-pill';
}

export default function AdminBulkUpload() {
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function downloadTemplate() {
    try {
      const blob = await adminApi.downloadTemplate();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'employee-registration-template.xlsx';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleUpload(event) {
    event.preventDefault();
    if (!file) {
      setError('Please choose an Excel file.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('File must be 5 MB or smaller.');
      return;
    }

    await requestConfirm({
      title: 'Upload and register employees?',
      message: `Import “${file.name}”? Valid rows will create employee accounts immediately.`,
      confirmLabel: 'Upload & Register',
      variant: 'danger',
      onConfirm: async () => {
        setLoading(true);
        setError('');
        setResult(null);
        try {
          const data = await adminApi.bulkUpload(file);
          setResult(data);
          setFile(null);
          event.target.reset();
        } finally {
          setLoading(false);
        }
      },
    });
  }

  return (
    <div className="page page--form">
      <div className="card">
        <p className="card__section-title">Get started</p>
        <p className="card__lead">
          Download the template, fill employee rows, and upload. Maximum{' '}
          {MAX_BULK_UPLOAD_ROWS} rows per file. Each row is validated and registered
          individually.
        </p>
        <div className="card__actions-row">
          <button type="button" className="btn" onClick={downloadTemplate}>
            ↓ Download Excel Template
          </button>
        </div>
        <PasswordGeneratorPanel />
      </div>

      <div className="card">
        <p className="card__section-title">Upload file</p>
        <form className="form-stack" onSubmit={handleUpload}>
          <label>
            Excel file (.xlsx / .xls, max 5 MB)
            <input
              className="input input--file"
              type="file"
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="form-actions form-actions--sticky">
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? (
                <>
                  <span className="spinner spinner--sm" aria-hidden="true" />
                  Uploading…
                </>
              ) : (
                'Upload & Register'
              )}
            </button>
          </div>
        </form>
        {error && <div className="alert alert--error alert--inset">{error}</div>}
      </div>

      {result && (
        <div className="card">
          <p className="card__section-title">Upload results</p>
          <div className="summary-row">
            <span className="stat-pill">Total: {result.summary.total}</span>
            <span className="stat-pill stat-pill--success">
              Success: {result.summary.success}
            </span>
            <span className="stat-pill stat-pill--warning">
              Duplicate: {result.summary.duplicate}
            </span>
            <span className="stat-pill">
              Validation: {result.summary.validation_error}
            </span>
            <span className="stat-pill stat-pill--error">
              Error: {result.summary.error}
            </span>
          </div>
          <div className="table-wrap table-wrap--responsive">
            <table className="table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Status</th>
                  <th>Email</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((row) => (
                  <tr key={`${row.rowNumber}-${row.email}`}>
                    <td data-label="Row">{row.rowNumber}</td>
                    <td data-label="Status">
                      <span className={statusPillClass(row.status)}>{row.status}</span>
                    </td>
                    <td data-label="Email">{row.email || '—'}</td>
                    <td data-label="Message">{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {confirmDialog}
    </div>
  );
}
