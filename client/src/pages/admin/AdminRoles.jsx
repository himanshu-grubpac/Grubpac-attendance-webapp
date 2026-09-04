import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createRoleSchema, updateRoleSchema } from '@shared/validation/roles.js';
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

const emptyForm = {
  name: '',
  slug: '',
  description: '',
  permissions: [],
};

function TableSkeleton() {
  return (
    <div className="roles-table-skeleton" aria-busy="true" aria-label="Loading roles">
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

function PermissionMatrix({ groups, selected, onChange, disabled = false, hideActions = false }) {
  function togglePermission(key) {
    if (disabled) return;
    onChange(
      selected.includes(key)
        ? selected.filter((item) => item !== key)
        : [...selected, key],
    );
  }

  function toggleGroup(group) {
    if (disabled) return;
    const keys = group.permissions.map((permission) => permission.key);
    const allSelected = keys.every((key) => selected.includes(key));
    if (allSelected) {
      onChange(selected.filter((key) => !keys.includes(key)));
      return;
    }
    onChange([...new Set([...selected, ...keys])]);
  }

  return (
    <div className="roles-permissions">
      {groups.map((group) => {
        const groupKeys = group.permissions.map((permission) => permission.key);
        const selectedCount = groupKeys.filter((key) => selected.includes(key)).length;
        const allSelected = selectedCount === groupKeys.length && groupKeys.length > 0;
        const someSelected = selectedCount > 0 && !allSelected;

        return (
          <section key={group.label} className="permission-group">
            <div className="permission-group__header">
              <div className="permission-group__heading">
                <h3 className="permission-group__title">{group.label}</h3>
                <span className="permission-group__count muted" aria-live="polite">
                  {selectedCount}/{groupKeys.length}
                </span>
              </div>
              {hideActions ? null : (
                <button
                  type="button"
                  className="permission-group__action"
                  disabled={disabled || groupKeys.length === 0}
                  onClick={() => toggleGroup(group)}
                >
                  {allSelected ? 'Clear group' : 'Select all'}
                </button>
              )}
            </div>
            <div className="permission-grid" role="group" aria-label={`${group.label} permissions`}>
              {group.permissions.map((permission) => (
                <label
                  key={permission.key}
                  className={`checkbox-row${selected.includes(permission.key) ? ' checkbox-row--checked' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(permission.key)}
                    disabled={disabled}
                    onChange={() => togglePermission(permission.key)}
                  />
                  <span className="checkbox-row__label">{permission.label}</span>
                </label>
              ))}
            </div>
            {someSelected ? (
              <p className="permission-group__meta muted">
                {selectedCount} of {groupKeys.length} selected in this group
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export default function AdminRoles() {
  const { showSuccess } = useToast();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const createModalTitleId = useId();
  const editModalTitleId = useId();
  const viewModalTitleId = useId();

  const [roles, setRoles] = useState([]);
  const [permissionGroups, setPermissionGroups] = useState([]);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [modalError, setModalError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const requestKeyRef = useRef('');

  const hasActiveFilters = Boolean(search.trim());

  const filteredRoles = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();
    if (!query) return roles;

    return roles.filter(
      (role) =>
        role.name.toLowerCase().includes(query) ||
        role.slug.toLowerCase().includes(query) ||
        role.description?.toLowerCase().includes(query),
    );
  }, [roles, debouncedSearch]);

  const loadData = useCallback(async () => {
    const requestKey = String(Date.now());
    requestKeyRef.current = requestKey;
    setLoading(true);
    setError('');

    try {
      const [rolesData, permissionsData] = await Promise.all([
        adminApi.listRoles(),
        adminApi.listPermissions(),
      ]);
      if (requestKeyRef.current !== requestKey) return;
      setRoles(rolesData.roles ?? []);
      setPermissionGroups(permissionsData.groups ?? []);
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
    loadData();
  }, [loadData]);

  function clearFilters() {
    setSearch('');
  }

  function openCreateModal() {
    setForm(emptyForm);
    setFieldErrors({});
    setModalError('');
    setModal({ mode: 'create' });
  }

  function openEditModal(role) {
    setForm({
      name: role.name,
      slug: role.slug,
      description: role.description ?? '',
      permissions: role.permissions ?? [],
    });
    setFieldErrors({});
    setModalError('');
    setModal({ mode: 'edit', role });
  }

  function openViewModal(role) {
    setFieldErrors({});
    setModalError('');
    setModal({ mode: 'view', role });
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
    if (!modal || modal.mode === 'view') return;

    setSubmitting(true);
    setError('');
    setModalError('');

    if (modal.mode === 'create') {
      const validation = validateForm(createRoleSchema, form);
      if (!validation.data) {
        setFieldErrors(validation.errors);
        setSubmitting(false);
        return;
      }

      setFieldErrors({});

      try {
        await adminApi.createRole(validation.data);
        showSuccess(`Role "${validation.data.name}" created.`);
        closeModal();
        await loadData();
      } catch (err) {
        setModalError(getErrorMessage(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const validation = validateForm(updateRoleSchema, {
      name: form.name,
      description: form.description,
      permissions: form.permissions,
    });

    if (!validation.data) {
      setFieldErrors(validation.errors);
      setSubmitting(false);
      return;
    }

    setFieldErrors({});

    try {
      await adminApi.updateRole(modal.role.id, validation.data);
      showSuccess(`Role "${validation.data.name}" updated.`);
      closeModal();
      await loadData();
    } catch (err) {
      setModalError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteRole(role) {
    await requestConfirm({
      title: 'Delete role?',
      message: `Permanently delete "${role.name}" (${role.slug})? Roles assigned to employees must be reassigned first.`,
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        await adminApi.deleteRole(role.id);
        showSuccess(`Role "${role.name}" deleted.`);
        await loadData();
      },
    });
  }

  function getActionItems(role) {
    const items = [
      {
        key: 'view',
        label: 'View permissions',
        onClick: () => openViewModal(role),
      },
      {
        key: 'edit',
        label: 'Edit role',
        onClick: () => openEditModal(role),
      },
    ];

    if (!role.isSystem) {
      items.push({
        key: 'delete',
        label: 'Delete',
        variant: 'danger',
        onClick: () => deleteRole(role),
      });
    }

    return items;
  }

  const emptyTitle = useMemo(() => {
    if (roles.length === 0) return 'No roles yet';
    if (hasActiveFilters) return 'No roles match these filters';
    return 'No roles found';
  }, [roles.length, hasActiveFilters]);

  const emptyDescription = useMemo(() => {
    if (roles.length === 0) {
      return 'Create roles to control access across the admin portal and employee features.';
    }
    if (hasActiveFilters) {
      return 'Try a different search term or clear filters to browse all roles.';
    }
    return 'Roles will appear here once they are created.';
  }, [roles.length, hasActiveFilters]);

  const modalTitleId =
    modal?.mode === 'create' ? createModalTitleId : modal?.mode === 'view' ? viewModalTitleId : editModalTitleId;
  const slugLocked = modal?.mode === 'edit' && modal.role?.isSystem;
  const isViewMode = modal?.mode === 'view';
  const viewPermissions = modal?.role?.permissions ?? [];

  return (
    <div className="page page--roles">
      <section className="roles-panel card card--table" aria-label="Roles and permissions">
        <div className="roles-toolbar card__toolbar">
          <div className="roles-toolbar__filters filter-bar">
            <SearchInput
              className="filter-bar__search roles-toolbar__search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, slug, or description…"
              ariaLabel="Search roles"
            />

            {hasActiveFilters ? (
              <div className="filter-bar__field roles-toolbar__clear">
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
                  Clear filters
                </button>
              </div>
            ) : null}
          </div>

          <div className="roles-toolbar__actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={openCreateModal}>
              + Add role
            </button>
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {loading ? (
          <TableSkeleton />
        ) : filteredRoles.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.settings}
            title={emptyTitle}
            description={emptyDescription}
            action={
              roles.length === 0 ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={openCreateModal}>
                  Add role
                </button>
              ) : hasActiveFilters ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={clearFilters}>
                  Clear filters
                </button>
              ) : null
            }
          />
        ) : (
          <div className="table-wrap table-wrap--responsive roles-table-wrap">
            <table className="table data-table roles-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Slug</th>
                  <th>Permissions</th>
                  <th className="cell-actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRoles.map((role) => (
                  <tr key={role.id}>
                    <td data-label="Role" className="roles-table__name">
                      <span className="roles-table__name-text">{role.name}</span>
                      {role.description ? (
                        <span className="roles-table__desc muted">{role.description}</span>
                      ) : null}
                    </td>
                    <td data-label="Slug">
                      <code className="roles-table__slug">{role.slug}</code>
                    </td>
                    <td data-label="Permissions">{role.permissions?.length ?? 0}</td>
                    <td data-label="Actions" className="cell-actions-col">
                      <ActionMenu label={`Actions for ${role.name}`} items={getActionItems(role)} />
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
            className={`modal modal--wide roles-modal${isViewMode ? ' roles-modal--view' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={modalTitleId}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal__header">
              <h2 id={modalTitleId} className="modal__title">
                {modal.mode === 'create'
                  ? 'Add role'
                  : isViewMode
                    ? `View permissions: ${modal.role.name}`
                    : `Edit role: ${modal.role.name}`}
              </h2>
              <p className="modal__lead muted">
                {modal.mode === 'create'
                  ? 'Define a role with a unique slug and the permissions it should grant.'
                  : isViewMode
                    ? 'Read-only view of the permissions granted to this role.'
                    : slugLocked
                      ? 'Slug cannot be changed for this role. Permissions and display name can be updated.'
                      : 'Update the role details and permission set assigned to users.'}
              </p>
            </header>

            {isViewMode ? (
              <div className="modal__form">
                <div className="modal__body">
                  <div className="modal__field roles-modal__permissions-field">
                    <span className="label">Permissions</span>
                    {permissionGroups.length === 0 ? (
                      <p className="muted">Loading permission groups…</p>
                    ) : viewPermissions.length === 0 ? (
                      <p className="muted">No permissions assigned to this role.</p>
                    ) : (
                      <PermissionMatrix
                        groups={permissionGroups}
                        selected={viewPermissions}
                        onChange={() => {}}
                        disabled
                        hideActions
                      />
                    )}
                  </div>
                </div>

                <footer className="modal__footer">
                  <button type="button" className="btn btn-primary" onClick={closeModal} autoFocus>
                    Close
                  </button>
                </footer>
              </div>
            ) : (
            <form className="modal__form" onSubmit={handleSubmit}>
              <div className="modal__body">
                {modalError ? <div className="alert alert--error modal__alert">{modalError}</div> : null}

                <div className="roles-modal__fields-row">
                  <label className="modal__field form-field--sm">
                    <span className="label">Role name</span>
                    <input
                      autoFocus
                      className="input"
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      maxLength={80}
                      placeholder="e.g. Office admin"
                    />
                    <FieldError message={fieldErrors.name} />
                  </label>

                  {modal.mode === 'create' ? (
                    <label className="modal__field form-field--sm">
                      <span className="label">Slug</span>
                      <input
                        className="input input--narrow"
                        value={form.slug}
                        onChange={(event) =>
                          setForm({ ...form, slug: event.target.value.toLowerCase() })
                        }
                        maxLength={50}
                        placeholder="office-admin"
                      />
                      <FieldError message={fieldErrors.slug} />
                    </label>
                  ) : (
                    <div className="modal__field form-field--sm">
                      <span className="label">Slug</span>
                      <code className="roles-modal__slug-readonly">{form.slug}</code>
                    </div>
                  )}
                </div>

                <label className="modal__field">
                  <span className="label">Description</span>
                  <input
                    className="input"
                    value={form.description}
                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                    maxLength={500}
                    placeholder="Optional summary for admins"
                  />
                  <FieldError message={fieldErrors.description} />
                </label>

                <div className="modal__field roles-modal__permissions-field">
                  <span className="label">Permissions</span>
                  {permissionGroups.length === 0 ? (
                    <p className="muted">Loading permission groups…</p>
                  ) : (
                    <PermissionMatrix
                      groups={permissionGroups}
                      selected={form.permissions}
                      onChange={(permissions) => setForm({ ...form, permissions })}
                    />
                  )}
                  <FieldError message={fieldErrors.permissions} />
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
                      ? 'Create role'
                      : 'Save changes'}
                </button>
              </footer>
            </form>
            )}
          </div>
        </div>
      ) : null}

      {confirmDialog}
    </div>
  );
}
