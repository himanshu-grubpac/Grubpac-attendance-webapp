import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, getErrorMessage, leaveApi } from '../../services/api.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import SelectField from '../../components/SelectField.jsx';
import LeaveAdjustmentBulkUploadModal from './LeaveAdjustmentBulkUploadModal.jsx';

const PAGE_SIZE_OPTIONS = [
  { value: '10', label: '10 / page' },
  { value: '20', label: '20 / page' },
  { value: '50', label: '50 / page' },
];

const LEAVE_BADGE_TONES = {
  SL: 'sl',
  CL: 'cl',
  EL: 'el',
  WFH: 'wfh',
  CO: 'co',
  RH: 'rh',
};

function adjustmentKey(userId, leaveTypeId) {
  return `${userId}|${leaveTypeId}`;
}

function splitAdjustmentKey(key) {
  const separatorIndex = key.indexOf('|');
  if (separatorIndex < 0) return [key, ''];
  return [key.slice(0, separatorIndex), key.slice(separatorIndex + 1)];
}

function formatCarried(value) {
  if (value == null || Number.isNaN(value)) return '0';
  return Number.isInteger(value) ? String(value) : String(value);
}

function LeaveTypeBadge({ code }) {
  const tone = LEAVE_BADGE_TONES[String(code ?? '').toUpperCase()] ?? 'default';
  return (
    <span className={`leave-adjustment-badge leave-adjustment-badge--${tone}`}>{code}</span>
  );
}

