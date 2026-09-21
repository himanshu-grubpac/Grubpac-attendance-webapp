import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { slugsFromRow } from '@shared/permissionCatalog.js';
import SearchInput from './SearchInput.jsx';

const CRUD_COLUMNS = [
  { key: 'create', label: 'Create', short: 'C' },
  { key: 'read', label: 'Read', short: 'R' },
  { key: 'update', label: 'Update', short: 'U' },
  { key: 'delete', label: 'Delete', short: 'D' },
];

/** Human labels for common extra-action slugs (presentation only). */
const EXTRA_ACTION_LABELS = {
  'employees.record.x0': 'Bulk import',
  'employees.salary_history.x0': 'Export',
  'employees.credentials.x0': 'Reset',
  'employees.credentials.x1': 'Send credentials',
  'employees.credentials.x2': 'Reset PIN',
  'employees.status.x0': 'Deactivate',
  'employees.status.x1': 'Reactivate',
  'employees.register.x0': 'Download template',
  'employees.register.x1': 'Sync preview',
  'employees.register.x2': 'Export',
  'employees.bulk_export.x0': 'Export',
  'employees.bulk_upload.x0': 'Download template',
  'salary.payroll.x0': 'Export',
  'salary.transfer.x0': 'Generate transfers',
  'salary.transfer.x1': 'Export',
  'salary.transfer.x2': 'Download template',
  'salary.settlement.x0': 'Settle month',
  'salary.audit.x0': 'Export bulk',
  'salary.team_audit.x0': 'Export single',
  'attendance.record.x0': 'Confirm week',
  'attendance.record.x1': 'Export',
  'attendance.record.x2': 'Sync preview',
  'leave.type.x0': 'Policy override',
  'leave.adjustment.x0': 'Bulk upload',
  'leave.adjustment.x1': 'Encash',
  'leave.request.x0': 'Approve',
  'leave.request.x1': 'Reject',
  'leave.wfh.x0': 'Approve',
  'leave.wfh.x1': 'Reject',
  'leave.compoff.x0': 'Approve',
  'leave.compoff.x1': 'Assess',
  'attendance.late_warning.x0': 'Reset',
  'attendance.late_warning.x1': 'Export',
  'leave.recurring.x0': 'Run accrual',
  'ops.geofence.x0': 'Export',
  'ops.faq.x0': 'Reorder',
  'ops.faq.x1': 'Publish',
  'ops.department.x0': 'Bulk import',
  'ops.department.x1': 'Export',
  'ops.department.x2': 'Download template',
  'rbac.role.x0': 'Assign to users',
  'audit.log.x0': 'Export',
  'audit.log.x1': 'Run archive',
  'help.ticket.x0': 'Set Priority',
  'help.ticket.x1': 'Close',
  'help.ticket.x2': 'Download attachment',
  'emp.punch.x0': 'Undo punch',
  'emp.requests.x0': 'Withdraw',
  'emp.ticket.x0': 'Download attachment',
};

function getPrimarySlug(catalogRow) {
  return (
    catalogRow.read ||
    catalogRow.create ||
    catalogRow.update ||
    catalogRow.delete ||
    catalogRow.extras?.[0] ||
    ''
  );
}

