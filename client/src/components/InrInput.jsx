import { useRef } from 'react';
import { formatInrInput } from '../utils/formatNumber.js';

function countNumericChars(str) {
  return (str.match(/[\d.]/g) || []).length;
}

function positionForNumericCount(formatted, count) {
  if (count <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i += 1) {
    if (/[\d.]/.test(formatted[i])) {
      seen += 1;
      if (seen === count) return i + 1;
    }
  }
  return formatted.length;
}

/**
 * Text input that shows Indian-style (en-IN) grouping while typing.
 * Stores the formatted display string in `value`; use parseInrInput before API submit.
 */
export default function InrInput({
  value,
  onChange,
  className = 'input',
  placeholder,
  disabled = false,
  id,
  name,
  'aria-label': ariaLabel,
}) {
  const inputRef = useRef(null);

  function handleChange(event) {
    const el = event.target;
    const cursor = el.selectionStart ?? el.value.length;
    const numericBefore = countNumericChars(el.value.slice(0, cursor));
    const next = formatInrInput(el.value);

    onChange(next);

    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      const pos = positionForNumericCount(next, numericBefore);
      node.setSelectionRange(pos, pos);
    });
  }

  return (
    <input
      ref={inputRef}
      id={id}
      name={name}
      className={className}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={value ?? ''}
      onChange={handleChange}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  );
}
