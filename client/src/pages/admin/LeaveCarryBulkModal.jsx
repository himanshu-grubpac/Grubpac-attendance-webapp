import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { adminApi, getErrorMessage, leaveApi } from '../../services/api.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { useToast } from '../../context/ToastContext.jsx';
import FieldError from '../../components/FieldError.jsx';
import MultiSelectField from '../../components/MultiSelectField.jsx';
import SelectField from '../../components/SelectField.jsx';

const ALL_DEPARTMENTS_VALUE = '';

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

export default function LeaveCarryBulkModal({
  open,
  onClose,
  defaultYear,
  yearOptions,
}) {
  const modalTitleId = useId();
  const { showSuccess } = useToast();

  const [year, setYear] = useState(String(defaultYear));
  const [fromYear, setFromYear] = useState(String(Number(defaultYear) - 1));
  const [toYear, setToYear] = useState(String(defaultYear));
  const [departmentId, setDepartmentId] = useState(ALL_DEPARTMENTS_VALUE);
  const [departments, setDepartments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [selectedUserIds, setSelectedUserIds] = useState([]);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [employeeError, setEmployeeError] = useState('');
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(null);

  const resetTransientState = useCallback(() => {
    setError('');
    setEmployeeError('');
  }, []);

  const closeModal = useCallback(() => {
    if (downloading) return;
    resetTransientState();
    onClose();
  }, [downloading, onClose, resetTransientState]);

  useEscapeKey(open && !downloading, closeModal);

  useEffect(() => {
    if (!open) return;
    const balanceYear = Number(defaultYear);
    setYear(String(balanceYear));
    setFromYear(String(balanceYear - 1));
    setToYear(String(balanceYear));
    setDepartmentId(ALL_DEPARTMENTS_VALUE);
    setSelectedUserIds([]);
    resetTransientState();
  }, [defaultYear, open, resetTransientState]);

  useEffect(() => {
    if (!open) return;
    adminApi
      .listDepartments()
      .then((data) => setDepartments(data.departments ?? []))
      .catch((err) => setError(getErrorMessage(err)));
  }, [open]);

  useEffect(() => {
    if (!open) return;

    setLoadingEmployees(true);
    setEmployeeError('');
    setSelectedUserIds([]);

    adminApi
      .listEmployees({
        page: 1,
        limit: 100,
        isActive: 'true',
        ...(departmentId ? { departmentId } : {}),
      })
      .then((data) => {
        setEmployees(data.employees ?? []);
      })
      .catch((err) => {
        setEmployees([]);
        setSelectedUserIds([]);
        setEmployeeError(getErrorMessage(err));
      })
      .finally(() => setLoadingEmployees(false));
  }, [departmentId, open]);

  function buildReportParams() {
    if (selectedUserIds.length === 0) {
      throw new Error('Select at least one employee.');
    }

    const fromYearNum = Number(fromYear);
    const toYearNum = Number(toYear);
    if (Number.isNaN(fromYearNum) || Number.isNaN(toYearNum)) {
      throw new Error('Select source and target years.');
    }
    if (toYearNum < fromYearNum) {
      throw new Error('To year must be the same as or after from year.');
    }

    return {
      year: Number(year),
      fromYear: fromYearNum,
      toYear: toYearNum,
      userIds: selectedUserIds.join(','),
      ...(departmentId ? { departmentId } : {}),
    };
  }

  async function handleDownloadReport() {
    setDownloading(true);
    setDownloadProgress(null);
    setError('');
    try {
      const params = buildReportParams();
      const blob = await leaveApi.downloadCarryAuditReport(params, {
        onProgress: (percent) => setDownloadProgress(percent),
      });
      downloadBlob(blob, `leave-audit-report-${params.year}.xlsx`);
      showSuccess('Audit report downloaded.');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
    }
  }

  if (!open) {
    return null;
  }

  const departmentOptions = [
    { value: ALL_DEPARTMENTS_VALUE, label: 'All departments' },
    ...departments
      .filter((item) => item.isActive !== false)
      .map((item) => ({ value: item.id, label: item.name })),
  ];

  const employeeOptions = employees.map((employee) => ({
    value: employee.id,
    label: `${employee.name}${employee.employeeCode ? ` (${employee.employeeCode})` : ''}`,
  }));

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
                Download audit report
              </h2>
              <p className="modal__lead muted">
                Export a read-only Excel snapshot of entitled, used, and remaining balances from the
                live system. Use filters to choose who to include in the report.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost leave-carry-forward-modal__close"
              onClick={closeModal}
              disabled={downloading}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>

        <div className="modal__body leave-policies-modal__body leave-carry-bulk-modal__body">
          {error ? <div className="alert alert--error modal__alert">{error}</div> : null}

          <div className="leave-policies-modal__grid">
            <label className="modal__field">
              <span className="label">Balance year</span>
              <SelectField
                value={year}
                onChange={setYear}
                options={yearOptions}
                aria-label="Balance year"
              />
            </label>

            <label className="modal__field">
              <span className="label">Department</span>
              <SelectField
                value={departmentId}
                onChange={setDepartmentId}
                options={departmentOptions}
                aria-label="Department"
              />
            </label>

            <label className="modal__field">
              <span className="label">From year</span>
              <SelectField
                value={fromYear}
                onChange={setFromYear}
                options={yearOptions}
                aria-label="From year"
              />
            </label>

            <label className="modal__field">
              <span className="label">To year</span>
              <SelectField
                value={toYear}
                onChange={setToYear}
                options={yearOptions}
                aria-label="To year"
              />
            </label>
          </div>

          <div className="modal__field form-grid__full">
            <div className="leave-carry-bulk-modal__employees-label">
              <span className="label">Employees</span>
              <div className="leave-carry-bulk-modal__employees-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setSelectedUserIds(employees.map((employee) => employee.id))}
                  disabled={
                    loadingEmployees ||
                    employeeOptions.length === 0 ||
                    selectedUserIds.length === employees.length
                  }
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setSelectedUserIds([])}
                  disabled={loadingEmployees || selectedUserIds.length === 0}
                >
                  Clear all
                </button>
              </div>
            </div>
            <MultiSelectField
              value={selectedUserIds}
              onChange={setSelectedUserIds}
              options={employeeOptions}
              placeholder={loadingEmployees ? 'Loading employees…' : 'Select employees'}
              countSuffix="employees selected"
              disabled={loadingEmployees || employeeOptions.length === 0}
              aria-label="Employees"
            />
            <FieldError message={employeeError} />
            {!loadingEmployees && employees.length === 0 ? (
              <p className="muted small">No active employees found for this filter.</p>
            ) : null}
          </div>
        </div>

        {downloading ? (
          <div
            className="leave-carry-bulk-modal__download-progress help-attachment-upload__progress-panel"
            aria-live="polite"
          >
            <div className="help-attachment-upload__progress-item">
              <div className="help-attachment-upload__progress-label">
                <span className="help-attachment-upload__progress-name">Downloading audit report…</span>
                <span className="help-attachment-upload__progress-phase muted small">
                  {downloadProgress != null ? `${downloadProgress}%` : 'Preparing…'}
                </span>
              </div>
              <div
                className="help-attachment-upload__progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={downloadProgress ?? 0}
                aria-label="Audit report download progress"
              >
                <div
                  className={
                    downloadProgress == null
                      ? 'help-attachment-upload__progress-fill help-attachment-upload__progress-fill--indeterminate'
                      : 'help-attachment-upload__progress-fill'
                  }
                  style={downloadProgress != null ? { width: `${downloadProgress}%` } : undefined}
                />
              </div>
            </div>
          </div>
        ) : null}

        <footer className="modal__footer">
          <button type="button" className="btn btn-ghost" onClick={closeModal} disabled={downloading}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleDownloadReport}
            disabled={downloading || loadingEmployees || selectedUserIds.length === 0}
          >
            {downloading ? 'Downloading…' : 'Download audit report'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
