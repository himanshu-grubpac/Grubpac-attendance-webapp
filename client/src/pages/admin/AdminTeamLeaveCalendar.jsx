import { useEffect, useMemo, useState } from 'react';
import { formatISTDate, getISTDateInputValue } from '../../utils/datetime.js';
import { leaveApi, getErrorMessage } from '../../services/api.js';
import LeaveStatusBadge from '../../components/LeaveStatusBadge.jsx';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';
import MonthField from '../../components/MonthField.jsx';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function currentMonthInput() {
  return getISTDateInputValue().slice(0, 7);
}

/**
 * Normalize any API date (Date, ISO string, or YYYY-MM-DD) to an IST calendar day key.
 */
function toIstDayKey(value) {
  if (value == null || value === '') return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) return getISTDateInputValue(date);
    return null;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return getISTDateInputValue(value);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return getISTDateInputValue(date);
}

function leaveTypeLabel(item) {
  if (item.leaveTypeCode && item.leaveTypeName) {
    return `${item.leaveTypeCode} — ${item.leaveTypeName}`;
  }
  return item.leaveTypeCode || item.leaveTypeName || 'Leave';
}

function dateRangeLabel(item) {
  const start = formatISTDate(item.startDate);
  const end = formatISTDate(item.endDate);
  if (start === end) return start;
  return `${start} – ${end}`;
}

function durationLabel(item) {
  const value = Number(item.days);
  if (!Number.isFinite(value)) return '—';
  const startKey = toIstDayKey(item.startDate);
  const endKey = toIstDayKey(item.endDate);
  const spansMultipleCalendarDays = Boolean(startKey && endKey && startKey !== endKey);
  const unit = value === 1 ? 'working day' : 'working days';
  if (spansMultipleCalendarDays) {
    return `${value} ${unit} (weekends/holidays excluded)`;
  }
  return `${value} ${unit}`;
}

function isVisibleOnTeamCalendar(status) {
  // Only leave approved from Approvals appears on the team calendar.
  return status === 'approved';
}

function entryCoversDay(entry, dayKey) {
  if (!dayKey || !isVisibleOnTeamCalendar(entry.status)) return false;
  const startKey = toIstDayKey(entry.startDate);
  const endKey = toIstDayKey(entry.endDate);
  if (!startKey || !endKey) return false;
  return dayKey >= startKey && dayKey <= endKey;
}

