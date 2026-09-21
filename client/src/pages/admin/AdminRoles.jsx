import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { broadcastPermissionsSync } from '../../utils/portalSync.js';
import ActionMenu from '../../components/ActionMenu.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SearchInput from '../../components/SearchInput.jsx';

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

export default function AdminRoles() {
  const navigate = useNavigate();
  const { showSuccess } = useToast();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();

  const [roles, setRoles] = useState([]);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
      const rolesData = await adminApi.listRoles();
      if (requestKeyRef.current !== requestKey) return;
      setRoles(rolesData.roles ?? []);
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

  async function deleteRole(role) {
    await requestConfirm({
      title: 'Delete role?',
      message: `Permanently delete "${role.name}" (${role.slug})? Roles assigned to employees must be reassigned first.`,
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        await adminApi.deleteRole(role.id);
        broadcastPermissionsSync();
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
        onClick: () => navigate(`/admin/roles/${role.id}?mode=view`),
      },
      {
        key: 'edit',
        label: 'Edit role',
        onClick: () => navigate(`/admin/roles/${role.id}`),
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
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => navigate('/admin/roles/new')}
            >
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
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => navigate('/admin/roles/new')}
                >
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
                      <Link to={`/admin/roles/${role.id}`} className="roles-table__name-link">
                        <span className="roles-table__name-text">{role.name}</span>
                      </Link>
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

      {confirmDialog}
    </div>
  );
}
