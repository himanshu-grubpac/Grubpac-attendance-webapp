import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PERMISSIONS } from '@shared/permissions.js';
import { adminApi, getErrorMessage } from '../../services/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { formatISTDateTime } from '../../utils/datetime.js';
import ActionMenu from '../../components/ActionMenu.jsx';
import PaginationBar from '../../components/PaginationBar.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import SearchInput from '../../components/SearchInput.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

function TableSkeleton() {
  return (
    <div className="skeleton-stack">
      <div className="skeleton skeleton--title" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

export default function AdminUsers() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canWriteUsers = hasPermission(PERMISSIONS.USERS_WRITE);
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const [employees, setEmployees] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 350);
  const skipDebouncedSearchRef = useRef(true);
  const requestKeyRef = useRef('');
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(true);

  async function loadEmployees(query = search, nextPage = page) {
    const requestKey = `${query ?? ''}|${nextPage}`;
    requestKeyRef.current = requestKey;
    setLoading(true);
    try {
      const data = await adminApi.listEmployees({
        search: query || undefined,
        page: nextPage,
        limit: 20,
      });
      if (requestKeyRef.current !== requestKey) return;
      setEmployees(data.employees);
      setPagination(data.pagination);
      setPage(nextPage);
      setListError('');
    } catch (err) {
      if (requestKeyRef.current !== requestKey) return;
      setListError(getErrorMessage(err));
    } finally {
      if (requestKeyRef.current === requestKey) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    loadEmployees('', 1);
  }, []);

  useEffect(() => {
    if (skipDebouncedSearchRef.current) {
      skipDebouncedSearchRef.current = false;
      return;
    }
    loadEmployees(debouncedSearch, 1);
  }, [debouncedSearch]);

  function goToEmployee(employee) {
    navigate(`/admin/users/${employee.id}`);
  }

  async function toggleStatus(employee) {
    const nextActive = !employee.isActive;
    await requestConfirm({
      title: nextActive ? 'Activate employee?' : 'Deactivate employee?',
      message: nextActive
        ? `Activate ${employee.name}? They will be able to sign in again.`
        : `Deactivate ${employee.name}? They will no longer be able to sign in.`,
      confirmLabel: nextActive ? 'Activate' : 'Deactivate',
      variant: nextActive ? 'default' : 'danger',
      onConfirm: async () => {
        await adminApi.updateEmployeeStatus(employee.id, nextActive);
        await loadEmployees(search, page);
      },
    });
  }

  function getActionItems(employee) {
    if (!canWriteUsers) return [];
    return [
      {
        key: 'employment',
        label: 'Edit employment details',
        onClick: () => navigate(`/admin/users/${employee.id}?edit=employment`),
      },
      {
        key: 'reset',
        label: 'Reset password',
        onClick: () => navigate(`/admin/users/${employee.id}?edit=reset`),
      },
      {
        key: 'toggle',
        label: employee.isActive ? 'Deactivate' : 'Activate',
        variant: employee.isActive ? 'danger' : 'default',
        onClick: () => toggleStatus(employee),
      },
    ];
  }

  function handleRowClick(employee, event) {
    if (event.target.closest('button, a, [role="menu"]')) return;
    goToEmployee(employee);
  }

  return (
    <div className="page">
      <div className="card card--table">
        <div className="card__toolbar">
          <SearchInput
            className="filter-bar__search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            ariaLabel="Search employees"
            onEnter={() => loadEmployees(search, 1)}
          />
        </div>

        {listError && <div className="alert alert--error">{listError}</div>}

        {loading ? (
          <TableSkeleton />
        ) : employees.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.users}
            title="No employees found"
            description={search ? 'Try a different search term.' : 'Register an employee to get started.'}
            action={
              !search && canWriteUsers ? (
                <Link to="/admin/users/register" className="btn btn-primary btn-sm">
                  Register employee
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <div className="table-wrap table-wrap--responsive table-wrap--actions">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Mobile</th>
                    <th>Department</th>
                    <th>Status</th>
                    <th className="cell-datetime">Last login</th>
                    {canWriteUsers ? <th className="cell-actions-col" aria-label="Actions" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {employees.map((employee) => (
                    <tr
                      key={employee.id}
                      className="table-row--clickable"
                      onClick={(event) => handleRowClick(employee, event)}
                    >
                      <td data-label="Name">
                        <Link
                          to={`/admin/users/${employee.id}`}
                          className="table-link"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {employee.name}
                        </Link>
                      </td>
                      <td data-label="Email" className="cell-ellipsis" title={employee.email}>
                        {employee.email}
                      </td>
                      <td data-label="Mobile">{employee.mobile}</td>
                      <td data-label="Department" className="cell-ellipsis">
                        {employee.departmentName || employee.department || '—'}
                      </td>
                      <td data-label="Status">
                        <StatusBadge active={employee.isActive} />
                      </td>
                      <td data-label="Last login" className="cell-datetime">
                        {formatISTDateTime(employee.lastLoginAt)}
                      </td>
                      {canWriteUsers ? (
                        <td data-label="Actions" className="cell-actions cell-actions--icon">
                          <ActionMenu
                            label={`Actions for ${employee.name}`}
                            items={getActionItems(employee)}
                          />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar pagination={pagination} onPageChange={(p) => loadEmployees(search, p)} />
          </>
        )}
      </div>

      {confirmDialog}
    </div>
  );
}
