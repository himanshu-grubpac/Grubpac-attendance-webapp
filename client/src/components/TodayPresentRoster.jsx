import SelectField from './SelectField.jsx';

const DEFAULT_VISIBLE_COLUMNS = ['name', 'department', 'role', 'status'];

function isPresent(member) {
  return member.status === 'checked_in' || member.status === 'wfh';
}

function isOnLeave(member) {
  return member.status === 'on_leave';
}

function isInactive(member) {
  return member.status === 'inactive';
}

function TableSkeleton() {
  return (
    <div className="employees-table-skeleton" aria-busy="true" aria-label="Loading team status">
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

/**
 * Shared today-present roster: search + department/role toolbar + status
 * table. Used by the Today Present page (full list, infinite scroll) and
 * the admin dashboard (preview). Column prefs, pagination, and scroll
 * handling stay with the callers; this component only renders what it is
 * given. Department/role narrowing uses the same team-scoped API params as
 * the Employee List, so filters never widen visibility.
 */
export default function TodayPresentRoster({
  rows = [],
  loading = false,
  search = '',
  onSearchChange = null,
  searchPlaceholder = 'Search name, code, department, role',
  visibleColumns = DEFAULT_VISIBLE_COLUMNS,
  toolbarActions = null,
  footer = null,
  hasActiveSearch = false,
  tableWrapRef = null,
  departmentValue = '',
  onDepartmentChange = null,
  departmentOptions = [],
  showDepartmentFilter = true,
  roleValue = '',
  onRoleChange = null,
  roleOptions = [],
}) {
  const showColumn = (key) => visibleColumns.includes(key);
  const showFilters = onDepartmentChange || onRoleChange;

  return (
    <>
      {(onSearchChange || toolbarActions || showFilters) && (
        <div className="today-present-toolbar__row">
          {onSearchChange ? (
            <div className="search-input today-present-toolbar__search">
              <svg className="search-input__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="search"
                className="input search-input__field"
                placeholder={searchPlaceholder}
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                aria-label="Search team members"
              />
            </div>
          ) : null}
          {onDepartmentChange && showDepartmentFilter ? (
            <SelectField
              value={departmentValue}
              onChange={onDepartmentChange}
              options={departmentOptions}
              aria-label="Filter by department"
            />
          ) : null}
          {onRoleChange ? (
            <SelectField
              value={roleValue}
              onChange={onRoleChange}
              options={roleOptions}
              aria-label="Filter by role"
            />
          ) : null}
          {toolbarActions}
        </div>
      )}

      {loading ? (
        <TableSkeleton />
      ) : (
        <div ref={tableWrapRef} className="table-wrap table-wrap--responsive today-present-table-wrap">
          <table className="table data-table today-present-table">
            <thead>
              <tr>
                <th scope="col" className="today-present-table__col-num">#</th>
                {showColumn('name') && <th scope="col">Employee</th>}
                {showColumn('department') && <th scope="col">Department</th>}
                {showColumn('role') && <th scope="col">Role</th>}
                {showColumn('status') && <th scope="col">Status</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={visibleColumns.length + 1} className="muted small today-present-table__empty">
                    {hasActiveSearch ? 'No team members match this search.' : 'No team members found.'}
                  </td>
                </tr>
              ) : (
                rows.map((member, index) => {
                const present = isPresent(member);
                const onLeave = !present && isOnLeave(member);
                const inactive = !present && !onLeave && isInactive(member);
                // Note: kept as if/else (not nested ternary) — oxlint's
                // parser rejects nested ternaries with a false error.
                let badgeTone = 'absent';
                let badgeLabel = 'Absent';
                if (present) {
                  badgeTone = 'present';
                  badgeLabel = 'Present';
                } else if (onLeave) {
                  badgeTone = 'leave';
                  badgeLabel = 'On Leave';
                } else if (inactive) {
                  badgeTone = 'inactive';
                  badgeLabel = 'Inactive';
                }
                // Fall back to a positional key: rows without a userId must
                // never share a key (or mergeAppendUnique would drop them).
                const rowKey = member.userId ?? `row-${index}`;
                return (
                  <tr key={rowKey}>
                    <td className="today-present-table__col-num">{index + 1}</td>
                    {showColumn('name') && (
                      <td data-label="Employee" className="today-present-table__employee">
                        <span className="today-present-table__name">
                          {member.firstName ||
                            member.name?.split(' ')[0] ||
                            'Team Member'}
                        </span>
                        {member.employeeCode && (
                          <span className="today-present-table__code muted small">
                            {' '}
                            ({member.employeeCode})
                          </span>
                        )}
                      </td>
                    )}
                    {showColumn('department') && <td data-label="Department">{member.department ?? '—'}</td>}
                    {showColumn('role') && <td data-label="Role">{member.roleName ?? '—'}</td>}
                    {showColumn('status') && (
                      <td data-label="Status">
                        <span
                          className={`today-present-table__badge today-present-table__badge--${badgeTone}`}
                        >
                          {badgeLabel}
                        </span>
                      </td>
                    )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {footer}
    </>
  );
}
