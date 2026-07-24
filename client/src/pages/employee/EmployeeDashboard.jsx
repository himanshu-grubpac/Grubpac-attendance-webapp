import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AttendanceResultCard from '../../components/AttendanceResultCard.jsx';
import LocationPanel from '../../components/LocationPanel.jsx';
import MonthCalendar from '../../components/MonthCalendar.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useGeolocation } from '../../hooks/useGeolocation.js';
import { attendanceApi, getErrorMessage } from '../../services/api.js';
import {
  formatISTDateTime,
  getCurrentISTClock,
  getISTDateInputValue,
  getISTMonthInputValue,
  previousISTMonthInput,
} from '../../utils/datetime.js';

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

export default function EmployeeDashboard() {
  const { user } = useAuth();
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
  const { getPosition, loading: geoLoading, error: geoError, position, sampleInfo } =
    useGeolocation();

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

  useEffect(() => {
    refreshToday().catch((err) => setError(getErrorMessage(err)));
    const timer = setInterval(() => setClock(getCurrentISTClock()), 1000);
    return () => clearInterval(timer);
  }, [refreshToday]);

  useEffect(() => {
    loadCalendar(calendarMonth);
  }, [calendarMonth, loadCalendar]);

  async function handleAttendance(type) {
    setActionLoading(true);
    setError('');
    setResult(null);
    try {
      const coords = await getPosition({ fresh: true });
      const apiCall = type === 'check_in' ? attendanceApi.checkIn : attendanceApi.checkOut;
      const data = await apiCall(coords);
      setResult(data);
      await refreshToday();
      await loadCalendar(calendarMonth);
    } catch (err) {
      const response = err?.response?.data;
      if (response?.record) {
        setResult(response);
      }
      setError(getErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
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

        <div className="dash-hero__actions">
          <button
            type="button"
            className="btn btn-primary btn-lg dash-hero__cta"
            disabled={!today?.canCheckIn || actionLoading || geoLoading}
            onClick={() => handleAttendance('check_in')}
          >
            {actionLoading ? (
              <>
                <span className="spinner spinner--sm" aria-hidden="true" />
                Capturing…
              </>
            ) : (
              'Check in'
            )}
          </button>
          <button
            type="button"
            className="btn btn-lg dash-hero__cta"
            disabled={!today?.canCheckOut || actionLoading || geoLoading}
            onClick={() => handleAttendance('check_out')}
          >
            Check out
          </button>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        <LocationPanel
          compact
          position={position}
          error={geoError}
          loading={geoLoading}
          office={office}
          sampleInfo={sampleInfo}
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

      <section className="card dash-calendar-card">
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
      </section>

      <AttendanceResultCard result={result} />
    </div>
  );
}
