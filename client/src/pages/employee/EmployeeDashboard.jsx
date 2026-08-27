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
import {
  buildPendingLeaveCheckInFollowUp,
  buildPendingLeaveCheckInWarning,
  buildTodayAttendanceModeLabel,
} from '../../utils/leaveStatusCopy.js';
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
  'Outside office radius — move closer to the office to check in or check out.';

export default function EmployeeDashboard() {
  const { user } = useAuth();
  const { showToast, showSuccess, showError } = useToast();
  const [today, setToday] = useState(null);
  const [office, setOffice] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [clock, setClock] = useState(getCurrentISTClock());
  const [calendarMonth, setCalendarMonth] = useState(getISTMonthInputValue());
  const [calendarDays, setCalendarDays] = useState({});
  const [calendarHolidays, setCalendarHolidays] = useState({});
  const [calendarBirthdays, setCalendarBirthdays] = useState({});
  const [calendarToday, setCalendarToday] = useState(getISTDateInputValue());
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarError, setCalendarError] = useState('');
  const [quarterWarnings, setQuarterWarnings] = useState(null);
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
      setCalendarHolidays(data.holidays ?? {});
      setCalendarBirthdays(data.birthdays ?? {});
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

  const effectiveAttendanceMode = today?.checkIn
    ? today.checkIn.attendanceMode ?? 'office'
    : today?.wfhApprovedToday
      ? 'wfh'
      : 'office';

  async function handleAttendance(type, lateNote) {
    setActionLoading(true);
    setError('');
    setResult(null);
    try {
      const coords = await getPosition({ fresh: true });
      const todayCheckInMode = today?.checkIn?.attendanceMode ?? 'office';
      const requiresOfficeGeo =
        type === 'check_in' ? !today?.wfhApprovedToday : todayCheckInMode !== 'wfh';

      if (requiresOfficeGeo && office) {
        const preview = evaluateOfficeGeoPreview(coords, office);
        if (preview && !preview.isWithinOffice) {
          const message = preview.issues.join(' ') || OFFICE_GEO_REJECTION_FALLBACK;
          setError(message);
          showError(message);
          return;
        }
      }

      const data = type === 'check_in'
        ? await attendanceApi.checkIn(coords, lateNote)
        : await attendanceApi.checkOut(coords);
      setResult(data);
      if (data.quarterWarnings) {
        setQuarterWarnings(data.quarterWarnings);
      }
      await refreshToday();
      await loadQuarterWarnings();
      await loadCalendar(calendarMonth);
      setLateNoteOpen(false);
      setLateNoteText('');
      if (data.undoToken) {
        showToast(
          type === 'check_in'
            ? 'Checked in. If done by mistake, click Undo below to revert it.'
            : 'Checked out. If done by mistake, click Undo below to revert it.',
          {
            variant: 'success',
            durationMs: 15000,
            action: {
              label: 'Undo',
              onClick: () => performUndo(data.undoToken),
            },
          },
        );
      } else {
        showSuccess(type === 'check_in' ? 'Checked in.' : 'Checked out.');
      }
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

  async function performUndo(token) {
    if (!token) return;
    setActionLoading(true);
    setError('');
    setResult(null);
    try {
      await attendanceApi.undo(token);
      await refreshToday();
      await loadCalendar(calendarMonth);
      showSuccess('Action undone.');
    } catch (err) {
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

  const isCheckedIn = Boolean(today?.checkIn) && !today?.checkOut;
  const primaryAction = isCheckedIn ? 'check_out' : 'check_in';
  const todayModeLabel = buildTodayAttendanceModeLabel({
    wfhApprovedToday: today?.wfhApprovedToday,
    approvedLeaveToday: today?.approvedLeaveToday,
    checkIn: today?.checkIn,
  });
  const pendingLeaveWarning = buildPendingLeaveCheckInWarning(today?.pendingLeaveToday);
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

        <p className="attendance-mode-current muted small" role="status">
          {todayModeLabel}
        </p>

        {pendingLeaveWarning && !today?.checkIn ? (
          <div
            className="alert alert--warning alert--block dash-pending-leave-notice"
            role="status"
            aria-live="polite"
          >
            <p className="leave-status-notice__title">
              <strong>{pendingLeaveWarning.title}</strong>
            </p>
            <p className="leave-status-notice__body">{pendingLeaveWarning.body}</p>
          </div>
        ) : null}

        <div className="dash-hero__actions">
          <button
            type="button"
            className={`btn btn-lg dash-hero__cta ${
              primaryAction === 'check_out' ? 'btn-secondary' : 'btn-primary'
            }`}
            disabled={
              (primaryAction === 'check_in'
                ? !today?.canCheckIn
                : !today?.canCheckOut) ||
              actionLoading ||
              geoLoading
            }
            onClick={
              primaryAction === 'check_in'
                ? requestCheckIn
                : () => handleAttendance('check_out')
            }
            aria-label={primaryAction === 'check_in' ? 'Check in' : 'Check out'}
          >
            {actionLoading ? (
              <>
                <span className="spinner spinner--sm" aria-hidden="true" />
                Capturing…
              </>
            ) : primaryAction === 'check_in' ? (
              'Check in'
            ) : (
              'Check out'
            )}
          </button>
        </div>

        {primaryAction === 'check_in' && !today?.canCheckIn && !actionLoading && !geoLoading ? (
          <p className="dash-action-hint muted small" role="status">
            {today?.checkOut
              ? 'You have completed your attendance for today. Check in will be available tomorrow.'
              : 'Check-in is not available right now (approved leave covers today).'}
          </p>
        ) : null}

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
          attendanceMode={effectiveAttendanceMode}
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
            pendingLeaveFollowUp={
              result?.status === 'allowed' && result?.record?.type === 'check_in'
                ? buildPendingLeaveCheckInFollowUp(result.pendingLeaveToday)
                : null
            }
          />
        </div>

        <aside className="card dash-calendar-card" aria-label="Attendance calendar">
          {calendarError ? <div className="alert alert--error">{calendarError}</div> : null}
          <MonthCalendar
            month={calendarMonth}
            days={calendarDays}
            holidays={calendarHolidays}
            birthdays={calendarBirthdays}
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
