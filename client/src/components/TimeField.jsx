import { useEffect, useState } from 'react';

const HHMM_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function isValidHHmmTime(value) {
  return HHMM_PATTERN.test(String(value ?? '').trim());
}

export function formatTimeDisplay(value) {
  const match = HHMM_PATTERN.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

export function normalizeHHmmTime(value) {
  const match = HHMM_PATTERN.exec(String(value ?? '').trim());
  if (!match) return null;
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
}

function toParts(value) {
  const normalized = normalizeHHmmTime(value) ?? '09:00';
  const [hour24, minute] = normalized.split(':').map(Number);
  return { hour: hour24 % 12 || 12, minute, period: hour24 >= 12 ? 'PM' : 'AM' };
}

/** A 12-hour-only time control. The API value remains HH:mm for reliable policy evaluation. */
export default function TimeField({ value, onChange, disabled = false, id, 'aria-label': ariaLabel, className = '' }) {
  const parts = toParts(value);
  const [hourText, setHourText] = useState(String(parts.hour));
  const [minuteText, setMinuteText] = useState(String(parts.minute).padStart(2, '0'));

  useEffect(() => {
    const currentParts = toParts(value);
    setHourText(String(currentParts.hour));
    setMinuteText(String(currentParts.minute).padStart(2, '0'));
  }, [value]);

  function commit(hourValue = hourText, minuteValue = minuteText, period = parts.period) {
    const hour = Number(hourValue);
    const minute = Number(minuteValue);
    if (!Number.isInteger(hour) || hour < 1 || hour > 12 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      setHourText(String(parts.hour));
      setMinuteText(String(parts.minute).padStart(2, '0'));
      return;
    }
    const hour24 = period === 'PM' ? (hour % 12) + 12 : hour % 12;
    onChange(`${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  }

  function onTextChange(setter) {
    return (event) => {
      const next = event.target.value.replace(/\D/g, '').slice(0, 2);
      setter(next);
    };
  }

  return (
    <div className={['time-field', className].filter(Boolean).join(' ')} aria-label={ariaLabel}>
      <input id={id} className="time-field__input" type="text" inputMode="numeric" maxLength="2" value={hourText} disabled={disabled} aria-label="Hour (1 to 12)" onChange={onTextChange(setHourText)} onBlur={() => commit()} />
      <span className="time-field__separator" aria-hidden="true">:</span>
      <input className="time-field__input" type="text" inputMode="numeric" maxLength="2" value={minuteText} disabled={disabled} aria-label="Minute (00 to 59)" onChange={onTextChange(setMinuteText)} onBlur={() => commit()} />
      <div className="time-field__period" role="group" aria-label="AM or PM">
        {['AM', 'PM'].map((period) => (
          <button
            key={period}
            type="button"
            className={`time-field__period-button${parts.period === period ? ' time-field__period-button--active' : ''}`}
            aria-pressed={parts.period === period}
            disabled={disabled}
            onClick={() => commit(hourText, minuteText, period)}
          >
            {period}
          </button>
        ))}
      </div>
    </div>
  );
}