function buildTeamLeaveGrid(month, entries) {
  const [year, monthNum] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const firstDay = new Date(Date.UTC(year, monthNum - 1, 1));
  const startWeekday = (firstDay.getUTCDay() + 6) % 7;

  const counts = {};
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dayKey = `${month}-${String(day).padStart(2, '0')}`;
    let count = 0;
    for (const entry of entries) {
      if (entryCoversDay(entry, dayKey)) count += 1;
    }
    if (count > 0) counts[dayKey] = count;
  }

  const cells = [];
  for (let i = 0; i < startWeekday; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(`${month}-${String(day).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);

  return { cells, counts };
}

function formatSelectedDayLabel(dayKey) {
  if (!dayKey) return '';
  return formatISTDate(`${dayKey}T12:00:00+05:30`);
}

export default function AdminTeamLeaveCalendar() {
  const [month, setMonth] = useState(currentMonthInput);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDay, setSelectedDay] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadCalendar() {
      setLoading(true);
      setError('');
      setSelectedDay(null);
      try {
        const data = await leaveApi.getTeamCalendar({ month });
        if (cancelled) return;
        setEntries(Array.isArray(data.entries) ? data.entries : []);
      } catch (err) {
        if (cancelled) return;
        setEntries([]);
        setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadCalendar();
    return () => {
      cancelled = true;
    };
  }, [month]);

  const teamGrid = useMemo(() => buildTeamLeaveGrid(month, entries), [month, entries]);

  // Production rule: list is driven only by the selected calendar day.
  const visibleEntries = useMemo(() => {
    if (!selectedDay) return [];
    return entries.filter((entry) => entryCoversDay(entry, selectedDay));
  }, [entries, selectedDay]);

  const monthRequestCount = useMemo(
    () => entries.filter((item) => isVisibleOnTeamCalendar(item.status)).length,
    [entries],
  );

  const selectedDayCount = teamGrid.counts[selectedDay] ?? 0;

  function handleDaySelect(dayKey) {
    setSelectedDay((current) => (current === dayKey ? null : dayKey));
  }

  return (
    <div className="page page--team-calendar">
      {error ? <div className="alert alert--error">{error}</div> : null}

      <section className="team-cal-toolbar card" aria-labelledby="team-cal-period-title">
        <h2 id="team-cal-period-title" className="card__section-title team-cal-toolbar__title">
          Calendar period
        </h2>
        <div className="team-cal-toolbar__row">
          <MonthField value={month} onChange={setMonth} aria-label="Leave calendar month" />
          <p className="team-cal-toolbar__summary muted small">
            {loading
              ? 'Loading leave coverage…'
              : monthRequestCount === 0
                ? 'No approved leave this month'
                : `${monthRequestCount} approved leave request${monthRequestCount === 1 ? '' : 's'} this month`}
          </p>
        </div>
      </section>

      <section className="team-cal-grid-card card" aria-label="Monthly coverage">
        <h2 className="card__section-title">Monthly coverage</h2>
        <p className="team-cal-grid-card__hint muted small">
          Select a date to view approved leave for that day. Pending requests stay on Approvals
          until approved.
        </p>

        {loading ? (
          <div className="team-cal-grid-card__loading" aria-busy="true">
            <div className="skeleton skeleton--calendar" />
          </div>
        ) : (
          <>
            <div className="team-leave-grid" role="grid" aria-label="Team leave density">
              {WEEKDAY_LABELS.map((label) => (
                <span key={label} className="team-leave-grid__head">
                  {label}
                </span>
              ))}
              {teamGrid.cells.map((dayKey, index) => {
                if (!dayKey) {
                  return (
                    <span
                      key={`empty-${index}`}
                      className="team-leave-grid__cell team-leave-grid__cell--empty"
                    />
                  );
                }
                const count = teamGrid.counts[dayKey] ?? 0;
                const dayNum = Number(dayKey.slice(-2));
                const isSelected = selectedDay === dayKey;
                const isBusy = count > 0;
                return (
                  <button
                    key={dayKey}
                    type="button"
                    role="gridcell"
                    aria-pressed={isSelected}
                    aria-label={
                      isBusy
                        ? `${formatSelectedDayLabel(dayKey)}, ${count} leave request${count === 1 ? '' : 's'}`
                        : `${formatSelectedDayLabel(dayKey)}, no leave`
                    }
                    className={`team-leave-grid__cell team-leave-grid__cell--button${
                      isBusy ? ' team-leave-grid__cell--busy' : ''
                    }${isSelected ? ' team-leave-grid__cell--selected' : ''}`}
                    onClick={() => handleDaySelect(dayKey)}
                  >
                    <span className="team-leave-grid__day">{dayNum}</span>
                    {isBusy ? <span className="team-leave-grid__count">{count}</span> : null}
                  </button>
                );
              })}
            </div>
            <div className="team-leave-calendar__legend" aria-label="Calendar legend">
              <span className="team-leave-calendar__legend-item">
                <span className="team-leave-calendar__swatch" aria-hidden="true" />
                No leave
              </span>
              <span className="team-leave-calendar__legend-item">
                <span
                  className="team-leave-calendar__swatch team-leave-calendar__swatch--busy"
                  aria-hidden="true"
                />
                Leave covering this date
              </span>
            </div>
          </>
        )}
      </section>

      <section className="team-cal-list" aria-label="Leave requests for selected date">
        <div className="team-cal-list__heading">
          <h2 className="card__section-title team-cal-list__title">
            {selectedDay
              ? `Leave on ${formatSelectedDayLabel(selectedDay)}`
              : 'Leave requests'}
          </h2>
          {selectedDay ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSelectedDay(null)}
            >
              Clear selection
            </button>
          ) : null}
        </div>

        {loading ? (
          <div className="team-cal-list__feed">
            <div className="team-leave-card team-leave-card--skeleton">
              <div className="skeleton skeleton--row" />
              <div className="skeleton skeleton--row" />
            </div>
          </div>
        ) : !selectedDay ? (
          <div className="team-cal-empty card">
            <EmptyState
              icon={EMPTY_ICONS.calendar}
              title="Select a date"
              description="Choose a day on the calendar to view approved leave that covers that date."
            />
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="team-cal-empty card">
            <EmptyState
              icon={EMPTY_ICONS.leave}
              title="No leave on this date"
              description={`${formatSelectedDayLabel(selectedDay)} has no approved leave.`}
            />
          </div>
        ) : (
          <div className="team-cal-list__feed" key={selectedDay}>
            <p className="team-cal-list__meta muted small">
              {selectedDayCount} approved request{selectedDayCount === 1 ? '' : 's'} covering this date
            </p>
            {visibleEntries.map((item) => (
              <article key={item.id} className="team-leave-card">
                <header className="team-leave-card__header">
                  <div className="team-leave-card__identity">
                    <h3 className="team-leave-card__name">{item.userName || 'Employee'}</h3>
                    {item.userEmail ? (
                      <p className="team-leave-card__email">{item.userEmail}</p>
                    ) : null}
                  </div>
                  <LeaveStatusBadge status={item.status} />
                </header>
                <dl className="team-leave-card__meta">
                  <div className="team-leave-card__meta-item">
                    <dt>Leave type</dt>
                    <dd>{leaveTypeLabel(item)}</dd>
                  </div>
                  <div className="team-leave-card__meta-item">
                    <dt>Leave period</dt>
                    <dd>{dateRangeLabel(item)}</dd>
                  </div>
                  <div className="team-leave-card__meta-item">
                    <dt>Duration</dt>
                    <dd>{durationLabel(item)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
