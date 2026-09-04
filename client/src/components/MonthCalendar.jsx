import { useMemo } from 'react';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const STATUS_LABELS = {
  present: 'Present',
  half_day: 'Half day',
  leave: 'Leave',
  leave_future: 'Approved leave (upcoming)',
  wfh_pending: 'WFH pending approval',
  wfh: 'WFH',
  wfh_future: 'Approved WFH (upcoming)',
  holiday: 'Holiday',
  absent: 'Absent / LOP',
  weekend: 'Weekend',
  future: 'Upcoming',
  none: 'No mark',
};

/** Short in-cell tags (leave stays color-only; WFH is labeled explicitly). */
const STATUS_CELL_TAGS = {
  wfh_pending: 'WFH',
  wfh: 'WFH',
  wfh_future: 'WFH',
};

function getMonthMatrix(year, monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const firstDay = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const startWeekday = (firstDay.getUTCDay() + 6) % 7;

  const cells = [];
  for (let i = 0; i < startWeekday; i += 1) {
    cells.push(null);
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(`${monthKey}-${String(day).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  return { year: y, month: m, cells };
}

function formatMonthTitle(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(Date.UTC(y, m - 1, 15)));
}

function formatBirthdayLabel(entry) {
  const first = (entry?.firstName || entry?.name || '').trim();
  if (!first) return 'Birthday';
  return `${first}'s birthday`;
}

function buildCellMeta(dayKey, status, holidays, birthdays) {
  const holiday = holidays?.[dayKey];
  const dayBirthdays = birthdays?.[dayKey] ?? [];
  const holidayName = holiday?.name?.trim() || '';
  const birthdayLabels = dayBirthdays.map(formatBirthdayLabel);
  const detailParts = [];
  if (status === 'holiday' && holidayName) {
    detailParts.push(holidayName);
  } else if (status !== 'none') {
    detailParts.push(STATUS_LABELS[status] ?? status);
  }
  detailParts.push(...birthdayLabels);

  const title = detailParts.length ? `${dayKey}: ${detailParts.join(' · ')}` : dayKey;
  const ariaExtra = detailParts.length ? `, ${detailParts.join(', ')}` : '';

  return {
    holidayName,
    birthdayLabels,
    title,
    ariaExtra,
    hasBirthday: birthdayLabels.length > 0,
  };
}

export default function MonthCalendar({
  month,
  days = {},
  holidays = {},
  birthdays = {},
  today,
  loading = false,
  onPrev,
  onNext,
  onToday,
  compact = false,
}) {
  const matrix = useMemo(() => getMonthMatrix(null, month), [month]);

  return (
    <div className={`month-calendar${compact ? ' month-calendar--compact' : ''}`}>
      <div className="month-calendar__header">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onPrev} aria-label="Previous month">
          ‹
        </button>
        <div className="month-calendar__title-wrap">
          <strong className="month-calendar__title">{formatMonthTitle(month)}</strong>
          {onToday ? (
            <button type="button" className="btn btn-ghost btn-sm month-calendar__today" onClick={onToday}>
              Today
            </button>
          ) : null}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onNext} aria-label="Next month">
          ›
        </button>
      </div>

      <div className="month-calendar__weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label} className="month-calendar__weekday">
            {label}
          </span>
        ))}
      </div>

      {loading ? (
        <div className="skeleton-stack month-calendar__loading" aria-hidden="true">
          <div className="skeleton skeleton--calendar" />
        </div>
      ) : (
        <div className="month-calendar__grid" role="grid" aria-label={`Attendance calendar for ${formatMonthTitle(month)}`}>
          {matrix.cells.map((dayKey, index) => {
            if (!dayKey) {
              return <span key={`empty-${index}`} className="month-calendar__cell month-calendar__cell--empty" />;
            }

            const status = days[dayKey] ?? 'none';
            const dayNum = Number(dayKey.slice(-2));
            const isToday = dayKey === today;
            const meta = buildCellMeta(dayKey, status, holidays, birthdays);
            const showHolidayName = Boolean(meta.holidayName);
            const showBirthday = meta.hasBirthday;
            const statusTag = STATUS_CELL_TAGS[status] ?? null;
            const primaryLabel = showHolidayName
              ? meta.holidayName
              : showBirthday
                ? meta.birthdayLabels[0]
                : statusTag;
            const secondaryLabel =
              showHolidayName && showBirthday
                ? meta.birthdayLabels[0]
                : showBirthday && meta.birthdayLabels.length > 1
                  ? `+${meta.birthdayLabels.length - 1} more`
                  : showBirthday && statusTag
                    ? statusTag
                    : null;

            return (
              <span
                key={dayKey}
                role="gridcell"
                className={`month-calendar__cell month-calendar__cell--${status}${isToday ? ' month-calendar__cell--today' : ''}${showBirthday ? ' month-calendar__cell--birthday' : ''}`}
                title={meta.title}
                aria-label={`${dayNum}${meta.ariaExtra}${isToday ? ', today' : ''}`}
              >
                <span className="month-calendar__day">{dayNum}</span>
                {primaryLabel ? (
                  <span className="month-calendar__note" aria-hidden="true">
                    {primaryLabel}
                  </span>
                ) : null}
                {secondaryLabel ? (
                  <span className="month-calendar__note month-calendar__note--secondary" aria-hidden="true">
                    {secondaryLabel}
                  </span>
                ) : null}
              </span>
            );
          })}
        </div>
      )}

      <div className="month-calendar__legend" aria-label="Calendar legend">
        {['present', 'half_day', 'leave', 'leave_future', 'wfh_pending', 'wfh', 'wfh_future', 'holiday', 'absent', 'weekend', 'none'].map((status) => (
          <span key={status} className="month-calendar__legend-item">
            <span className={`month-calendar__swatch month-calendar__swatch--${status}`} aria-hidden="true" />
            {STATUS_LABELS[status]}
          </span>
        ))}
        <span className="month-calendar__legend-item">
          <span className="month-calendar__swatch month-calendar__swatch--birthday" aria-hidden="true" />
          Birthday
        </span>
      </div>
    </div>
  );
}
