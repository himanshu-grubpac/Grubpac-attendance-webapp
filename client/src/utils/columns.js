/**
 * Restrict a column-editor inventory to the keys the caller is permitted to
 * see (RBAC allow-list from GET /preferences/tables/:key/columns).
 * A null/undefined allow-list means "not loaded yet" — fail open to the
 * full inventory; the server still enforces per-column permission on save.
 */
export function filterAllowedColumns(allColumns, allowedKeys) {
  if (!Array.isArray(allowedKeys)) return allColumns;
  const allowed = new Set(allowedKeys);
  return allColumns.filter((col) => allowed.has(col.key));
}
