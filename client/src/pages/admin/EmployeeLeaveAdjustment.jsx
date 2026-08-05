import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, getErrorMessage, leaveApi } from '../../services/api.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useToast } from '../../context/ToastContext.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import SelectField from '../../components/SelectField.jsx';

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
  }, [editedVersion]);

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

  function updateCarried(userId, leaveTypeId, nextValue) {
    const key = adjustmentKey(userId, leaveTypeId);
    editedRef.current.set(key, nextValue);
    setEditedVersion((version) => version + 1);
  }

  function handleReset() {
    editedRef.current = new Map();
    setEditedVersion((version) => version + 1);
    originalRef.current = new Map();
    loadGrid();
  }

  async function handleSave() {
    if (dirtyCount === 0 || saving) return;

    const adjustments = [];
    for (const [key, carried] of editedRef.current.entries()) {
      const original = originalRef.current.get(key);
      if (original === carried) continue;
      const [userId, leaveTypeId] = key.split('|');
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
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
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
                        <CarriedStepper
                          value={getDisplayedCarried(row.id, leaveType.id)}
                          disabled={saving}
                          onChange={(nextValue) => updateCarried(row.id, leaveType.id, nextValue)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="leave-adjustment-panel__footer">
        <p className="muted small leave-adjustment-panel__note">
          Changes are logged in audit history when saved.
        </p>
        <div className="leave-adjustment-panel__footer-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleReset}
            disabled={saving || dirtyCount === 0}
          >
            Reset
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || dirtyCount === 0}
          >
            {saving ? 'Saving…' : `Save Changes${dirtyCount > 0 ? ` (${dirtyCount})` : ''}`}
          </button>
        </div>
      </div>

      <PaginationBar
        pagination={pagination}
        onPageChange={setPage}
        entityLabel="employees"
      />
    </section>
  );
}
