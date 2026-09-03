import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  createDepartmentSchema,
  updateDepartmentSchema,
} from '@shared/validation/departments.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { validateForm } from '../../utils/validation.js';
import ActionMenu from '../../components/ActionMenu.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import FieldError from '../../components/FieldError.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import SelectField from '../../components/SelectField.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

const emptyForm = {
  name: '',
  code: '',
  leadUserId: '',
  deputyUserId: '',
};

function TableSkeleton() {
  return (
    <div className="departments-table-skeleton" aria-busy="true" aria-label="Loading departments">
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

function formatLeadLabel(department) {
  return department.leadUserName || '—';
}

export default function AdminDepartments() {
  const { showSuccess } = useToast();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const createModalTitleId = useId();
  const editModalTitleId = useId();

  const [departments, setDepartments] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [employees, setEmployees] = useState([]);
  const [fieldErrors, setFieldErrors] = useState({});
  const [modalError, setModalError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const requestKeyRef = useRef('');

  const hasActiveFilters = Boolean(search.trim() || statusFilter);

  const filteredDepartments = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();
    return departments.filter((department) => {
      if (statusFilter === 'true' && !department.isActive) return false;
      if (statusFilter === 'false' && department.isActive) return false;
      if (!query) return true;

      return (
        department.name.toLowerCase().includes(query) ||
        department.code.toLowerCase().includes(query) ||
        department.leadUserName?.toLowerCase().includes(query)
      );
    });
  }, [departments, debouncedSearch, statusFilter]);

  const loadDepartments = useCallback(async () => {
    const requestKey = String(Date.now());
    requestKeyRef.current = requestKey;
    setLoading(true);
    setError('');

    try {
      const data = await adminApi.listDepartments();
      if (requestKeyRef.current !== requestKey) return;
      setDepartments(data.departments ?? []);
    } catch (err) {
      if (requestKeyRef.current !== requestKey) return;
      setError(getErrorMessage(err));
    } finally {
      if (requestKeyRef.current === requestKey) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadDepartments();
    (async () => {
      try {
        const allEmployees = [];
        let page = 1;
        let totalPages = 1;
        while (page <= totalPages) {
          const data = await adminApi.listEmployees({ page, limit: 100, isActive: 'true' });
          allEmployees.push(...(data.employees ?? []));
          totalPages = data.pagination?.totalPages ?? 1;
          page += 1;
        }
        setEmployees(allEmployees);
      } catch {
        // Silently ignore — dropdown will show only "None".
      }
    })();
  }, [loadDepartments]);

  function clearFilters() {
    setSearch('');
    setStatusFilter('');
  }

  function openCreateModal() {
    setForm(emptyForm);
    setFieldErrors({});
    setModalError('');
    setModal({ mode: 'create' });
  }

  function openEditModal(department) {
    setForm({
      name: department.name,
      code: department.code,
      leadUserId: department.leadUserId ?? '',
      deputyUserId: department.deputyUserId ?? '',
    });
    setFieldErrors({});
    setModalError('');
    setModal({ mode: 'edit', department });
  }

  function closeModal() {
    if (submitting) return;
    setModal(null);
    setForm(emptyForm);
    setFieldErrors({});
    setModalError('');
  }

  useEscapeKey(Boolean(modal), closeModal);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!modal) return;

    setSubmitting(true);
    setError('');
    setModalError('');

    const schema = modal.mode === 'create' ? createDepartmentSchema : updateDepartmentSchema;
    const validation = validateForm(schema, form);

    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }

    setFieldErrors({});

    try {
      if (modal.mode === 'create') {
        await adminApi.createDepartment({
          ...validation.data,
          leadUserId: form.leadUserId || null,
          deputyUserId: form.deputyUserId || null,
        });
        showSuccess(`Department "${validation.data.name}" created.`);
      } else {
        await adminApi.updateDepartment(modal.department.id, {
          ...validation.data,
          leadUserId: form.leadUserId || null,
          deputyUserId: form.deputyUserId || null,
        });
        showSuccess(`Department "${validation.data.name}" updated.`);
      }

      closeModal();
      await loadDepartments();
    } catch (err) {
      setModalError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(department) {
    const nextActive = !department.isActive;
    await requestConfirm({
      title: nextActive ? 'Activate department?' : 'Deactivate department?',
      message: nextActive
        ? `Activate "${department.name}"? It will be available for employee assignments again.`
        : `Deactivate "${department.name}"? It will no longer be available for new assignments.`,
      confirmLabel: nextActive ? 'Activate' : 'Deactivate',
      variant: nextActive ? 'default' : 'danger',
      onConfirm: async () => {
        await adminApi.updateDepartment(department.id, { isActive: nextActive });
        showSuccess(
          nextActive
            ? `Department "${department.name}" activated.`
            : `Department "${department.name}" deactivated.`,
        );
        await loadDepartments();
      },
    });
  }

  async function deleteDepartment(department) {
    await requestConfirm({
      title: 'Delete department?',
      message: `Permanently delete "${department.name}" (${department.code})? This cannot be undone. Departments assigned to employees cannot be deleted.`,
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        await adminApi.deleteDepartment(department.id);
        showSuccess(`Department "${department.name}" deleted.`);
        await loadDepartments();
      },
    });
  }

  function getActionItems(department) {
    return [
      {
        key: 'edit',
        label: 'Edit details',
        onClick: () => openEditModal(department),
      },
      {
        key: 'toggle',
        label: department.isActive ? 'Deactivate' : 'Activate',
        variant: department.isActive ? 'danger' : 'default',
        onClick: () => toggleActive(department),
      },
      {
        key: 'delete',
        label: 'Delete',
        variant: 'danger',
        onClick: () => deleteDepartment(department),
      },
    ];
  }

  const emptyTitle = useMemo(() => {
    if (departments.length === 0) return 'No departments yet';
    if (hasActiveFilters) return 'No departments match these filters';
    return 'No departments found';
  }, [departments.length, hasActiveFilters]);

  const emptyDescription = useMemo(() => {
    if (departments.length === 0) {
      return 'Create organizational departments to group employees and power directory filters.';
    }
    if (hasActiveFilters) {
      return 'Try adjusting search or status, or clear filters to browse all departments.';
    }
    return 'Departments will appear here once they are created.';
  }, [departments.length, hasActiveFilters]);

  const modalTitleId = modal?.mode === 'create' ? createModalTitleId : editModalTitleId;

  return (
    <div className="page page--departments">
      <section className="departments-panel card card--table" aria-label="Departments">
        <div className="departments-toolbar card__toolbar">
          <div className="departments-toolbar__filters filter-bar">
            <SearchInput
              className="filter-bar__search departments-toolbar__search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or code…"
              ariaLabel="Search departments"
            />

            <label className="field-inline filter-bar__field departments-toolbar__field">
              <span className="label">Status</span>
              <SelectField
                value={statusFilter}
                onChange={setStatusFilter}
                options={STATUS_OPTIONS}
                aria-label="Department status filter"
              />
            </label>

            {hasActiveFilters ? (
              <div className="filter-bar__field departments-toolbar__clear">
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                  Clear filters
                </button>
              </div>
            ) : null}
          </div>

          <div className="departments-toolbar__actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={openCreateModal}>
              + Add department
            </button>
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <TableSkeleton />
        ) : filteredDepartments.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.settings}
            title={emptyTitle}
            description={emptyDescription}
            action={
              departments.length === 0 ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={openCreateModal}>
                  Add department
                </button>
              ) : hasActiveFilters ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={clearFilters}>
                  Clear filters
                </button>
              ) : null
            }
          />
        ) : (
          <div className="table-wrap table-wrap--responsive departments-table-wrap">
            <table className="table data-table departments-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Code</th>
                  <th>Lead</th>
                  <th>Employees</th>
                  <th>Status</th>
                  <th className="cell-actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredDepartments.map((department) => (
                  <tr key={department.id}>
                    <td data-label="Name" className="departments-table__name">
                      {department.name}
                    </td>
                    <td data-label="Code">
                      <code className="departments-table__code">{department.code}</code>
                    </td>
                    <td
                      data-label="Lead"
                      className="cell-ellipsis"
                      title={
                        department.leadUserName ? formatLeadLabel(department) : undefined
                      }
                    >
                      {formatLeadLabel(department)}
                    </td>
                    <td data-label="Employees">
                      {department.employeeCount ?? 0}
                    </td>
                    <td data-label="Status">
                      <StatusBadge active={department.isActive} />
                    </td>
                    <td data-label="Actions" className="cell-actions-col">
                      <ActionMenu
                        label={`Actions for ${department.name}`}
                        items={getActionItems(department)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {modal ? (
        <div className="modal__backdrop" role="presentation" onClick={closeModal}>
          <div
            className="modal modal--compact departments-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={modalTitleId}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal__header">
              <h2 id={modalTitleId} className="modal__title">
                {modal.mode === 'create' ? 'Add department' : 'Edit department'}
              </h2>
              <p className="modal__lead muted">
                {modal.mode === 'create'
                  ? 'Define a name and short code for a new organizational unit.'
                  : 'Update the department name or code shown across the directory.'}
              </p>
            </header>

            <form className="modal__form" onSubmit={handleSubmit}>
              <div className="modal__body">
                {modalError ? <div className="alert alert--error modal__alert">{modalError}</div> : null}

                <label className="modal__field">
                  <span className="label">Department name</span>
                  <input
                    autoFocus
                    className="input"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    maxLength={100}
                    placeholder="e.g. Engineering"
                  />
                  <FieldError message={fieldErrors.name} />
                </label>

                <label className="modal__field">
                  <span className="label">Code</span>
                  <input
                    className="input input--narrow"
                    value={form.code}
                    onChange={(event) =>
                      setForm({ ...form, code: event.target.value.toUpperCase() })
                    }
                    maxLength={20}
                    placeholder="ENG"
                  />
                  <FieldError message={fieldErrors.code} />
                </label>

                <div className="modal__field">
                  <span className="label">Department lead <span className="muted">(Optional)</span></span>
                  <SelectField
                    value={form.leadUserId ?? ''}
                    onChange={(value) => setForm({ ...form, leadUserId: value })}
                    options={[
                      { value: '', label: 'None' },
                      ...employees.map((emp) => ({
                        value: emp.id,
                        label: emp.name,
                      })),
                    ]}
                    aria-label="Department lead"
                  />
                </div>
                <div className="modal__field">
                  <span className="label">Deputy lead <span className="muted">(Optional)</span></span>
                  <SelectField
                    value={form.deputyUserId ?? ''}
                    onChange={(value) => setForm({ ...form, deputyUserId: value })}
                    options={[
                      { value: '', label: 'None' },
                      ...employees.map((emp) => ({
                        value: emp.id,
                        label: emp.name,
                      })),
                    ]}
                    aria-label="Deputy lead"
                  />
                </div>
              </div>

              <footer className="modal__footer">
                <button type="button" className="btn btn-ghost" onClick={closeModal} disabled={submitting}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting
                    ? 'Saving…'
                    : modal.mode === 'create'
                      ? 'Create department'
                      : 'Save changes'}
                </button>
              </footer>
            </form>
          </div>
        </div>
      ) : null}

      {confirmDialog}
    </div>
  );
}
