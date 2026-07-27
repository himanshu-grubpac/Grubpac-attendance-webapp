import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import AttendanceResultCard from '../../components/AttendanceResultCard.jsx';
import LocationPanel from '../../components/LocationPanel.jsx';
import MonthCalendar from '../../components/MonthCalendar.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useGeolocation } from '../../hooks/useGeolocation.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { attendanceApi, getErrorMessage } from '../../services/api.js';
import {
  formatISTDateTime,
  getCurrentISTClock,
  getISTDateInputValue,
  getISTMonthInputValue,
  previousISTMonthInput,
} from '../../utils/datetime.js';
import { formatQuarterWarningBalance } from '../../utils/attendanceOutcome.js';
import { evaluateOfficeGeoPreview } from '../../utils/geoPreview.js';

function nextISTMonthInput(monthInput) {
  const [year, month] = monthInput.split('-').map(Number);
  const date = new Date(Date.UTC(year, month, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function greetingForHour() {
  const hour = Number(
    new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      hour12: false,
    }).format(new Date()),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function todayStatusLabel(today) {
  if (today?.checkOut) return 'Checked out';
  if (today?.checkIn) return 'Checked in';
  return 'Not checked in';
}

function parseGraceMinutes(graceTime) {
  if (!graceTime || typeof graceTime !== 'string') return null;
  const [hour, minute] = graceTime.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function currentCheckInMinutesIST() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function isLateCheckIn(graceTime) {
  const graceMinutes = parseGraceMinutes(graceTime);
  if (graceMinutes == null) return false;
  return currentCheckInMinutesIST() > graceMinutes;
}

const OFFICE_GEO_REJECTION_FALLBACK =
  'Outside office radius — switch to Work from Home or move closer.';

export default function EmployeeDashboard() {
  const { user } = useAuth();
  const { showError } = useToast();
  const [today, setToday] = useState(null);
  const [office, setOffice] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [clock, setClock] = useState(getCurrentISTClock());
  const [calendarMonth, setCalendarMonth] = useState(getISTMonthInputValue());
  const [calendarDays, setCalendarDays] = useState({});
  const [calendarToday, setCalendarToday] = useState(getISTDateInputValue());
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarError, setCalendarError] = useState('');
  const [quarterWarnings, setQuarterWarnings] = useState(null);
  const [attendanceMode, setAttendanceMode] = useState('office');
  const [lateNoteOpen, setLateNoteOpen] = useState(false);
  const [lateNoteText, setLateNoteText] = useState('');
  const { getPosition, loading: geoLoading, error: geoError, position, sampleInfo } =
    useGeolocation();

  useEscapeKey(lateNoteOpen && !actionLoading, () => setLateNoteOpen(false));

  useEffect(() => {
    if (!lateNoteOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [lateNoteOpen]);

  const refreshToday = useCallback(async () => {
    const data = await attendanceApi.getToday();
    setToday(data.status);
    setOffice(data.status.office ?? null);
    setClock(data.status.currentIST || getCurrentISTClock());
  }, []);

  const loadCalendar = useCallback(async (month) => {
    setCalendarLoading(true);
    setCalendarError('');
    try {
      const data = await attendanceApi.getMonthSummary({ month });
      setCalendarDays(data.days ?? {});
      setCalendarToday(data.today ?? getISTDateInputValue());
    } catch (err) {
      setCalendarError(getErrorMessage(err));
    } finally {
      setCalendarLoading(false);
    }
  }, []);

  const loadQuarterWarnings = useCallback(async () => {
    try {
      const data = await attendanceApi.getQuarterWarnings();
      setQuarterWarnings(data);
    } catch {
      setQuarterWarnings(null);
    }
  }, []);

  useEffect(() => {
    refreshToday().catch((err) => setError(getErrorMessage(err)));
    loadQuarterWarnings();
    const timer = setInterval(() => setClock(getCurrentISTClock()), 1000);
    return () => clearInterval(timer);
  }, [refreshToday, loadQuarterWarnings]);

  useEffect(() => {
    loadCalendar(calendarMonth);
  }, [calendarMonth, loadCalendar]);

  useEffect(() => {
    getPosition({ fresh: false }).catch(() => {});
  }, [getPosition]);

  async function handleAttendance(type, lateNote) {
    setActionLoading(true);
    setError('');
    setResult(null);
    try {
      const coords = await getPosition({ fresh: true });
      const mode = type === 'check_out'
        ? (today?.checkIn?.attendanceMode ?? 'office')
        : attendanceMode;

      if (type === 'check_in' && mode === 'office' && office) {
        const preview = evaluateOfficeGeoPreview(coords, office);
        if (preview && !preview.isWithinOffice) {
          const message = preview.issues.join(' ') || OFFICE_GEO_REJECTION_FALLBACK;
          setError(message);
          showError(message);
          return;
        }
      }

      const data = type === 'check_in'
        ? await attendanceApi.checkIn(coords, mode, lateNote)
        : await attendanceApi.checkOut(coords, mode);
      setResult(data);
      if (data.quarterWarnings) {
        setQuarterWarnings(data.quarterWarnings);
      }
      await refreshToday();
      await loadQuarterWarnings();
      await loadCalendar(calendarMonth);
      setLateNoteOpen(false);
      setLateNoteText('');
    } catch (err) {
      const response = err?.response?.data;
      if (response?.record) {
        setResult(response);
      }
      const message = getErrorMessage(err);
      setError(message);
      showError(message);
    } finally {
      setActionLoading(false);
    }
  }

  function requestCheckIn() {
    const graceTime = today?.office?.graceThresholdTime ?? office?.graceThresholdTime;
    if (isLateCheckIn(graceTime)) {
      setLateNoteText('');
      setLateNoteOpen(true);
      return;
    }
    handleAttendance('check_in');
  }

  function submitLateNoteCheckIn(event) {
    event.preventDefault();
    handleAttendance('check_in', lateNoteText.trim() || undefined);
  }

  const displayName = user?.name?.split(' ')[0] || 'there';
  const dateLabel = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date());

  return (
    <div className="page page--employee-home">
      <div className="employee-home__desktop-layout">
        <div className="employee-home__main-column">
          <section className="dash-hero card">
        <div className="dash-hero__top">
          <div>
            <p className="dash-hero__greeting">
              {greetingForHour()}, {displayName}
            </p>
            <p className="dash-hero__meta muted small">
              {dateLabel} · {clock.split(',')[1]?.trim() ?? clock}
            </p>
          </div>
          <span
            className={`dash-status-badge${
              today?.checkIn ? ' dash-status-badge--in' : ''
            }${today?.checkOut ? ' dash-status-badge--out' : ''}`}
          >
            {todayStatusLabel(today)}
          </span>
        </div>

        <div className="dash-hero__times">
          <div>
            <span className="label">Check-in</span>
            <strong>
              {today?.checkIn ? formatISTDateTime(today.checkIn.timestamp) : '—'}
            </strong>
          </div>
          <div>
            <span className="label">Check-out</span>
            <strong>
              {today?.checkOut ? formatISTDateTime(today.checkOut.timestamp) : '—'}
            </strong>
          </div>
        </div>

        {!today?.checkIn ? (
          <div className="attendance-mode-picker" role="group" aria-label="Work location for today">
            <span className="attendance-mode-picker__label">Today&apos;s work location</span>
            <div className="attendance-mode-picker__options">
              <button
                type="button"
                className={`attendance-mode-picker__option${attendanceMode === 'office' ? ' attendance-mode-picker__option--active' : ''}`}
                aria-pressed={attendanceMode === 'office'}
                onClick={() => setAttendanceMode('office')}
                disabled={actionLoading || geoLoading}
              >
                Office
              </button>
              <button
                type="button"
                className={`attendance-mode-picker__option${attendanceMode === 'wfh' ? ' attendance-mode-picker__option--active' : ''}`}
                aria-pressed={attendanceMode === 'wfh'}
                onClick={() => setAttendanceMode('wfh')}
                disabled={actionLoading || geoLoading}
              >
                Work from home
              </button>
            </div>
            <p className="attendance-mode-picker__hint muted small">
              {attendanceMode === 'office'
                ? 'Office check-in requires you to be within the configured office radius.'
                : 'Work from Home records your current location without applying the office-radius check.'}
            </p>
          </div>
        ) : (
          <p className="attendance-mode-current muted small">
            Work location: <strong>{today.checkIn.attendanceMode === 'wfh' ? 'Work from Home' : 'Office'}</strong>
          </p>
        )}

        <div className="dash-hero__actions">
          <button
            type="button"
            className="btn btn-primary btn-lg dash-hero__cta"
            disabled={!today?.canCheckIn || actionLoading || geoLoading}
            onClick={requestCheckIn}
          >
            {actionLoading ? (
              <>
                <span className="spinner spinner--sm" aria-hidden="true" />
                Capturing…
              </>
            ) : (
              `Check in${attendanceMode === 'wfh' ? ' (WFH)' : ''}`
            )}
          </button>
          <button
            type="button"
            className="btn btn-lg dash-hero__cta"
            disabled={!today?.canCheckOut || actionLoading || geoLoading}
            onClick={() => handleAttendance('check_out')}
          >
            {`Check out${today?.checkIn?.attendanceMode === 'wfh' ? ' (WFH)' : ''}`}
          </button>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        {quarterWarnings ? (
          <p className="dash-quarter-warnings muted small">
            {formatQuarterWarningBalance(quarterWarnings)}
          </p>
        ) : null}

        <LocationPanel
          compact
          position={position}
          error={geoError}
          loading={geoLoading}
          office={office}
          sampleInfo={sampleInfo}
          attendanceMode={today?.checkIn ? today.checkIn.attendanceMode ?? 'office' : attendanceMode}
          onRefresh={() => getPosition({ fresh: true }).catch(() => {})}
        />
          </section>

          <section className="card dash-shortcuts">
            <div className="dash-shortcuts__list">
              <Link to="/employee/leave/apply" className="dash-shortcuts__item">
                Apply leave
              </Link>
              <Link to="/employee/history" className="dash-shortcuts__item">
                Attendance history
              </Link>
              <Link to="/employee/help" className="dash-shortcuts__item">
                Help
              </Link>
            </div>
          </section>

          <AttendanceResultCard
            result={result}
            quarterAllowance={quarterWarnings?.allowance ?? 3}
          />
        </div>

        <aside className="card dash-calendar-card" aria-label="Attendance calendar">
          {calendarError ? <div className="alert alert--error">{calendarError}</div> : null}
          <MonthCalendar
            month={calendarMonth}
            days={calendarDays}
            today={calendarToday}
            loading={calendarLoading}
            compact
            onPrev={() => setCalendarMonth((value) => previousISTMonthInput(value))}
            onNext={() => setCalendarMonth((value) => nextISTMonthInput(value))}
            onToday={() => setCalendarMonth(getISTMonthInputValue())}
          />
        </aside>
      </div>

      {lateNoteOpen
        ? createPortal(
            <div
              className="modal__backdrop modal__backdrop--elevated"
              role="presentation"
              onClick={() => !actionLoading && setLateNoteOpen(false)}
            >
              <div
                className="modal modal--compact"
                role="dialog"
                aria-modal="true"
                aria-labelledby="late-note-title"
                onClick={(event) => event.stopPropagation()}
              >
                <header className="modal__header">
                  <h2 id="late-note-title" className="modal__title">Late check-in note</h2>
                  <p className="modal__lead muted">
                    You are checking in after the grace threshold. Add a brief reason before submitting.
                  </p>
                </header>
                <form className="modal__form" onSubmit={submitLateNoteCheckIn}>
                  <div className="modal__body">
                    <label className="modal__field">
                      <span className="label">Reason (optional)</span>
                      <textarea
                        className="input"
                        rows={4}
                        maxLength={500}
                        value={lateNoteText}
                        onChange={(event) => setLateNoteText(event.target.value)}
                        placeholder="e.g. Traffic delay, medical appointment"
                      />
                    </label>
                  </div>
                  <footer className="modal__footer">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setLateNoteOpen(false)}
                      disabled={actionLoading}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={actionLoading}>
                      {actionLoading ? 'Submitting…' : 'Submit check-in'}
                    </button>
                  </footer>
                </form>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
