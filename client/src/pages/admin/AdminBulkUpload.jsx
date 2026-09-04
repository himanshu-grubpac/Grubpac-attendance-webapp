import { Fragment, useRef, useState } from 'react';
import { MAX_BULK_UPLOAD_ROWS } from '@shared/validation/common.js';
import { EMPLOYEE_CODE_FORMAT_HINT } from '@shared/validation/employee.js';
import PasswordGeneratorPanel from '../../components/PasswordGeneratorPanel.jsx';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = ['.xlsx', '.xls'];

const BULK_REGULATIONS = [
  'Download the template first — it contains ALL current employees (active and inactive) with their unique employee id.',
  'Rows with an "id" value will UPDATE the matching employee record. Rows with a BLANK "id" will CREATE a new employee.',
  'The "id" column is the immutable employee identifier. Do NOT edit or delete id values — the system uses it to match records.',
  '"email" and "mobile" are IMMUTABLE via bulk import. Any changes to these fields in the uploaded file will be ignored.',
  'To change email or mobile, use the individual employee edit page instead.',
  '"password" and "pin" columns: leave BLANK to keep the existing password/pin. Fill them in ONLY to set new credentials.',
  'When a new employee is added (blank id), a typed password is REQUIRED: 8+ characters with uppercase, lowercase, and a number.',
  'When a new employee is added (blank id), firstName, email, mobile, designation, joiningDate, department, and reportingManagerEmail are also required.',
  '"pin4Digite" sets the 4-digit login PIN for new and existing employees. "pin6Digite" is ignored.',
  `Required columns for new employees: firstName, email, mobile, password, designation, joiningDate, reportingManagerEmail.`,
  `Optional columns: lastName, employeeCode, department, reportingManagerCode, dateOfBirth, endingDate, isActive.`,
  `employeeCode format: ${EMPLOYEE_CODE_FORMAT_HINT}`,
  'First name must be 2–50 characters; last name is optional and must be at most 50 characters.',
  'Designation is required and must be at most 100 characters.',
  'Email must be valid (max 254 chars) and unique across the system for new employees.',
  'Mobile must be a valid 10-digit Indian number (starting with 6–9) and unique for new employees.',
  'Password must be 8–128 characters with uppercase, lowercase, and a number.',
  'Dates must use YYYY-MM-DD format. endingDate and dateOfBirth are optional.',
  'isActive must be TRUE or FALSE.',
  `File must be Excel (.xlsx or .xls), up to 5 MB, with at most ${MAX_BULK_UPLOAD_ROWS} data rows.`,
  'Each row is validated individually. Duplicate email, mobile, or employee code rows in the same file are reported without action.',
];

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function statusPillClass(status) {
  if (status === 'success' || status === 'created') return 'stat-pill stat-pill--success';
  if (status === 'updated') return 'stat-pill stat-pill--info';
  if (status === 'unchanged') return 'stat-pill stat-pill--muted';
  if (status === 'duplicate') return 'stat-pill stat-pill--warning';
  if (status === 'validation_error' || status === 'error') return 'stat-pill stat-pill--error';
  return 'stat-pill';
}

function isAcceptedExcelFile(file) {
  if (!file) return false;
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3v12m0 0l4-4m-4 4l-4-4M5 21h14"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 16V4m0 0l-4 4m4-4l4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6M8 13h8M8 17h8M8 9h2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChangeDiff({ changedFields, ignoredFields }) {
  if (!changedFields?.length && !ignoredFields?.length) return null;

  return (
    <div className="bulk-upload__diff">
      {changedFields?.map((change) => (
        <span key={change.field} className="bulk-upload__diff-change">
          <strong>{change.field}</strong>: {change.from || '—'} → {change.to || '—'}
        </span>
      ))}
      {ignoredFields?.map((ignored) => (
        <span key={ignored.field} className="bulk-upload__diff-ignored">
          <strong>{ignored.field}</strong>: ignored (immutable)
        </span>
      ))}
    </div>
  );
}