function getSlugCaption(catalogRow) {
  const slug = getPrimarySlug(catalogRow);
  const parts = slug.split('.');
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`;
  return slug;
}

function deriveModule(catalogRow) {
  const slug = getPrimarySlug(catalogRow);
  const domain = slug.split('.')[0];
  const resource = slug.split('.')[1] ?? '';

  if (domain === 'emp') {
    if (['punch', 'calendar', 'attendance'].includes(resource)) {
      return { key: 'attendance', label: 'Attendance', order: 3 };
    }
    if (['leave', 'wfh', 'compoff', 'balance', 'policy_summary', 'requests'].includes(resource)) {
      return { key: 'leave', label: 'Leave', order: 4 };
    }
    if (resource === 'pay') return { key: 'salary', label: 'Salary & Payroll', order: 5 };
    if (['ticket', 'faq'].includes(resource)) {
      return { key: 'help', label: 'Help & Support', order: 6 };
    }
    if (['dashboard', 'team_today'].includes(resource)) {
      return { key: 'overview', label: 'Overview', order: 1 };
    }
  }

  const domainModules = {
    portal: { key: 'account', label: 'Account & Access', order: 0 },
    account: { key: 'account', label: 'Account & Access', order: 0 },
    dashboard: { key: 'overview', label: 'Overview', order: 1 },
    employees: { key: 'employees', label: 'Employees', order: 2 },
    attendance: { key: 'attendance', label: 'Attendance', order: 3 },
    leave: { key: 'leave', label: 'Leave', order: 4 },
    salary: { key: 'salary', label: 'Salary & Payroll', order: 5 },
    help: { key: 'help', label: 'Help & Support', order: 6 },
    ops: { key: 'operations', label: 'Operations', order: 7 },
    rbac: { key: 'rbac', label: 'Roles & Access', order: 8 },
    audit: { key: 'audit', label: 'Audit', order: 9 },
  };

  return (
    domainModules[domain] ?? {
      key: domain || 'other',
      label: catalogRow.navGroup || 'Other',
      order: 99,
    }
  );
}

function deriveScope(catalogRow) {
  const slug = getPrimarySlug(catalogRow);
  if (slug.startsWith('emp.') || /\bown\b/i.test(catalogRow.resource)) {
    return 'Own';
  }
  if (catalogRow.portal === 'Employee') return 'Own';

  const teamPatterns =
    /^(employees\.(record|stats|salary_column|account|employment|salary|salary_history|credentials|status|delegate)|attendance\.(record|log|warning_col|today)|leave\.(request|wfh|compoff)|help\.ticket|salary\.team_audit|rbac\.user)/;

  if (teamPatterns.test(slug)) return 'Team';
  if (catalogRow.reportingManager === 'R') return 'Team';

  return null;
}

function labelForExtra(slug, metadata) {
  if (EXTRA_ACTION_LABELS[slug]) return EXTRA_ACTION_LABELS[slug];
  const note = metadata?.[slug]?.notes;
  if (note && note.length <= 40) return note;
  const action = slug.split('.').pop();
  if (action?.startsWith('x')) return `Action ${action.slice(1)}`;
  return action ?? slug;
}

function rowMatchesSearch(catalogRow, query, metadata) {
  const haystack = [
    catalogRow.resource,
    catalogRow.page,
    catalogRow.navGroup,
    getSlugCaption(catalogRow),
    ...slugsFromRow(catalogRow),
    ...slugsFromRow(catalogRow).map((slug) => labelForExtra(slug, metadata)),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function buildGroupedCatalog(catalog, metadata) {
  /** @type {Map<string, { key: string, label: string, order: number, pages: Map<string, typeof catalog> }>} */
  const modules = new Map();

  for (const catalogRow of catalog) {
    const mod = deriveModule(catalogRow);
    if (!modules.has(mod.key)) {
      modules.set(mod.key, { ...mod, pages: new Map() });
    }
    const pageKey = catalogRow.page || catalogRow.navGroup || 'General';
    const moduleEntry = modules.get(mod.key);
    if (!moduleEntry.pages.has(pageKey)) {
      moduleEntry.pages.set(pageKey, []);
    }
    moduleEntry.pages.get(pageKey).push(catalogRow);
  }

  return [...modules.values()]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map((mod) => ({
      ...mod,
      pages: [...mod.pages.entries()].map(([pageLabel, rows]) => ({
        pageLabel,
        rows: rows.sort((a, b) => a.row - b.row),
      })),
    }));
}

function countSelectedInModule(module, selected) {
  const slugs = module.pages.flatMap((page) => page.rows.flatMap((row) => slugsFromRow(row)));
  const selectedCount = slugs.filter((slug) => selected.includes(slug)).length;
  return { selectedCount, totalCount: slugs.length, slugs };
}

export default function RbacPermissionGrid({
  catalog = [],
  metadata = {},
  totalSlugs = 0,
  selected = [],
  onChange,
  disabled = false,
  hideActions = false,
}) {
  const gridId = useId();
  const [search, setSearch] = useState('');
  const [collapsedModules, setCollapsedModules] = useState(() => new Set());

  const grouped = useMemo(() => buildGroupedCatalog(catalog, metadata), [catalog, metadata]);

  const computedTotalSlugs = useMemo(() => {
    const seen = new Set();
    for (const row of catalog) {
      for (const slug of slugsFromRow(row)) seen.add(slug);
    }
    return seen.size;
  }, [catalog]);

  const assignableTotal = totalSlugs || computedTotalSlugs;

  const selectedCount = useMemo(() => {
    const assignable = new Set();
    for (const row of catalog) {
      for (const slug of slugsFromRow(row)) assignable.add(slug);
    }
    return selected.filter((slug) => assignable.has(slug)).length;
  }, [catalog, selected]);

  const progressPct =
    assignableTotal > 0 ? Math.round((selectedCount / assignableTotal) * 100) : 0;

  const query = search.trim().toLowerCase();

  const filteredGrouped = useMemo(() => {
    if (!query) return grouped;
    return grouped
      .map((mod) => ({
        ...mod,
        pages: mod.pages
          .map((page) => ({
            ...page,
            rows: page.rows.filter((row) => rowMatchesSearch(row, query, metadata)),
          }))
          .filter((page) => page.rows.length > 0),
      }))
      .filter((mod) => mod.pages.length > 0);
  }, [grouped, query, metadata]);

  const toggleSlug = useCallback(
    (slug) => {
      if (disabled || !slug) return;
      onChange(
        selected.includes(slug)
          ? selected.filter((item) => item !== slug)
          : [...selected, slug],
      );
    },
    [disabled, onChange, selected],
  );

  const toggleModule = useCallback(
    (module) => {
      if (disabled) return;
      const { slugs, selectedCount: modSelected, totalCount } = countSelectedInModule(
        module,
        selected,
      );
      if (modSelected === totalCount && totalCount > 0) {
        onChange(selected.filter((slug) => !slugs.includes(slug)));
        return;
      }
      onChange([...new Set([...selected, ...slugs])]);
    },
    [disabled, onChange, selected],
  );

  const expandAll = useCallback(() => setCollapsedModules(new Set()), []);
  const collapseAll = useCallback(() => {
    setCollapsedModules(new Set(grouped.map((mod) => mod.key)));
  }, [grouped]);

  const clearAll = useCallback(() => {
    if (disabled) return;
    onChange([]);
  }, [disabled, onChange]);

  function toggleModuleCollapse(moduleKey) {
    setCollapsedModules((prev) => {
      const next = new Set(prev);
      if (next.has(moduleKey)) next.delete(moduleKey);
      else next.add(moduleKey);
      return next;
    });
  }

  if (catalog.length === 0) {
    return <p className="muted">Loading permission catalog…</p>;
  }

  return (
    <div className="rbac-grid" role="region" aria-label="Role permissions">
      <div className="rbac-grid__toolbar">
        <SearchInput
          className="rbac-grid__search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search a module or resource…"
          ariaLabel="Filter permissions"
        />
        {hideActions ? null : (
          <div className="rbac-grid__toolbar-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={expandAll}>
              Expand all
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={collapseAll}>
              Collapse all
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm rbac-grid__clear"
              onClick={clearAll}
              disabled={disabled || selectedCount === 0}
            >
              Clear all
            </button>
          </div>
        )}
        <div className="rbac-grid__progress" aria-live="polite">
          <span className="rbac-grid__progress-label">
            {selectedCount} of {assignableTotal} selected
          </span>
          <div
            className="rbac-grid__progress-bar"
            role="progressbar"
            aria-valuenow={selectedCount}
            aria-valuemin={0}
            aria-valuemax={assignableTotal}
            aria-label={`${selectedCount} of ${assignableTotal} permissions selected`}
          >
            <span className="rbac-grid__progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      </div>

      <div className="rbac-grid__table-wrap roles-permissions">
        <table className="rbac-grid__table" aria-labelledby={gridId}>
          <caption id={gridId} className="visually-hidden">
            Permission matrix — select CRUD actions and extra permissions for this role
          </caption>
          <thead>
            <tr>
              <th scope="col" className="rbac-grid__col-resource">
                Module / Resource
              </th>
              <th scope="col" className="rbac-grid__col-scope">
                Scope
              </th>
              {CRUD_COLUMNS.map((col) => (
                <th key={col.key} scope="col" className="rbac-grid__col-crud" title={col.label}>
                  {col.short}
                </th>
              ))}
              <th scope="col" className="rbac-grid__col-extras">
                Actions beyond CRUD
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredGrouped.length === 0 ? (
              <tr>
                <td colSpan={7} className="rbac-grid__empty muted">
                  No permissions match your search.
                </td>
              </tr>
            ) : (
              filteredGrouped.map((mod) => {
                const { selectedCount: modSelected, totalCount: modTotal } = countSelectedInModule(
                  mod,
                  selected,
                );
                const isCollapsed = collapsedModules.has(mod.key);
                const allModuleSelected = modSelected === modTotal && modTotal > 0;
                const someModuleSelected = modSelected > 0 && !allModuleSelected;

                return (
                  <ModuleSection
                    key={mod.key}
                    module={mod}
                    isCollapsed={isCollapsed}
                    modSelected={modSelected}
                    modTotal={modTotal}
                    allModuleSelected={allModuleSelected}
                    someModuleSelected={someModuleSelected}
                    selected={selected}
                    metadata={metadata}
                    disabled={disabled}
                    hideActions={hideActions}
                    onToggleCollapse={() => toggleModuleCollapse(mod.key)}
                    onToggleModule={() => toggleModule(mod)}
                    onToggleSlug={toggleSlug}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModuleToggle({ id, checked, indeterminate, disabled, onChange }) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <label className="rbac-grid__module-toggle checkbox-row checkbox-row--inline">
      <input
        id={id}
        ref={inputRef}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="checkbox-row__label">Select whole module</span>
    </label>
  );
}

function ModuleSection({
  module,
  isCollapsed,
  modSelected,
  modTotal,
  allModuleSelected,
  someModuleSelected,
  selected,
  metadata,
  disabled,
  hideActions,
  onToggleCollapse,
  onToggleModule,
  onToggleSlug,
}) {
  const moduleToggleId = useId();

  return (
    <>
      <tr className="rbac-grid__module-row">
        <td colSpan={7}>
          <div className="rbac-grid__module-header">
            <button
              type="button"
              className="rbac-grid__module-collapse"
              onClick={onToggleCollapse}
              aria-expanded={!isCollapsed}
              aria-controls={`module-${module.key}`}
            >
              <span className="rbac-grid__chevron" aria-hidden="true">
                {isCollapsed ? '▸' : '▾'}
              </span>
              <span className="rbac-grid__module-title">{module.label}</span>
              <span className="rbac-grid__module-count muted">
                {modSelected} of {modTotal} selected
              </span>
              <code className="rbac-grid__module-slug">{module.key}</code>
            </button>
            {hideActions ? null : (
              <ModuleToggle
                id={moduleToggleId}
                checked={allModuleSelected}
                indeterminate={someModuleSelected}
                disabled={disabled || modTotal === 0}
                onChange={onToggleModule}
              />
            )}
          </div>
        </td>
      </tr>
      {!isCollapsed
        ? module.pages.map((page) => (
            <PageRows
              key={`${module.key}-${page.pageLabel}`}
              moduleKey={module.key}
              page={page}
              selected={selected}
              metadata={metadata}
              disabled={disabled}
              onToggleSlug={onToggleSlug}
            />
          ))
        : null}
    </>
  );
}

function PageRows({ moduleKey, page, selected, metadata, disabled, onToggleSlug }) {
  return (
    <>
      <tr className="rbac-grid__section-row" id={`module-${moduleKey}`}>
        <td colSpan={7}>
          <span className="rbac-grid__section-label">{page.pageLabel.toUpperCase()}</span>
        </td>
      </tr>
      {page.rows.map((catalogRow) => (
        <ResourceRow
          key={catalogRow.row}
          catalogRow={catalogRow}
          selected={selected}
          metadata={metadata}
          disabled={disabled}
          onToggleSlug={onToggleSlug}
        />
      ))}
    </>
  );
}

function ResourceRow({ catalogRow, selected, metadata, disabled, onToggleSlug }) {
  const scope = deriveScope(catalogRow);
  const slugCaption = getSlugCaption(catalogRow);
  const extras = catalogRow.extras ?? [];

  return (
    <tr className="rbac-grid__row">
      <td className="rbac-grid__resource-cell">
        <span className="rbac-grid__resource-label">{catalogRow.resource}</span>
        <code className="rbac-grid__resource-slug muted">{slugCaption}</code>
      </td>
      <td className="rbac-grid__scope-cell">
        {scope ? (
          <span className={`rbac-grid__scope-badge rbac-grid__scope-badge--${scope.toLowerCase()}`}>
            {scope}
          </span>
        ) : (
          <span className="rbac-grid__na" aria-hidden="true">
            —
          </span>
        )}
      </td>
      {CRUD_COLUMNS.map((col) => {
        const slug = catalogRow[col.key];
        if (!slug) {
          return (
            <td key={col.key} className="rbac-grid__crud-cell">
              <span className="rbac-grid__na" aria-hidden="true">
                —
              </span>
            </td>
          );
        }
        const checked = selected.includes(slug);
        return (
          <td key={col.key} className="rbac-grid__crud-cell">
            <label className="rbac-grid__crud-check">
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                aria-label={`${col.label} — ${catalogRow.resource}`}
                onChange={() => onToggleSlug(slug)}
              />
              <span className="visually-hidden">
                {col.label} {catalogRow.resource}
              </span>
            </label>
          </td>
        );
      })}
      <td className="rbac-grid__extras-cell">
        {extras.length === 0 ? (
          <span className="rbac-grid__na" aria-hidden="true">
            —
          </span>
        ) : (
          <div className="rbac-grid__action-chips" role="group" aria-label={`Extra actions for ${catalogRow.resource}`}>
            {extras.map((slug) => {
              const checked = selected.includes(slug);
              return (
                <label
                  key={slug}
                  className={`rbac-grid__action-chip${checked ? ' rbac-grid__action-chip--checked' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => onToggleSlug(slug)}
                  />
                  <span>{labelForExtra(slug, metadata)}</span>
                </label>
              );
            })}
          </div>
        )}
      </td>
    </tr>
  );
}
