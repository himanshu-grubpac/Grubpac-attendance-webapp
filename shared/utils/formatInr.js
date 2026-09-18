const inrNumber = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrCurrency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrInteger = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 0,
});

const inrGrouped = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
});

function isValidNumber(value) {
  if (value == null || value === '') return false;
  return Number.isFinite(Number(value));
}

/**
 * Indian-grouped number for exports (e.g. 1,00,000.00). Null/invalid → ''.
 */
export function formatInrNumber(value) {
  if (!isValidNumber(value)) return '';
  return inrNumber.format(Number(value));
}

/**
 * INR currency for display (e.g. ₹1,00,000.00). Null/invalid → '—'.
 */
export function formatInrCurrency(value) {
  if (!isValidNumber(value)) return '—';
  return inrCurrency.format(Number(value));
}

/**
 * Indian-grouped integer (e.g. 1,00,000). Null/invalid → ''.
 */
export function formatInrInteger(value) {
  if (!isValidNumber(value)) return '';
  return inrInteger.format(Number(value));
}

/**
 * General display helper with Indian grouping (up to 2 decimals). Null/invalid → '—'.
 */
export function formatInr(value) {
  if (!isValidNumber(value)) return '—';
  return inrGrouped.format(Number(value));
}
