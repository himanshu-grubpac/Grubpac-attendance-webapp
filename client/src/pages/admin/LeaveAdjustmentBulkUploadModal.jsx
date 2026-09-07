import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { adminApi, getErrorMessage, leaveApi } from '../../services/api.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = ['.xlsx', '.xls'];

const BULK_RULES = [
  'Download the prefilled sheet first — it contains employees with live Entitled, Used, and Remaining values for the policy year.',
  'Fill the Carry columns and the reason column only. Do NOT edit pre-filled Entitled, Used, or Remaining columns.',
  'Each filled Carry cell becomes one carry entry for that employee, leave type, and target year. Rows with a blank Carry are skipped.',
  'employeeCode and leave type columns identify each record. Do not rename leave type group headers like "Casual Leave (CL)".',
  'Carried days must be 0–365. Reason is optional and is recorded in audit history.',
  'Duplicate employee + leave type + year rows inside the same file are reported without action.',
  'File must be Excel (.xlsx or .xls), up to 5 MB.',
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
  if (status === 'success') return 'stat-pill stat-pill--success';
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

export default function LeaveAdjustmentBulkUploadModal({
  open,
  onClose,
  policyYear,
  departmentId,
  onImported,
}) {
  const modalTitleId = useId();
  const { showSuccess } = useToast();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const fileInputRef = useRef(null);

  const balanceYear = Number(policyYear);
  const fromYear = Number.isFinite(balanceYear) ? balanceYear - 1 : null;
  const toYear = Number.isFinite(balanceYear) ? balanceYear : null;

  const [departments, setDepartments] = useState([]);
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const busy = downloadingTemplate || uploading;

  const resetTransientState = useCallback(() => {
    setFile(null);
    setResult(null);
    setError('');
    setIsDragging(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const closeModal = useCallback(() => {
    if (busy) return;
    resetTransientState();
    onClose();
  }, [busy, onClose, resetTransientState]);

  useEscapeKey(open && !busy, closeModal);

  useEffect(() => {
    if (!open) return;
    resetTransientState();
  }, [open, policyYear, departmentId, resetTransientState]);

  useEffect(() => {
    if (!open) return;
    adminApi
      .listDepartments()
      .then((data) => setDepartments(data.departments ?? []))
      .catch(() => setDepartments([]));
  }, [open]);

  const departmentName = departmentId
    ? (departments.find((item) => item.id === departmentId)?.name ?? 'Selected department')
    : 'All departments';

  function clearFileSelection() {
    setFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function applySelectedFile(nextFile) {
    setError('');
    setResult(null);

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

  async function handleDownloadTemplate() {
    if (!Number.isFinite(balanceYear)) {
      setError('Select a valid policy year before downloading the sheet.');
      return;
    }
    setDownloadingTemplate(true);
    setError('');
    try {
      const blob = await leaveApi.downloadCarryTemplate({
        year: balanceYear,
        fromYear,
        toYear,
        ...(departmentId ? { departmentId } : {}),
      });
      downloadBlob(blob, `carried-leave-template-${fromYear}-${toYear}.xlsx`);
      showSuccess('Prefilled sheet downloaded.');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDownloadingTemplate(false);
    }
  }

  async function handleUpload() {
    if (!file) {
      setError('Please choose an Excel file before uploading.');
      return;
    }

    await requestConfirm({
      title: 'Upload and apply carried leave?',
      message: `Import "${file.name}"? Filled Carry values will update carried balances for policy year ${toYear}. This action is logged in audit history.`,
      confirmLabel: 'Upload & Apply',
      variant: 'danger',
      onConfirm: async () => {
        setUploading(true);
        setError('');
        setResult(null);
        try {
          const data = await leaveApi.uploadCarryBulk(file);
          setResult(data);
          clearFileSelection();
          const applied = data?.summary?.success ?? 0;
          if (applied > 0) {
            showSuccess(`Applied ${applied} carried leave entr${applied === 1 ? 'y' : 'ies'}.`);
            try {
              await onImported?.();
            } catch {
              // Grid refresh failure must not hide successful import results.
            }
          }
        } catch (err) {
          setError(getErrorMessage(err));
        } finally {
          setUploading(false);
        }
      },
    });
  }

  if (!open) {
    return null;
  }

  const summary = result?.summary ?? null;

  return createPortal(
    <div className="modal__backdrop" role="presentation" onClick={closeModal}>
      <div
        className="modal modal--wide leave-policies-modal leave-carry-bulk-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={modalTitleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header leave-carry-forward-modal__header">
          <div className="leave-carry-forward-modal__header-top">
            <div className="leave-carry-forward-modal__header-titles">
              <h2 id={modalTitleId} className="modal__title">
                Bulk upload carried leave ({toYear})
              </h2>
              <p className="modal__lead muted">
                Download the prefilled sheet for policy year {toYear} (carry {fromYear} →{' '}
                {toYear}, scope: {departmentName}), edit Carry values or add rows, then upload.
                The system validates each row and applies differences.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost leave-carry-forward-modal__close"
              onClick={closeModal}
              disabled={busy}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>

        <div className="modal__body leave-policies-modal__body leave-carry-bulk-modal__body">
          {error ? <div className="alert alert--error modal__alert">{error}</div> : null}

          <section aria-labelledby={`${modalTitleId}-step-1`}>
            <h3 id={`${modalTitleId}-step-1`} className="label">
              Step 1 — Download prefilled sheet
            </h3>
            <p className="muted small">
              Sheet is prefilled for balance year {toYear}. Only Carry and reason cells are
              editable.
            </p>
            <button
              type="button"
              className="btn btn-outline-primary bulk-upload__download-btn"
              onClick={handleDownloadTemplate}
              disabled={busy}
            >
              {downloadingTemplate ? (
                <>
                  <span className="spinner spinner--sm" aria-hidden="true" />
                  Downloading…
                </>
              ) : (
                'Download Prefilled Sheet'
              )}
            </button>
          </section>

          <section aria-labelledby={`${modalTitleId}-step-2`}>
            <h3 id={`${modalTitleId}-step-2`} className="label">
              Step 2 — Upload updated file
            </h3>
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
                  <p className="bulk-upload__dropzone-title">
                    Drag &amp; drop updated spreadsheet here
                  </p>
                  <p className="bulk-upload__dropzone-hint muted small">
                    Accepts .xlsx, .xls · Max 5 MB
                  </p>
                </>
              )}
            </div>
            <button
              type="button"
              className="btn bulk-upload__browse-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              Browse Files
            </button>
          </section>

          <section aria-label="Bulk upload rules">
            <h3 className="label">Rules</h3>
            <ul className="bulk-upload__regulations-list">
              {BULK_RULES.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </section>

          {result ? (
            <section aria-label="Import results">
              <h3 className="label">Import results</h3>
              {summary ? (
                <div className="summary-row">
                  <span className="stat-pill">Total: {summary.total}</span>
                  <span className="stat-pill stat-pill--success">
                    Applied: {summary.success}
                  </span>
                  <span className="stat-pill stat-pill--warning">
                    Duplicate: {summary.duplicate}
                  </span>
                  <span className="stat-pill stat-pill--error">
                    Errors: {(summary.validation_error || 0) + (summary.error || 0)}
                  </span>
                  <span className="stat-pill stat-pill--muted">
                    Skipped: {summary.skipped}
                  </span>
                </div>
              ) : null}
              <div className="table-wrap table-wrap--responsive">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Status</th>
                      <th>Employee</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(result.results ?? []).map((row) => (
                      <tr key={`${row.rowNumber}-${row.employeeCode}`}>
                        <td data-label="Row">{row.rowNumber}</td>
                        <td data-label="Status">
                          <span className={statusPillClass(row.status)}>{row.status}</span>
                        </td>
                        <td data-label="Employee">
                          {row.employeeName || row.employeeCode
                            ? `${row.employeeName ?? ''}${row.employeeName && row.employeeCode ? ` (${row.employeeCode})` : (row.employeeCode ?? '')}`
                            : '—'}
                        </td>
                        <td data-label="Message">{row.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>

        <footer className="modal__footer">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={closeModal}
            disabled={busy}
          >
            {result ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleUpload}
            disabled={busy || !file}
          >
            {uploading ? (
              <>
                <span className="spinner spinner--sm" aria-hidden="true" />
                Uploading…
              </>
            ) : (
              'Upload & Apply'
            )}
          </button>
        </footer>
      </div>

      {confirmDialog}
    </div>,
    document.body,
  );
}
