/**
 * Dynamic year dropdowns: oldest employee joining year through the current IST
 * year — no hardcoded windows, no future years in leave/salary selectors.
 *
 * `includeNextYear` exists for non-leave edge cases only; leave module must
 * not pass it.
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
