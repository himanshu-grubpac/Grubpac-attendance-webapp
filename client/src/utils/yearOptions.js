/**
 * Dynamic year dropdowns (§8 rule): oldest employee joining year through the
 * current year — never hardcoded windows, never future years (unless a page
 * explicitly opts into next-year planning via `includeNextYear`).
 *
 * When the oldest year is unknown (stats unavailable), falls back to the
 * legacy currentYear-4 window so the UI keeps working.
 */
const FALLBACK_SPAN = 4;

export function buildDynamicYearOptions(oldestYear, currentYear, options = {}) {
  const { leading = null, includeNextYear = false } = options;
  const from = Number.isInteger(oldestYear)
    ? Math.min(oldestYear, currentYear)
    : currentYear - FALLBACK_SPAN;
  const to = includeNextYear ? currentYear + 1 : currentYear;
  const years = [];
  for (let year = to; year >= from; year -= 1) {
    years.push({ value: String(year), label: String(year) });
  }
  return leading ? [leading, ...years] : years;
}
