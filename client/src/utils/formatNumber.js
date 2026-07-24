const inrGrouped = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
});

const inrCurrency = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
});

const inrInteger = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 0,
});

/**
 * Display a number with Indian grouping (e.g. 1,00,000).
 * Returns an em dash for null/empty/invalid values.
 */
export function formatInr(value) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return '—';
  return inrGrouped.format(Number(value));
}

/**
 * Display INR currency with Indian grouping (e.g. ₹1,00,000.00).
 */
export function formatInrCurrency(value) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return '—';
  return inrCurrency.format(Number(value));
}

/**
 * Format a value for a controlled money input (commas while typing).
 * Preserves a trailing decimal point and up to 2 fraction digits.
 */
export function formatInrInput(value) {
  if (value == null || value === '') return '';

  let raw = String(value).replace(/,/g, '');
  raw = raw.replace(/[^\d.]/g, '');

  const firstDot = raw.indexOf('.');
  if (firstDot !== -1) {
    raw = raw.slice(0, firstDot + 1) + raw.slice(firstDot + 1).replace(/\./g, '');
  }

  if (raw === '') return '';
  if (raw === '.') return '0.';

  const [intRaw, decRaw] = raw.split('.');
  const intDigits = intRaw === '' ? '0' : intRaw.replace(/^0+(?=\d)/, '');
  const formattedInt = inrInteger.format(Number(intDigits));

  if (raw.includes('.')) {
    return `${formattedInt}.${(decRaw ?? '').slice(0, 2)}`;
  }

  return formattedInt;
}

/**
 * Parse a formatted INR input string to a finite number, or '' when empty/invalid.
 */
export function parseInrInput(string) {
  if (string == null || String(string).trim() === '') return '';
  const cleaned = String(string).replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '.') return '';
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return '';
  return n;
}