export default function AdminBulkUpload() {
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const fileInputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [expandedRow, setExpandedRow] = useState(null);

  function clearFileSelection() {
    setFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function applySelectedFile(nextFile) {
    setError('');
    setResult(null);
    setExpandedRow(null);

    if (!nextFile) {
      clearFileSelection();
      return;
    }

    if (!isAcceptedExcelFile(nextFile)) {
      setError('Only Excel files (.xlsx or .xls) are allowed.');
      clearFileSelection();
      return;
    }

    if (nextFile.size > MAX_FILE_BYTES) {
      setError('File must be 5 MB or smaller.');
      clearFileSelection();
      return;
    }

    setFile(nextFile);
  }

  function handleFileInputChange(event) {
    applySelectedFile(event.target.files?.[0] ?? null);
  }

  function handleDragOver(event) {
    event.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(event) {
    event.preventDefault();
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setIsDragging(false);
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);
    applySelectedFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function downloadTemplate() {
    setDownloadingTemplate(true);
    setError('');
    try {
      const blob = await adminApi.downloadTemplate();
      downloadBlob(blob, 'employee-directory-export.xlsx');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDownloadingTemplate(false);
    }
  }

  async function handleUpload(event) {
    event.preventDefault();
    if (!file) {
      setError('Please choose an Excel file before uploading.');
      return;
    }

    await requestConfirm({
      title: 'Upload and sync employee data?',
      message: `Import "${file.name}"? Existing rows (with id) will be updated. New rows (blank id) will create employee accounts.`,
      confirmLabel: 'Upload & Sync',
      variant: 'danger',
      onConfirm: async () => {
        setLoading(true);
        setError('');
        setResult(null);
        setExpandedRow(null);
        try {
          const data = await adminApi.bulkUpload(file);
          setResult(data);
          clearFileSelection();
        } catch (err) {
          setError(getErrorMessage(err));
        } finally {
          setLoading(false);
        }
      },
    });
  }

  function toggleRowExpand(rowNumber) {
    setExpandedRow(expandedRow === rowNumber ? null : rowNumber);
  }

  const canUpload = Boolean(file) && !loading;

  return (
    <div className="page page--bulk-upload">
      {error ? (
        <div className="alert alert--error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="bulk-upload__steps">
        <section className="bulk-upload__step card" aria-labelledby="bulk-step-download-title">
          <header className="bulk-upload__step-header">
            <span className="bulk-upload__step-badge" aria-hidden="true">
              1
            </span>
            <div className="bulk-upload__step-heading">
              <h2 id="bulk-step-download-title" className="bulk-upload__step-title">
                Download Employee Directory
              </h2>
              <p className="bulk-upload__step-lead muted">
                Download the pre-filled spreadsheet containing all current employees (active and
                inactive). Edit rows, add new employees below, then upload the updated file to sync.
              </p>
            </div>
          </header>
          <button
            type="button"
            className="btn btn-outline-primary bulk-upload__download-btn"
            onClick={downloadTemplate}
            disabled={downloadingTemplate}
          >
            {downloadingTemplate ? (
              <>
                <span className="spinner spinner--sm" aria-hidden="true" />
                Downloading…
              </>
            ) : (
              <>
                <DownloadIcon />
                Download Employee Directory
              </>
            )}
          </button>
          <PasswordGeneratorPanel />
        </section>

        <section className="bulk-upload__step card" aria-labelledby="bulk-step-upload-title">
          <header className="bulk-upload__step-header">
            <span className="bulk-upload__step-badge" aria-hidden="true">
              2
            </span>
            <div className="bulk-upload__step-heading">
              <h2 id="bulk-step-upload-title" className="bulk-upload__step-title">
                Upload Updated File
              </h2>
              <p className="bulk-upload__step-lead muted">
                Drag and drop your updated spreadsheet or browse to select a file. Changes will be
                detected and applied automatically.
              </p>
            </div>
          </header>

          <div
            className={`bulk-upload__dropzone${isDragging ? ' bulk-upload__dropzone--active' : ''}${file ? ' bulk-upload__dropzone--has-file' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            role="button"
            tabIndex={0}
            aria-label="Upload Excel file"
          >
            <input
              ref={fileInputRef}
              className="bulk-upload__file-input"
              type="file"
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              onChange={handleFileInputChange}
              aria-hidden="true"
              tabIndex={-1}
            />

            {file ? (
              <div className="bulk-upload__file-preview">
                <span className="bulk-upload__file-icon" aria-hidden="true">
                  <FileIcon />
                </span>
                <div className="bulk-upload__file-meta">
                  <strong className="bulk-upload__file-name">{file.name}</strong>
                  <span className="bulk-upload__file-size muted small">
                    {formatFileSize(file.size)}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-sm bulk-upload__file-clear"
                  onClick={(event) => {
                    event.stopPropagation();
                    clearFileSelection();
                  }}
                >
                  Remove
                </button>
              </div>
            ) : (
              <>
                <span className="bulk-upload__dropzone-icon" aria-hidden="true">
                  <UploadIcon />
                </span>
                <p className="bulk-upload__dropzone-title">Drag &amp; drop updated spreadsheet here</p>
                <p className="bulk-upload__dropzone-hint muted small">
                  Accepts .xlsx, .xls · Max 5 MB · {MAX_BULK_UPLOAD_ROWS} rows
                </p>
              </>
            )}
          </div>

          <button
            type="button"
            className="btn bulk-upload__browse-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            Browse Files
          </button>
        </section>
      </div>

      <section
        className="bulk-upload__regulations card"
        aria-labelledby="bulk-regulations-title"
      >
        <h2 id="bulk-regulations-title" className="bulk-upload__regulations-title">
          Bulk Import Rules &amp; Data Constraints
        </h2>
        <ul className="bulk-upload__regulations-list">
          {BULK_REGULATIONS.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </section>

      {result ? (
        <section className="bulk-upload__results card" aria-labelledby="bulk-results-title">
          <h2 id="bulk-results-title" className="bulk-upload__results-title">
            Sync results
          </h2>
          <div className="summary-row">
            <span className="stat-pill">Total: {result.summary.total}</span>
            <span className="stat-pill stat-pill--success">
              Created: {result.summary.created}
            </span>
            <span className="stat-pill stat-pill--info">
              Updated: {result.summary.updated}
            </span>
            <span className="stat-pill stat-pill--muted">
              Unchanged: {result.summary.unchanged}
            </span>
            <span className="stat-pill stat-pill--warning">
              Duplicate: {result.summary.duplicate}
            </span>
            <span className="stat-pill stat-pill--error">
              Errors: {(result.summary.validation_error || 0) + (result.summary.error || 0)}
            </span>
          </div>
          <div className="table-wrap table-wrap--responsive">
            <table className="table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Status</th>
                  <th>Email</th>
                  <th>Changes</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((row) => {
                  const hasDetails = row.changedFields?.length || row.ignoredFields?.length;
                  const isExpanded = expandedRow === row.rowNumber;
                  return (
                    <Fragment key={row.rowNumber}>
                      <tr
                        className={hasDetails ? 'bulk-upload__row--expandable' : ''}
                        onClick={hasDetails ? () => toggleRowExpand(row.rowNumber) : undefined}
                      >
                        <td data-label="Row">{row.rowNumber}</td>
                        <td data-label="Status">
                          <span className={statusPillClass(row.status)}>{row.status}</span>
                        </td>
                        <td data-label="Email">{row.email || '—'}</td>
                        <td data-label="Changes">
                          {hasDetails ? (
                            <span className="bulk-upload__change-count muted small">
                              {row.changedFields?.length || 0} changed
                              {row.ignoredFields?.length
                                ? `, ${row.ignoredFields.length} ignored`
                                : ''}
                              {hasDetails ? (
                                <span className="bulk-upload__expand-icon" aria-hidden="true">
                                  {isExpanded ? '▾' : '▸'}
                                </span>
                              ) : null}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td data-label="Message">{row.message}</td>
                      </tr>
                      {hasDetails && isExpanded ? (
                        <tr className="bulk-upload__detail-row">
                          <td colSpan={5}>
                            <ChangeDiff
                              changedFields={row.changedFields}
                              ignoredFields={row.ignoredFields}
                            />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <footer className="bulk-upload__footer">
        {result && !file && !loading ? (
          <>
            <p className="bulk-upload__footer-note muted small" role="status">
              Sync complete — {result.summary.updated} updated, {result.summary.created} created,{' '}
              {result.summary.unchanged} unchanged
              {(result.summary.validation_error || 0) + (result.summary.error || 0) > 0
                ? `, ${(result.summary.validation_error || 0) + (result.summary.error || 0)} with errors`
                : ''}
              . Changes are live.
            </p>
            <button
              type="button"
              className="btn btn-outline-primary bulk-upload__submit"
              onClick={() => fileInputRef.current?.click()}
            >
              Upload another file
            </button>
          </>
        ) : (
          <>
            <p className="bulk-upload__footer-note muted small">
              Download the employee directory, make changes, and upload to sync. Existing employees
              are matched by the "id" column. New rows without an id create new accounts.
            </p>
            <form onSubmit={handleUpload}>
              <button type="submit" className="btn btn-primary bulk-upload__submit" disabled={!canUpload}>
                {loading ? (
                  <>
                    <span className="spinner spinner--sm" aria-hidden="true" />
                    Uploading…
                  </>
                ) : (
                  'Upload & Sync'
                )}
              </button>
            </form>
          </>
        )}
      </footer>

      {confirmDialog}
    </div>
  );
}