function CarriedStepper({ value, disabled, onChange }) {
  const numericValue = Number(value) || 0;

  function step(delta) {
    const next = Math.max(0, Math.min(365, Math.round((numericValue + delta) * 2) / 2));
    onChange(next);
  }

  return (
    <div className="leave-adjustment-stepper">
      <button
        type="button"
        className="btn btn-sm btn-ghost leave-adjustment-stepper__btn"
        onClick={() => step(-1)}
        disabled={disabled || numericValue <= 0}
        aria-label="Decrease carried days"
      >
        −
      </button>
      <span className="leave-adjustment-stepper__value" aria-live="polite">
        {formatCarried(numericValue)}
      </span>
      <button
        type="button"
        className="btn btn-sm btn-ghost leave-adjustment-stepper__btn"
        onClick={() => step(1)}
        disabled={disabled || numericValue >= 365}
        aria-label="Increase carried days"
      >
        +
      </button>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="leave-adjustment-skeleton" aria-busy="true" aria-label="Loading leave adjustments">
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

export default function EmployeeLeaveAdjustment({ policyYear, onOpenAuditReport }) {
  const { showSuccess } = useToast();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();

  const [rows, setRows] = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState('20');
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const debouncedSearch = useDebouncedValue(search, 350);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Task 1: single-row edit mode. Only one row is editable at a time.
  const [editingRowId, setEditingRowId] = useState(null);
  const [savingRowId, setSavingRowId] = useState(null);
  // Task 2: bulk edit mode. Mutually exclusive with single-row edit.
  const [bulkEditMode, setBulkEditMode] = useState(false);
  // Task 3: bulk upload modal visibility.
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);

  const originalRef = useRef(new Map());
  const editedRef = useRef(new Map());
  const [editedVersion, setEditedVersion] = useState(0);

  const dirtyCount = useMemo(() => {
    let count = 0;
    for (const [key, value] of editedRef.current.entries()) {
      if (originalRef.current.get(key) !== value) {
        count += 1;
      }
    }
    return count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editedVersion]);

  const busy = saving || savingRowId != null;

  const loadGrid = useCallback(async () => {
    const requestYear = Number(policyYear);
    if (!requestYear) return;

    setLoading(true);
    setError('');

    try {
      const data = await leaveApi.getAdjustmentGrid({
        year: requestYear,
        page,
        limit: Number(pageSize),
        search: debouncedSearch || undefined,
        departmentId: departmentId || undefined,
      });

      const nextOriginal = new Map(originalRef.current);
      for (const row of data.rows ?? []) {
        for (const leaveType of data.leaveTypes ?? []) {
          const key = adjustmentKey(row.id, leaveType.id);
          const carried = row.carriedByLeaveType?.[leaveType.id]?.carried ?? 0;
          if (!editedRef.current.has(key)) {
            nextOriginal.set(key, carried);
          }
        }
      }
      originalRef.current = nextOriginal;
      setRows(data.rows ?? []);
      setLeaveTypes(data.leaveTypes ?? []);
      setPagination(data.pagination ?? null);
    } catch (err) {
      setError(getErrorMessage(err));
      setRows([]);
      setLeaveTypes([]);
      setPagination(null);
    } finally {
      setLoading(false);
    }
  }, [policyYear, page, pageSize, debouncedSearch, departmentId]);

  useEffect(() => {
    adminApi
      .listDepartments()
      .then((data) => setDepartments(data.departments ?? []))
      .catch(() => setDepartments([]));
  }, []);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, departmentId, policyYear, pageSize]);

  // Year-scoped edit state: keys are userId|leaveTypeId without a year, so any
  // year switch must drop pending edits to avoid cross-year contamination.
  useEffect(() => {
    editedRef.current = new Map();
    originalRef.current = new Map();
    setEditingRowId(null);
    setSavingRowId(null);
    setBulkEditMode(false);
    setEditedVersion((version) => version + 1);
  }, [policyYear]);

  // Navigation while single-row editing (page / filter change) would orphan
  // pending edits because the footer save path is bulk-only. Discard the
  // abandoned single-row edits. Bulk mode intentionally preserves edits
  // across pages (pre-existing behaviour).
  useEffect(() => {
    if (bulkEditMode || editingRowId == null) return;
    let removed = false;
    for (const key of Array.from(editedRef.current.keys())) {
      const [userId] = splitAdjustmentKey(key);
      if (userId === editingRowId) {
        editedRef.current.delete(key);
        removed = true;
      }
    }
    setEditingRowId(null);
    if (removed) {
      setEditedVersion((version) => version + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearch, departmentId, pageSize]);

  useEffect(() => {
    loadGrid();
  }, [loadGrid]);

  function getDisplayedCarried(userId, leaveTypeId) {
    const key = adjustmentKey(userId, leaveTypeId);
    if (editedRef.current.has(key)) {
      return editedRef.current.get(key);
    }
    return originalRef.current.get(key) ?? 0;
  }

  function getRowDirtyCount(rowId) {
    let count = 0;
    for (const [key, value] of editedRef.current.entries()) {
      const [userId] = splitAdjustmentKey(key);
      if (userId !== rowId) continue;
      if (originalRef.current.get(key) !== value) {
        count += 1;
      }
    }
    return count;
  }

  function getRowAdjustments(rowId) {
    const adjustments = [];
    for (const [key, carried] of editedRef.current.entries()) {
      const [userId, leaveTypeId] = splitAdjustmentKey(key);
      if (userId !== rowId) continue;
      const original = originalRef.current.get(key);
      if (original === carried) continue;
      adjustments.push({
        userId,
        leaveTypeId,
        year: Number(policyYear),
        carried,
      });
    }
    return adjustments;
  }

  function discardRowEdits(rowId) {
    let removed = false;
    for (const key of Array.from(editedRef.current.keys())) {
      const [userId] = splitAdjustmentKey(key);
      if (userId === rowId) {
        editedRef.current.delete(key);
        removed = true;
      }
    }
    if (removed) {
      setEditedVersion((version) => version + 1);
    }
  }

  function updateCarried(userId, leaveTypeId, nextValue) {
    const key = adjustmentKey(userId, leaveTypeId);
    editedRef.current.set(key, nextValue);
    setEditedVersion((version) => version + 1);
  }

  async function handleEditRow(rowId) {
    if (bulkEditMode || busy || loading) return;
    if (editingRowId === rowId) return;

    if (editingRowId != null) {
      const previousDirty = getRowDirtyCount(editingRowId);
      if (previousDirty > 0) {
        const confirmed = await requestConfirm({
          title: 'Discard unsaved row changes?',
          message: `Row has ${previousDirty} unsaved change(s). Switch to editing another employee and discard them?`,
          confirmLabel: 'Discard & Switch',
          cancelLabel: 'Stay',
          variant: 'danger',
        });
        if (!confirmed) return;
      }
      discardRowEdits(editingRowId);
    }

    setError('');
    setEditingRowId(rowId);
  }

  function handleCancelRow(rowId) {
    if (savingRowId != null) return;
    discardRowEdits(rowId);
    setEditingRowId(null);
  }

  async function handleSaveRow(rowId) {
    if (busy || bulkEditMode) return;

    const adjustments = getRowAdjustments(rowId);
    if (adjustments.length === 0) {
      setEditingRowId(null);
      return;
    }

    setSavingRowId(rowId);
    setError('');

    try {
      const result = await leaveApi.batchAdjustCarried({ adjustments });
      const okKeys = new Set(
        (result.results ?? [])
          .filter((item) => item.status === 'success')
          .map((item) => adjustmentKey(item.userId, item.leaveTypeId)),
      );

      if (result.summary.error > 0) {
        for (const key of okKeys) {
          const value = editedRef.current.get(key);
          if (value !== undefined) {
            originalRef.current.set(key, value);
            editedRef.current.delete(key);
          }
        }
        setEditedVersion((version) => version + 1);
        setError(
          `Saved ${result.summary.success} of ${result.summary.total} change(s) for this employee. Review errors and retry the remaining cells.`,
        );
        return;
      }

      showSuccess(`Saved ${result.summary.success} leave adjustment(s).`);
      for (const item of adjustments) {
        const key = adjustmentKey(item.userId, item.leaveTypeId);
        originalRef.current.set(key, item.carried);
        editedRef.current.delete(key);
      }
      setEditedVersion((version) => version + 1);
      setEditingRowId(null);
      setError('');
      await loadGrid();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSavingRowId(null);
    }
  }

  async function handleToggleBulkEdit() {
    if (busy || loading || bulkUploadOpen) return;

    if (!bulkEditMode) {
      if (editingRowId != null) {
        const rowDirty = getRowDirtyCount(editingRowId);
        if (rowDirty > 0) {
          const confirmed = await requestConfirm({
            title: 'Discard unsaved row changes?',
            message: `Current row has ${rowDirty} unsaved change(s). Enter bulk edit mode and discard them?`,
            confirmLabel: 'Discard & Continue',
            cancelLabel: 'Stay',
            variant: 'danger',
          });
          if (!confirmed) return;
        }
        discardRowEdits(editingRowId);
        setEditingRowId(null);
      }
      setError('');
      setBulkEditMode(true);
      return;
    }

    if (dirtyCount > 0) {
      const confirmed = await requestConfirm({
        title: 'Exit bulk edit?',
        message: `${dirtyCount} unsaved change(s) will be discarded. Exit bulk edit mode?`,
        confirmLabel: 'Discard & Exit',
        cancelLabel: 'Stay',
        variant: 'danger',
      });
      if (!confirmed) return;
      editedRef.current = new Map();
      originalRef.current = new Map();
      setEditedVersion((version) => version + 1);
      setBulkEditMode(false);
      await loadGrid();
      return;
    }

    setBulkEditMode(false);
  }

  function handleReset() {
    if (!bulkEditMode || busy) return;
    editedRef.current = new Map();
    setEditedVersion((version) => version + 1);
    originalRef.current = new Map();
    loadGrid();
  }

  async function handleSave() {
    if (!bulkEditMode || dirtyCount === 0 || busy) return;

    const adjustments = [];
    for (const [key, carried] of editedRef.current.entries()) {
      const original = originalRef.current.get(key);
      if (original === carried) continue;
      const [userId, leaveTypeId] = splitAdjustmentKey(key);
      adjustments.push({
        userId,
        leaveTypeId,
        year: Number(policyYear),
        carried,
      });
    }

    if (adjustments.length === 0) return;

    setSaving(true);
    setError('');

    try {
      const result = await leaveApi.batchAdjustCarried({ adjustments });
      if (result.summary.error > 0) {
        setError(
          `Saved ${result.summary.success} of ${result.summary.total} changes. Review errors and retry remaining rows.`,
        );
      } else {
        showSuccess(`Saved ${result.summary.success} leave adjustment(s).`);
        setError('');
      }
      setEditedVersion((version) => version + 1);
      editedRef.current = new Map();
      originalRef.current = new Map();
      await loadGrid();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function handlePageChange(nextPage) {
    if (busy) return;
    setPage(nextPage);
  }

  const departmentOptions = useMemo(
    () => [
      { value: '', label: 'All departments' },
      ...departments.map((department) => ({
        value: department.id,
        label: department.name,
      })),
    ],
    [departments],
  );

  const footerNote = bulkEditMode
    ? dirtyCount > 0
      ? `${dirtyCount} unsaved change(s). Save to apply to all edited rows, or Reset to discard.`
      : 'Bulk edit mode: change any row with − / +, then Save Changes.'
    : 'Tip: use Edit for one employee, Bulk Edit for many rows, or Bulk Upload for Excel import. Changes are logged in audit history when saved.';

  return (
    <section className="card leave-adjustment-panel" aria-label="Employee leave adjustment">
      <div className="leave-adjustment-panel__header">
        <div>
          <p className="card__section-title">Employee Leave Adjustment</p>
          <p className="muted small leave-adjustment-panel__lead">
            Adjust carried leave quota for individual employees. Changes apply to the carried balance
            only for policy year {policyYear}.
          </p>
        </div>
        <div className="leave-adjustment-panel__header-actions">
          <button
            type="button"
            className={`btn ${bulkEditMode ? 'btn-primary' : 'btn-ghost'}`}
            onClick={handleToggleBulkEdit}
            disabled={busy || loading}
            aria-pressed={bulkEditMode}
            title={
              bulkEditMode
                ? 'Exit bulk edit mode'
                : 'Enable bulk edit mode to change all rows at once'
            }
          >
            {bulkEditMode ? 'Exit Bulk Edit' : 'Bulk Edit'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onOpenAuditReport}>
            Download audit report
          </button>
        </div>
      </div>

      <div className="leave-adjustment-panel__toolbar filter-bar">
        <SearchInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name or employee code…"
          ariaLabel="Search employees"
          className="filter-bar__search leave-adjustment-panel__search"
        />
        <label className="field-inline filter-bar__field leave-adjustment-panel__field">
          <span className="label">Department</span>
          <SelectField
            value={departmentId}
            onChange={setDepartmentId}
            options={departmentOptions}
            placeholder="All departments"
            aria-label="Department filter"
          />
        </label>
        <label className="field-inline filter-bar__field leave-adjustment-panel__field leave-adjustment-panel__field--page-size">
          <span className="label">Per page</span>
          <SelectField
            value={pageSize}
            onChange={setPageSize}
            options={PAGE_SIZE_OPTIONS}
            placeholder="Page size"
            aria-label="Rows per page"
          />
        </label>
      </div>

      {error ? <div className="alert alert--error">{error}</div> : null}

      {loading ? (
        <TableSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={EMPTY_ICONS.users}
          title="No employees found"
          description="Try a different search or department filter."
        />
      ) : (
        <div className="table-wrap table-wrap--fit table-wrap--responsive leave-adjustment-table-wrap">
          <table className="table data-table leave-adjustment-table">
            <thead>
              <tr>
                <th className="leave-adjustment-table__col-employee">Employee Name</th>
                <th className="leave-adjustment-table__col-code">Emp Code</th>
                <th className="leave-adjustment-table__col-department">Department</th>
                {leaveTypes.map((leaveType) => (
                  <th key={leaveType.id} className="leave-adjustment-table__col-type">
                    <LeaveTypeBadge code={leaveType.code} />
                  </th>
                ))}
                <th className="leave-adjustment-table__col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isEditingRow = editingRowId === row.id;
                const rowDirtyCount = getRowDirtyCount(row.id);
                const rowSaving = savingRowId === row.id;
                const editable = bulkEditMode || isEditingRow;
                return (
                  <tr
                    key={row.id}
                    className={isEditingRow ? 'leave-adjustment-table__row--editing' : ''}
                  >
                    <td data-label="Employee Name" className="leave-adjustment-table__employee">
                      <span className="leave-adjustment-table__name">{row.name}</span>
                    </td>
                    <td data-label="Emp Code">{row.employeeCode ?? '—'}</td>
                    <td data-label="Department" className="leave-adjustment-table__department">
                      {row.departmentName ?? '—'}
                    </td>
                    {leaveTypes.map((leaveType) => {
                      const key = adjustmentKey(row.id, leaveType.id);
                      const isDirty =
                        editedRef.current.has(key) &&
                        editedRef.current.get(key) !== originalRef.current.get(key);
                      return (
                        <td
                          key={leaveType.id}
                          data-label={leaveType.code}
                          className={`leave-adjustment-table__stepper-cell${isDirty ? ' leave-adjustment-table__stepper-cell--dirty' : ''}`}
                        >
                          {editable ? (
                            <CarriedStepper
                              value={getDisplayedCarried(row.id, leaveType.id)}
                              disabled={busy || loading}
                              onChange={(nextValue) =>
                                updateCarried(row.id, leaveType.id, nextValue)
                              }
                            />
                          ) : (
                            <span
                              className="leave-adjustment-table__value"
                              aria-label={`${leaveType.code} carried days: ${formatCarried(getDisplayedCarried(row.id, leaveType.id))}`}
                            >
                              {formatCarried(getDisplayedCarried(row.id, leaveType.id))}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td
                      data-label="Actions"
                      className="leave-adjustment-table__actions-cell"
                    >
                      {bulkEditMode ? (
                        <span
                          className="muted small"
                          title="Per-row edit is disabled while bulk edit mode is active"
                        >
                          —
                        </span>
                      ) : isEditingRow ? (
                        <div className="leave-adjustment-table__row-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => handleSaveRow(row.id)}
                            disabled={rowSaving || saving || rowDirtyCount === 0}
                            title={
                              rowDirtyCount === 0
                                ? 'No changes to save for this row'
                                : `Save ${rowDirtyCount} change(s) for this employee`
                            }
                          >
                            {rowSaving ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => handleCancelRow(row.id)}
                            disabled={rowSaving || saving}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => handleEditRow(row.id)}
                          disabled={busy || loading || editingRowId != null}
                          title={
                            editingRowId != null
                              ? 'Finish the current row edit first'
                              : `Edit carried balances for ${row.name}`
                          }
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="leave-adjustment-panel__footer">
        <p className="muted small leave-adjustment-panel__note">{footerNote}</p>
        <div className="leave-adjustment-panel__footer-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setBulkUploadOpen(true)}
            disabled={busy || loading}
            title="Download the prefilled Excel sheet, edit carried values, then upload to sync"
          >
            Bulk Upload
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleReset}
            disabled={!bulkEditMode || busy || dirtyCount === 0}
            title={
              bulkEditMode
                ? 'Discard all bulk edits'
                : 'Enter bulk edit mode to enable reset'
            }
          >
            Reset
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!bulkEditMode || busy || dirtyCount === 0}
            title={
              bulkEditMode
                ? 'Save all bulk edits at once'
                : 'Enter bulk edit mode to save many rows at once'
            }
          >
            {saving ? 'Saving…' : `Save Changes${dirtyCount > 0 ? ` (${dirtyCount})` : ''}`}
          </button>
        </div>
      </div>

      <PaginationBar
        pagination={pagination}
        onPageChange={handlePageChange}
        entityLabel="employees"
      />

      <LeaveAdjustmentBulkUploadModal
        open={bulkUploadOpen}
        onClose={() => setBulkUploadOpen(false)}
        policyYear={policyYear}
        departmentId={departmentId}
        onImported={loadGrid}
      />

      {confirmDialog}
    </section>
  );
}
