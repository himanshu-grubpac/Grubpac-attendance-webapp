/**
 * Append a freshly fetched page onto an infinite-scroll list without
 * duplicating rows. Offset pagination can return overlapping rows when
 * concurrent writes (register/deactivate) shift offsets between page
 * fetches, which would otherwise surface as duplicate React keys.
 */
export function mergeAppendUnique(current, fresh, getId = (item) => item?.id) {
  const base = Array.isArray(current) ? current : [];
  if (!Array.isArray(fresh) || fresh.length === 0) return base;
  // Only defined ids participate in dedupe: rows without an id can never
  // be proven duplicates, so they are always appended (collapsing them
  // would silently drop visible rows).
  const seen = new Set();
  for (const item of base) {
    const id = getId(item);
    if (id !== undefined && id !== null) seen.add(id);
  }
  const deduped = fresh.filter((item) => {
    const id = getId(item);
    if (id === undefined || id === null) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return deduped.length === 0 ? base : [...base, ...deduped];
}
