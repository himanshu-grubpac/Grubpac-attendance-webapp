import { Fragment, useRef, useState } from 'react';
import { MAX_BULK_UPLOAD_ROWS } from '@shared/validation/common.js';
import { EMPLOYEE_CODE_FORMAT_HINT } from '@shared/validation/employee.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useToast } from '../../context/ToastContext.jsx';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = ['.xlsx', '.xls'];

const BULK_REGULATIONS = [
  'Two-step flow: upload first generates a review table — nothing changes until you Confirm & Sync in the popup.',
  'Download the template first — it contains ALL current employees (active and inactive).',
  'Rows are matched by "email": an email matching an existing employee UPDATES that record. A new email CREATES a new employee.',
  'The "email" column is the employee identifier. Do NOT edit email values.',
  '"email", "mobile", and "employeeCode" are IMMUTABLE via bulk import. Changing mobile or employeeCode fails that row with a validation error naming the employee — except a malformed stored mobile, which is healed when the file carries a valid 10-digit replacement.',
  'To change email or mobile, use the individual employee edit page instead.',
  'There are no password or PIN columns. New employees get an auto-generated password (Firstname@EmpCode, e.g. Kenny@EMP108), are emailed their login credentials individually, and must change the temporary password on first sign-in. Passwords remain visible in the sync results for any email that fails delivery.',
  'New employees REQUIRE: firstName, lastName, email, mobile, joiningDate, designation, role, department, and reportingManagerEmail. Pick the role from the dropdown list in the role column.',
  '"role" changes apply to existing employees too (admin accounts are never touched by bulk import). Reporting-manager works on direct-reports scope; assign managed departments from the user edit page for wider team visibility.',
  'Leave "employeeCode" BLANK to auto-generate it (EMP001, EMP002, …). A filled-in code is kept when valid and unused.',
  `employeeCode format: ${EMPLOYEE_CODE_FORMAT_HINT}`,
  'First name must be 2–50 characters; last name is optional and must be at most 50 characters.',
  'Designation is required and must be at most 100 characters.',
  'Email must be valid (max 254 chars) and unique across the system for new employees.',
  'Mobile must be a valid 10-digit Indian number (starting with 6–9) and unique for new employees.',
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

function SummaryPills({ summary }) {
  if (!summary) return null;
  return (
    <div className="summary-row">
      <span className="stat-pill">Total: {summary.total}</span>
      <span className="stat-pill stat-pill--success">
        Created: {summary.created}
      </span>
      <span className="stat-pill stat-pill--info">
        Updated: {summary.updated}
      </span>
      <span className="stat-pill stat-pill--muted">
        Unchanged: {summary.unchanged}
      </span>
      <span className="stat-pill stat-pill--warning">
        Duplicate: {summary.duplicate}
      </span>
      <span className="stat-pill stat-pill--error">
        Errors: {(summary.validation_error || 0) + (summary.error || 0)}
      </span>
      {(summary.emailsSent || summary.emailsFailed) ? (
        <>
          <span className="stat-pill stat-pill--success">
            Emails sent: {summary.emailsSent || 0}
          </span>
          <span className="stat-pill stat-pill--error">
            Emails failed: {summary.emailsFailed || 0}
          </span>
        </>
      ) : null}
    </div>
  );
}

function FileWarnings({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <div className="alert alert--warning small" role="note">
      <strong>File warnings:</strong>
      <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

function ResultsTable({ result, expandedRow, onToggleRow, copiedRow, onCopyPassword }) {
  return (
    <div className="table-wrap table-wrap--responsive">
      <table className="table">
        <thead>
          <tr>
            <th>Row</th>
            <th>Status</th>
            <th>Email</th>
            <th>Password</th>
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
                  onClick={hasDetails ? () => onToggleRow(row.rowNumber) : undefined}
                  onKeyDown={
                    hasDetails
                      ? (event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onToggleRow(row.rowNumber);
                          }
                        }
                      : undefined
                  }
                  tabIndex={hasDetails ? 0 : undefined}
                  role={hasDetails ? 'button' : undefined}
                  aria-expanded={hasDetails ? isExpanded : undefined}
                  aria-label={
                    hasDetails
                      ? `Row ${row.rowNumber} field changes, activate to ${
                          isExpanded ? 'collapse' : 'expand'
                        }`
                      : undefined
                  }
                >
                  <td data-label="Row">{row.rowNumber}</td>
                  <td data-label="Status">
                    <span className={statusPillClass(row.status)}>{row.status}</span>
                  </td>
                  <td data-label="Email">{row.email || '—'}</td>
                  <td data-label="Password">
                    {row.status === 'created' && row.generatedPassword ? (
                      <span className="bulk-upload__password">
                        <code>{row.generatedPassword}</code>{' '}
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            onCopyPassword(row.rowNumber, row.generatedPassword);
                          }}
                        >
                          {copiedRow === row.rowNumber ? 'Copied' : 'Copy'}
                        </button>
                        {row.emailStatus ? (
                          <span
                            className={`stat-pill ${row.emailStatus === 'sent' ? 'stat-pill--success' : 'stat-pill--error'}`}
                            style={{ marginLeft: '0.5rem' }}
                          >
                            Email {row.emailStatus}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
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
                    <td colSpan={6}>
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
  );
}

export default function AdminBulkUpload() {
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const { showSuccess } = useToast();
  const fileInputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [expandedRow, setExpandedRow] = useState(null);
  const [copiedRow, setCopiedRow] = useState(null);

  function clearFileSelection() {
    setFile(null);
    setPreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function applySelectedFile(nextFile) {
    setError('');
    setResult(null);
    setPreview(null);
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

  async function handlePreview(event) {
    event.preventDefault();
    if (!file) {
      setError('Please choose an Excel file before uploading.');
      return;
    }

    // Step 1 — dry run: review every change before anything is applied.
    setPreviewing(true);
    setError('');
    setPreview(null);
    setResult(null);
    setExpandedRow(null);
    try {
      const data = await adminApi.bulkPreview(file);
      setPreview(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirmSync() {
    if (!file || !preview) return;
    const summary = preview.summary ?? {};
    const errorCount = (summary.validation_error || 0) + (summary.error || 0);
    await requestConfirm({
      title: 'Sync reviewed changes?',
      message:
        `Apply "${file.name}"? ${summary.created || 0} to create, ` +
        `${summary.updated || 0} to update` +
        (errorCount > 0 ? `, ${errorCount} row(s) will be skipped with errors` : '') +
        `. New accounts get auto-generated passwords and emailed login credentials.`,
      confirmLabel: 'Sync',
      variant: 'danger',
      onConfirm: async () => {
        setLoading(true);
        setError('');
        setExpandedRow(null);
        try {
          const data = await adminApi.bulkUpload(file);
          setResult(data);
          setPreview(null);
          clearFileSelection();
          const summary = data?.summary ?? {};
          const errorCount = (summary.validation_error || 0) + (summary.error || 0);
          showSuccess(
            `Sync complete — ${summary.created || 0} created, ${summary.updated || 0} updated` +
              (errorCount > 0 ? `, ${errorCount} row(s) skipped with errors` : '') +
              '.',
          );
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

  async function copyGeneratedPassword(rowNumber, password) {
    try {
      await navigator.clipboard.writeText(password);
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = password;
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      document.body.removeChild(fallback);
    }
    setCopiedRow(rowNumber);
    window.setTimeout(() => {
      setCopiedRow((current) => (current === rowNumber ? null : current));
    }, 2000);
  }

  const canUpload = Boolean(file) && !loading && !previewing;

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
                Drag and drop your updated spreadsheet or browse to select a file. Changes are
                previewed for review first — nothing is applied until you confirm and sync.
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

      {preview ? (
        <section className="bulk-upload__results card" aria-labelledby="bulk-preview-title">
          <h2 id="bulk-preview-title" className="bulk-upload__results-title">
            Review changes — nothing applied yet
          </h2>
          <p className="alert alert--warning small" role="note">
            This is a dry run of “{file?.name ?? 'the uploaded file'}”. No employee records
            were changed and no emails were sent. Review every row, then Confirm &amp; Sync to
            apply.
          </p>
          <FileWarnings warnings={preview.warnings} />
          <SummaryPills summary={preview.summary} />
          <ResultsTable
            result={preview}
            expandedRow={expandedRow}
            onToggleRow={toggleRowExpand}
            copiedRow={copiedRow}
            onCopyPassword={copyGeneratedPassword}
          />
          <div className="form-actions" style={{ marginTop: '1rem' }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={clearFileSelection}
              disabled={loading}
            >
              Discard
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleConfirmSync}
              disabled={loading || !file}
            >
              {loading ? 'Syncing…' : 'Confirm & Sync'}
            </button>
          </div>
        </section>
      ) : null}

      {result ? (
        <section className="bulk-upload__results card" aria-labelledby="bulk-results-title">
          <h2 id="bulk-results-title" className="bulk-upload__results-title">
            Sync results
          </h2>
          {result.summary.created > 0 ? (
            <p className="alert alert--warning small" role="note">
              {result.summary.created} new account{result.summary.created === 1 ? '' : 's'} created.
              Generated passwords are shown only here — copy each one and share it with its
              employee securely.
            </p>
          ) : null}
          <FileWarnings warnings={result.warnings} />
          <SummaryPills summary={result.summary} />
          <ResultsTable
            result={result}
            expandedRow={expandedRow}
            onToggleRow={toggleRowExpand}
            copiedRow={copiedRow}
            onCopyPassword={copyGeneratedPassword}
          />
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
        ) : preview ? (
          <p className="bulk-upload__footer-note muted small" role="status">
            Review the changes above, then Confirm &amp; Sync to apply them — or Discard to
            start over.
          </p>
        ) : (
          <>
            <p className="bulk-upload__footer-note muted small">
              Download the employee directory, make changes, and upload to review. Existing
              employees are matched by email. New emails create new accounts after you confirm.
            </p>
            <form onSubmit={handlePreview}>
              <button type="submit" className="btn btn-primary bulk-upload__submit" disabled={!canUpload}>
                {previewing ? (
                  <>
                    <span className="spinner spinner--sm" aria-hidden="true" />
                    Reviewing…
                  </>
                ) : (
                  'Upload & Review'
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
