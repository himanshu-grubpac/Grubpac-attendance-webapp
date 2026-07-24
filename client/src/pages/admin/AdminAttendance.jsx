import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi, getErrorMessage, leaveApi } from '../../services/api.js';
import {
  IST_TIMEZONE,
  getISTDateInputValue,
} from '../../utils/datetime.js';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const AVATAR_COLORS = ['#e85d04', '#3b82f6', '#8b5cf6', '#059669', '#d946ef', '#0ea5e9'];

const DEFAULT_POLICY = {
  officeStartTime: '09:00',
  officeEndTime: '17:00',
  graceThresholdTime: '09:00',
  halfDayThresholdTime: '10:00',
  warningsPerQuarter: 3,
};

const STATUS_LEGEND = [
  { code: 'P', label: 'Present', tone: 'success' },
  { code: 'A', label: 'Absent', tone: 'danger' },
  { code: 'HD', label: 'Half Day', tone: 'warning' },
  { code: 'L', label: 'Late', tone: 'late' },
  { code: 'H', label: 'Holiday', tone: 'muted' },
  { code: 'LV', label: 'Leave', tone: 'info' },
  { code: 'OFC', label: 'Office', tone: 'office' },
  { code: 'WFH', label: 'WFH', tone: 'wfh' },
  { code: 'warning', label: 'Warning', tone: 'warning', icon: true },
];

const SUMMARY_CARDS = [
  { key: 'present', label: 'Total Present', tone: 'success', hintKey: 'presentHint' },
  { key: 'absent', label: 'Total Absent', tone: 'danger', hintKey: 'absentHint' },
  { key: 'late', label: 'Total Late', tone: 'late', hintKey: 'lateHint' },
  { key: 'halfDay', label: 'Total Half Days', tone: 'warning', hintKey: 'halfDayHint' },
];

function getInitials(name) {
  if (!name?.trim()) return '?';
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < (name ?? '').length; i += 1) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function parseDayKeyToDate(dayKey) {
  if (!dayKey || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;
  const date = new Date(`${dayKey}T12:00:00+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTimestamp(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getISTWeekdayFromDayKey(dayKey) {
  const date = parseDayKeyToDate(dayKey);
  if (!date) return 0;
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    weekday: 'short',
  }).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[weekday] ?? 0;
}

function isWeekendDayKey(dayKey) {
  const day = getISTWeekdayFromDayKey(dayKey);
  return day === 0 || day === 6;
}

function addDaysToDayKey(dayKey, delta) {
  const date = parseDayKeyToDate(dayKey);
  if (!date) return getISTDateInputValue();
  date.setUTCDate(date.getUTCDate() + delta);
  return getISTDateInputValue(date);
}

function getWeekStartDayKey(referenceDayKey = getISTDateInputValue()) {
  const weekday = getISTWeekdayFromDayKey(referenceDayKey);
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return addDaysToDayKey(referenceDayKey, mondayOffset);
}

function buildWeekDayKeys(weekStartKey) {
  return Array.from({ length: 7 }, (_, index) => addDaysToDayKey(weekStartKey, index));
}

function formatWeekRangeLabel(weekStartKey, weekEndKey) {
  const startDate = parseDayKeyToDate(weekStartKey);
  const endDate = parseDayKeyToDate(weekEndKey);
  if (!startDate || !endDate) return '—';
  const start = new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    month: 'short',
    day: 'numeric',
  }).format(startDate);
  const end = new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(endDate);
  return `${start} – ${end}`;
}

function formatCompactISTTime(value) {
  const date = parseTimestamp(value);
  if (!date) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function getCheckInMinutesIST(timestamp) {
  const date = parseTimestamp(timestamp);
  if (!date) return 0;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function normalizePolicyTime(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^\d{1,2}:\d{2}$/.test(trimmed) ? trimmed : null;
  }
  return null;
}

function parseTimeToMinutes(timeStr) {
  const normalized = normalizePolicyTime(timeStr);
  if (!normalized) return null;
  const [hour, minute] = normalized.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function resolvePolicy(settings) {
  return {
    officeStartTime:
      normalizePolicyTime(settings?.officeStartTime) ?? DEFAULT_POLICY.officeStartTime,
    officeEndTime: normalizePolicyTime(settings?.officeEndTime) ?? DEFAULT_POLICY.officeEndTime,
    graceThresholdTime:
      normalizePolicyTime(settings?.graceThresholdTime) ?? DEFAULT_POLICY.graceThresholdTime,
    halfDayThresholdTime:
      normalizePolicyTime(settings?.halfDayThresholdTime) ?? DEFAULT_POLICY.halfDayThresholdTime,
    warningsPerQuarter: settings?.warningsPerQuarter ?? DEFAULT_POLICY.warningsPerQuarter,
  };
}

function derivePolicyFromRecord(record, policy) {
  if (record?.attendanceTag) {
    const warningTag = record.quarterWarningIndex ? `W${record.quarterWarningIndex}` : null;
    return { statusTag: record.attendanceTag, warningTag };
  }
  if (!record?.timestamp || !policy) {
    return { statusTag: 'P', warningTag: null };
  }
  const graceMinutes = parseTimeToMinutes(policy.graceThresholdTime);
  const halfDayMinutes = parseTimeToMinutes(policy.halfDayThresholdTime);
  const checkInMinutes = getCheckInMinutesIST(record.timestamp);
  if (graceMinutes == null || halfDayMinutes == null) {
    return { statusTag: 'P', warningTag: null };
  }
  if (checkInMinutes <= graceMinutes) return { statusTag: 'P', warningTag: null };
  if (checkInMinutes >= halfDayMinutes) return { statusTag: 'HD', warningTag: null };
  return { statusTag: 'P', warningTag: null };
}

function formatPolicyTime(timeStr) {
  const normalized = normalizePolicyTime(timeStr);
  if (!normalized) return '—';
  const [hour, minute] = normalized.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return normalized;
  const date = new Date(Date.UTC(2020, 0, 1, hour, minute));
  if (Number.isNaN(date.getTime())) return normalized;
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function recordUserId(record) {
  const user = record.userId;
  if (!user) return null;
  if (typeof user === 'string') return user;
  return user.id ?? user._id?.toString?.() ?? String(user._id);
}

function toIstDayKey(value) {
  const date = parseTimestamp(value);
  if (!date) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
      return value.trim();
    }
    return null;
  }
  return getISTDateInputValue(date);
}

function leaveCoversDay(entry, dayKey) {
  if (entry.status !== 'approved') return false;
  const startKey = toIstDayKey(entry.startDate);
  const endKey = toIstDayKey(entry.endDate);
  if (!startKey || !endKey || !dayKey) return false;
  return dayKey >= startKey && dayKey <= endKey;
}

function employeeDesignation(employee) {
  return employee.designation || employee.departmentName || employee.department || null;
}

function uniqueMonthsForWeek(dayKeys) {
  return [...new Set(dayKeys.map((key) => key.slice(0, 7)))];
}

async function fetchAllDayRecords(date) {
  const records = [];
  let page = 1;
  let totalPages = 1;
  do {
    const data = await adminApi.listAttendance({ date, page, limit: 100 });
    records.push(...(data.records ?? []));
    totalPages = data.pagination?.totalPages ?? 1;
    page += 1;
  } while (page <= totalPages);
  return records;
}

async function fetchActiveEmployees() {
  const employees = [];
  let page = 1;
  let totalPages = 1;
  do {
    const data = await adminApi.listEmployees({ page, limit: 100, isActive: 'true' });
    employees.push(...(data.employees ?? []));
    totalPages = data.pagination?.totalPages ?? 1;
    page += 1;
  } while (page <= totalPages);
  return employees;
}

function indexRecordsByUserAndDay(records) {
  const map = new Map();
  for (const record of records) {
    const userId = recordUserId(record);
    const dayKey = toIstDayKey(record.timestamp);
    if (!userId || !dayKey) continue;
    if (!map.has(userId)) map.set(userId, new Map());
    const dayMap = map.get(userId);
    if (!dayMap.has(dayKey)) dayMap.set(dayKey, []);
    dayMap.get(dayKey).push(record);
  }
  return map;
}

function classifyDayCell({
  dayKey,
  userId,
  recordIndex,
  holidaySet,
  leaveEntries,
  todayKey,
  policy,
}) {
  if (isWeekendDayKey(dayKey)) {
    return { kind: 'weekend' };
  }
  if (holidaySet.has(dayKey)) {
    return { kind: 'holiday' };
  }

  const onLeave = leaveEntries.some((entry) => {
    const entryUserId = entry.userId?.id ?? entry.userId;
    return String(entryUserId) === String(userId) && leaveCoversDay(entry, dayKey);
  });
  if (onLeave) {
    return { kind: 'leave' };
  }

  const dayRecords = recordIndex.get(userId)?.get(dayKey) ?? [];
  const allowedCheckIn = dayRecords.find((r) => r.type === 'check_in' && r.status === 'allowed');
  const allowedCheckOut = dayRecords.find((r) => r.type === 'check_out' && r.status === 'allowed');
  const rejectedCheckIn = dayRecords.find((r) => r.type === 'check_in' && r.status === 'rejected');

  if (allowedCheckIn) {
    const { statusTag, warningTag } = derivePolicyFromRecord(allowedCheckIn, policy);
    return {
      kind: 'present',
      statusTag,
      warningTag,
      modeTag: 'OFC',
      checkInTime: formatCompactISTTime(allowedCheckIn.timestamp),
      checkOutTime: formatCompactISTTime(allowedCheckOut?.timestamp),
      hasRejectedAttempt: Boolean(rejectedCheckIn),
    };
  }

  if (rejectedCheckIn) {
    return {
      kind: 'rejected',
      checkInTime: formatCompactISTTime(rejectedCheckIn.timestamp),
      rejectionReasons: Array.isArray(rejectedCheckIn.rejectionReasons)
        ? rejectedCheckIn.rejectionReasons.filter(Boolean)
        : [],
    };
  }

  if (dayKey > todayKey) {
    return { kind: 'future' };
  }
  if (dayKey < todayKey) {
    return { kind: 'absent' };
  }
  return { kind: 'pending' };
}

function AttendanceStatusTag({ code, tone }) {
  return (
    <span className={`attendance-tag attendance-tag--${tone}`} title={code}>
      {code}
    </span>
  );
}

function dayCellModifier(cell, dayKey, todayKey) {
  if (!cell) return '';
  if (cell.kind === 'weekend') return 'attendance-grid__day--weekend';
  if (cell.kind === 'holiday') return 'attendance-grid__day--holiday';
  if (cell.kind === 'leave') return 'attendance-grid__day--leave';
  if (cell.kind === 'absent') return 'attendance-grid__day--absent';
  if (cell.kind === 'rejected') return 'attendance-grid__day--rejected';
  if (cell.kind === 'future' || cell.kind === 'pending') {
    return dayKey === todayKey ? 'attendance-grid__day--today' : 'attendance-grid__day--empty';
  }
  if (cell.kind === 'present') {
    return dayKey === todayKey ? 'attendance-grid__day--today attendance-grid__day--present' : 'attendance-grid__day--present';
  }
  return '';
}

function dayCardModifiers(cell, dayKey, todayKey, isDaySelected) {
  const mods = ['attendance-day-card'];
  if (!cell || cell.kind === 'future' || cell.kind === 'pending') {
    mods.push('attendance-day-card--empty');
  } else if (cell.kind === 'weekend' || cell.kind === 'holiday') {
    mods.push('attendance-day-card--rest');
  } else if (cell.kind === 'leave') {
    mods.push('attendance-day-card--leave');
  } else if (cell.kind === 'absent') {
    mods.push('attendance-day-card--absent');
  } else if (cell.kind === 'rejected') {
    mods.push('attendance-day-card--rejected');
  } else if (cell.kind === 'present') {
    mods.push(
      cell.statusTag === 'HD' ? 'attendance-day-card--half-day' : 'attendance-day-card--present',
    );
  }
  if (dayKey === todayKey) mods.push('attendance-day-card--today');
  if (isDaySelected) mods.push('attendance-day-card--selected');
  return mods.join(' ');
}

function CheckInOutTimes({ checkInTime, checkOutTime }) {
  if (!checkInTime && !checkOutTime) {
    return <span className="attendance-grid__empty">—</span>;
  }

  return (
    <div className="attendance-grid__times-stack">
      {checkInTime ? (
        <span className="attendance-grid__time attendance-grid__time--in">{checkInTime}</span>
      ) : null}
      {checkOutTime ? (
        <span className="attendance-grid__time attendance-grid__time--out">{checkOutTime}</span>
      ) : null}
    </div>
  );
}

function DayCellBadgeRow({ left, right, centered = false }) {
  if (centered) {
    return (
      <div className="attendance-day-card__badges attendance-day-card__badges--center">
        {left ?? right}
      </div>
    );
  }

  return (
    <div className="attendance-day-card__badges">
      <div className="attendance-day-card__badge-left">{left}</div>
      <div className="attendance-day-card__badge-right">{right}</div>
    </div>
  );
}

function presentStatusTone(statusTag) {
  if (statusTag === 'P') return 'success';
  if (statusTag === 'L') return 'late';
  return 'warning';
}

function modeTagTone(modeTag) {
  return modeTag === 'WFH' ? 'wfh' : 'office';
}

function DayCell({ cell, cardClassName }) {
  let inner = null;

  if (!cell || cell.kind === 'future' || cell.kind === 'pending') {
    inner = (
      <div className="attendance-grid__cell attendance-grid__cell--empty">
        <span className="attendance-grid__empty">—</span>
      </div>
    );
  } else if (cell.kind === 'weekend' || cell.kind === 'holiday') {
    inner = (
      <div className="attendance-grid__cell attendance-grid__cell--rest">
        <DayCellBadgeRow
          centered
          right={<AttendanceStatusTag code="H" tone="muted" />}
        />
        <span className="attendance-grid__empty">—</span>
      </div>
    );
  } else if (cell.kind === 'leave') {
    inner = (
      <div className="attendance-grid__cell attendance-grid__cell--leave">
        <DayCellBadgeRow
          right={<AttendanceStatusTag code="LV" tone="info" />}
        />
        <span className="attendance-grid__empty">—</span>
      </div>
    );
  } else if (cell.kind === 'absent') {
    inner = (
      <div className="attendance-grid__cell attendance-grid__cell--absent">
        <DayCellBadgeRow
          centered
          right={<AttendanceStatusTag code="A" tone="danger" />}
        />
        <span className="attendance-grid__empty">—</span>
      </div>
    );
  } else if (cell.kind === 'rejected') {
    inner = (
      <div className="attendance-grid__cell attendance-grid__cell--rejected">
        <DayCellBadgeRow
          right={<AttendanceStatusTag code="RJ" tone="danger" />}
        />
        <CheckInOutTimes checkInTime={cell.checkInTime} />
      </div>
    );
  } else {
    const statusRight = cell.warningTag ? (
      <>
        <AttendanceStatusTag code={cell.warningTag} tone="warning" />
        <AttendanceStatusTag code={cell.statusTag} tone={presentStatusTone(cell.statusTag)} />
      </>
    ) : (
      <AttendanceStatusTag
        code={cell.statusTag}
        tone={presentStatusTone(cell.statusTag)}
      />
    );

    inner = (
      <div className="attendance-grid__cell attendance-grid__cell--present">
        <DayCellBadgeRow
          left={
            cell.modeTag ? (
              <AttendanceStatusTag code={cell.modeTag} tone={modeTagTone(cell.modeTag)} />
            ) : null
          }
          right={statusRight}
        />
        <CheckInOutTimes checkInTime={cell.checkInTime} checkOutTime={cell.checkOutTime} />
        {cell.hasRejectedAttempt ? (
          <span className="attendance-grid__note" title="Additional rejected check-in attempt">
            +RJ
          </span>
        ) : null}
      </div>
    );
  }

  return <div className={cardClassName}>{inner}</div>;
}

function GridSkeleton() {
  return (
    <div className="attendance-grid-skeleton" aria-busy="true" aria-label="Loading attendance grid">
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
      <div className="skeleton skeleton--row" />
    </div>
  );
}

function WarningBalanceCell({ summary, rejectedCount }) {
  if (!summary) {
    return (
      <div className="attendance-warnings-cell">
        {rejectedCount > 0 ? (
          <span className="attendance-grid__rejected-count">{rejectedCount} RJ</span>
        ) : (
          <span className="attendance-grid__empty">—</span>
        )}
      </div>
    );
  }

  const { used, allowance } = summary;
  const pct = allowance > 0 ? Math.min(100, Math.round((used / allowance) * 100)) : 0;

  return (
    <div className="attendance-warnings-cell">
      <span className="attendance-warnings-cell__count">
        {used}/{allowance}
      </span>
      <span
        className="attendance-warnings-cell__bar"
        role="progressbar"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={allowance}
        aria-label={`${used} of ${allowance} quarterly warnings used`}
      >
        <span className="attendance-warnings-cell__fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

export default function AdminAttendance() {
  const [weekStart, setWeekStart] = useState(() => getWeekStartDayKey());
  const [selectedDayKey, setSelectedDayKey] = useState(() => getISTDateInputValue());
  const [employees, setEmployees] = useState([]);
  const [recordIndex, setRecordIndex] = useState(new Map());
  const [leaveEntries, setLeaveEntries] = useState([]);
  const [holidaySet, setHolidaySet] = useState(new Set());
  const [policy, setPolicy] = useState(DEFAULT_POLICY);
  const [quarterWarnings, setQuarterWarnings] = useState({ byUser: {}, quarter: null, allowance: 3 });
  const [selectedRows, setSelectedRows] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const weekDays = useMemo(() => buildWeekDayKeys(weekStart), [weekStart]);
  const weekEnd = weekDays[6];
  const todayKey = getISTDateInputValue();
  const isCurrentWeek = weekStart === getWeekStartDayKey(todayKey);

  const loadWeek = useCallback(async () => {
    setLoading(true);
    setError('');
    setSelectedRows(new Set());
    try {
      const dayKeys = buildWeekDayKeys(weekStart);
      const years = [...new Set(dayKeys.map((key) => key.slice(0, 4)))];

      const [employeeList, officeResponse, warningResponse, ...dayResults] = await Promise.all([
        fetchActiveEmployees(),
        adminApi.getOfficeSettings().catch(() => ({ settings: null })),
        adminApi.getQuarterWarnings().catch(() => ({ byUser: {}, quarter: null, allowance: 3 })),
        ...dayKeys.map((date) => fetchAllDayRecords(date)),
      ]);

      const resolvedPolicy = resolvePolicy(officeResponse.settings);
      setPolicy(resolvedPolicy);
      setQuarterWarnings(warningResponse);

      const allRecords = dayResults.flat();
      const months = uniqueMonthsForWeek(dayKeys);
      const holidayResponses = await Promise.all(
        years.map((year) =>
          leaveApi.listHolidays({ year }).catch(() => ({ holidays: [] })),
        ),
      );
      const leaveResponses = await Promise.all(
        months.map((month) =>
          leaveApi.getTeamCalendar({ month }).catch(() => ({ entries: [] })),
        ),
      );

      const holidays = new Set();
      for (const response of holidayResponses) {
        for (const holiday of response.holidays ?? []) {
          const key = toIstDayKey(holiday.date);
          if (key) holidays.add(key);
        }
      }

      const leaves = [];
      const seenLeaveIds = new Set();
      for (const response of leaveResponses) {
        for (const entry of response.entries ?? []) {
          const id = entry.id ?? entry._id;
          if (id && seenLeaveIds.has(id)) continue;
          if (id) seenLeaveIds.add(id);
          leaves.push(entry);
        }
      }

      setEmployees(employeeList);
      setRecordIndex(indexRecordsByUserAndDay(allRecords));
      setHolidaySet(holidays);
      setLeaveEntries(leaves);
    } catch (err) {
      setError(getErrorMessage(err));
      setEmployees([]);
      setRecordIndex(new Map());
      setLeaveEntries([]);
      setHolidaySet(new Set());
      setQuarterWarnings({ byUser: {}, quarter: null, allowance: 3 });
    } finally {
      setLoading(false);
    }
  }, [weekStart]);

  useEffect(() => {
    loadWeek();
  }, [loadWeek]);

  useEffect(() => {
    setSelectedDayKey((current) => {
      if (weekDays.includes(current)) return current;
      if (weekDays.includes(todayKey)) return todayKey;
      return weekDays[0];
    });
  }, [weekDays, todayKey]);

  const gridRows = useMemo(() => {
    return employees.map((employee) => {
      const id = employee.id;
      const cells = weekDays.map((dayKey) =>
        classifyDayCell({
          dayKey,
          userId: id,
          recordIndex,
          holidaySet,
          leaveEntries,
          todayKey,
          policy,
        }),
      );
      const rejectedCount = cells.filter((cell) => cell.kind === 'rejected').length;
      const warningCount = cells.filter((cell) => cell.warningTag).length;
      return { employee, cells, rejectedCount, warningCount };
    });
  }, [employees, weekDays, recordIndex, holidaySet, leaveEntries, todayKey, policy]);

  const summary = useMemo(() => {
    let present = 0;
    let absent = 0;
    let late = 0;
    let halfDay = 0;
    let workingSlots = 0;

    for (const row of gridRows) {
      for (const cell of row.cells) {
        if (cell.kind === 'weekend' || cell.kind === 'holiday' || cell.kind === 'future') continue;
        if (cell.kind === 'leave') continue;
        if (cell.kind === 'pending') continue;
        workingSlots += 1;
        if (cell.kind === 'present') {
          present += 1;
          if (cell.warningTag) late += 1;
          if (cell.statusTag === 'HD') halfDay += 1;
        } else if (cell.kind === 'absent') {
          absent += 1;
        }
      }
    }

    const activePct = workingSlots > 0 ? Math.round((present / workingSlots) * 100) : 0;
    const absentPct = workingSlots > 0 ? Math.round((absent / workingSlots) * 100) : 0;

    return {
      present,
      absent,
      late,
      halfDay,
      presentHint: workingSlots > 0 ? `${activePct}% active days logged` : 'No working days in range',
      absentHint: workingSlots > 0 ? `${absentPct}% unplanned absences` : 'No working days in range',
      lateHint: late > 0 ? 'Check-ins with warnings this week' : 'No late marks this week',
      halfDayHint: halfDay > 0 ? 'Per office half-day threshold' : 'No half-day marks this week',
    };
  }, [gridRows]);

  const quarterLabel = quarterWarnings.quarter?.label ?? 'Current quarter';

  function goToPreviousWeek() {
    setWeekStart((current) => addDaysToDayKey(current, -7));
  }

  function goToNextWeek() {
    setWeekStart((current) => addDaysToDayKey(current, 7));
  }

  function goToCurrentWeek() {
    setWeekStart(getWeekStartDayKey(todayKey));
    setSelectedDayKey(todayKey);
  }

  function toggleRowSelected(employeeId) {
    setSelectedRows((current) => {
      const next = new Set(current);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  }

  return (
    <div className="page page--attendance">
      {error ? <div className="alert alert--error">{error}</div> : null}

      <section className="attendance-week-toolbar card" aria-labelledby="attendance-week-title">
        <div className="attendance-week-toolbar__header">
          <div className="attendance-week-toolbar__label-wrap">
            <span className="attendance-week-toolbar__icon" aria-hidden="true">
              📅
            </span>
            <h2 id="attendance-week-title" className="attendance-week-toolbar__label">
              Week: {formatWeekRangeLabel(weekStart, weekEnd)}
            </h2>
          </div>
          <div className="attendance-week-toolbar__nav">
            <button
              type="button"
              className="attendance-week-toolbar__arrow"
              onClick={goToPreviousWeek}
              aria-label="Previous week"
            >
              ‹
            </button>
            <button
              type="button"
              className="attendance-week-toolbar__arrow"
              onClick={goToNextWeek}
              aria-label="Next week"
            >
              ›
            </button>
            <button
              type="button"
              className="btn btn--primary attendance-week-toolbar__current"
              onClick={goToCurrentWeek}
              disabled={isCurrentWeek}
            >
              Current Week
            </button>
          </div>
        </div>
        <div className="attendance-week-toolbar__days" role="group" aria-label="Week days">
          {weekDays.map((dayKey) => {
            const weekday = getISTWeekdayFromDayKey(dayKey);
            const label = WEEKDAY_LABELS[weekday === 0 ? 6 : weekday - 1];
            const dayNum = dayKey.slice(8, 10);
            const isToday = dayKey === todayKey;
            const isSelected = dayKey === selectedDayKey;
            const isWeekend = isWeekendDayKey(dayKey);
            return (
              <button
                key={dayKey}
                type="button"
                className={[
                  'attendance-week-toolbar__day',
                  isSelected ? 'attendance-week-toolbar__day--active' : '',
                  isToday && !isSelected ? 'attendance-week-toolbar__day--today' : '',
                  isWeekend ? 'attendance-week-toolbar__day--weekend' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-pressed={isSelected}
                aria-current={isSelected ? 'date' : undefined}
                aria-label={`${label} ${dayNum}${isToday ? ', today' : ''}`}
                onClick={() => setSelectedDayKey(dayKey)}
              >
                <span className="attendance-week-toolbar__day-label">{label}</span>
                <span className="attendance-week-toolbar__day-num">{dayNum}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section
        className="attendance-grid-panel card card--table"
        aria-label="Weekly attendance grid"
      >
        {loading ? (
          <GridSkeleton />
        ) : gridRows.length === 0 ? (
          <div className="attendance-grid-empty">
            <EmptyState
              icon={EMPTY_ICONS.calendar}
              title="No employees to display"
              description="Register active employees to view attendance."
            />
          </div>
        ) : (
          <div className="attendance-grid-scroll table-wrap">
            <table className="attendance-grid">
              <thead>
                <tr>
                  <th scope="col" className="attendance-grid__col-row-num">
                    #
                  </th>
                  <th scope="col" className="attendance-grid__col-employee">
                    Employee
                  </th>
                  {weekDays.map((dayKey) => {
                    const dayNum = dayKey.slice(8, 10);
                    const weekday = getISTWeekdayFromDayKey(dayKey);
                    const label = WEEKDAY_LABELS[weekday === 0 ? 6 : weekday - 1];
                    const isSelected = dayKey === selectedDayKey;
                    const isToday = dayKey === todayKey;
                    const isWeekend = isWeekendDayKey(dayKey);
                    return (
                      <th
                        key={dayKey}
                        scope="col"
                        className={[
                          'attendance-grid__col-day',
                          isSelected ? 'attendance-grid__col-day--selected' : '',
                          isToday && !isSelected ? 'attendance-grid__col-day--today' : '',
                          isWeekend ? 'attendance-grid__col-day--weekend' : '',
                          holidaySet.has(dayKey) ? 'attendance-grid__col-day--holiday' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <span className="attendance-grid__day-head">
                          <span className="attendance-grid__day-name">{label}</span>
                          <span className="attendance-grid__day-num">{dayNum}</span>
                        </span>
                      </th>
                    );
                  })}
                  <th scope="col" className="attendance-grid__col-actions">
                    Actions
                  </th>
                  <th scope="col" className="attendance-grid__col-warnings">
                    <span className="attendance-grid__warnings-head">
                      Warnings
                      <span className="attendance-grid__warnings-quarter">({quarterLabel})</span>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {gridRows.map(({ employee, cells, rejectedCount }, rowIndex) => {
                  const id = employee.id;
                  const isRowSelected = selectedRows.has(id);
                  const designation = employeeDesignation(employee);
                  const email = employee.email ?? null;
                  return (
                    <tr key={id} className={isRowSelected ? 'attendance-grid__row--selected' : undefined}>
                      <td className="attendance-grid__row-num">{rowIndex + 1}</td>
                      <th scope="row" className="attendance-grid__employee">
                        <div className="attendance-grid__employee-inner">
                          <span
                            className="attendance-grid__avatar"
                            style={{ backgroundColor: avatarColor(employee.name) }}
                            aria-hidden="true"
                          >
                            {getInitials(employee.name)}
                          </span>
                          <div className="attendance-grid__employee-text">
                            <span className="attendance-grid__employee-name">{employee.name}</span>
                            {designation ? (
                              <span className="attendance-grid__employee-designation">{designation}</span>
                            ) : null}
                            {email ? (
                              <span className="attendance-grid__employee-email">{email}</span>
                            ) : null}
                            {!designation && !email ? (
                              <span className="attendance-grid__employee-meta">—</span>
                            ) : null}
                          </div>
                        </div>
                      </th>
                      {cells.map((cell, index) => {
                        const dayKey = weekDays[index];
                        const isDaySelected = dayKey === selectedDayKey;
                        return (
                          <td
                            key={dayKey}
                            className={[
                              'attendance-grid__day',
                              isDaySelected ? 'attendance-grid__day--selected' : '',
                              dayCellModifier(cell, dayKey, todayKey),
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            <DayCell
                              cell={cell}
                              cardClassName={dayCardModifiers(
                                cell,
                                dayKey,
                                todayKey,
                                isDaySelected,
                              )}
                            />
                          </td>
                        );
                      })}
                      <td className="attendance-grid__actions">
                        <div className="attendance-grid__actions-inner">
                          <Link
                            to={`/admin/users/${id}`}
                            className="attendance-grid__edit"
                            aria-label={`View ${employee.name} profile`}
                            title="View employee profile"
                          >
                            <svg
                              className="attendance-grid__edit-icon"
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                            </svg>
                          </Link>
                          <input
                            type="checkbox"
                            className="attendance-grid__select"
                            checked={isRowSelected}
                            onChange={() => toggleRowSelected(id)}
                            aria-label={`Select ${employee.name}`}
                          />
                        </div>
                      </td>
                      <td className="attendance-grid__warnings">
                        <WarningBalanceCell
                          summary={quarterWarnings.byUser?.[String(id)]}
                          rejectedCount={rejectedCount}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="attendance-footer">
        <section className="attendance-legend card" aria-labelledby="attendance-legend-title">
          <h2 id="attendance-legend-title" className="card__section-title">
            Status Legend
          </h2>
          <div className="attendance-legend__grid">
            {STATUS_LEGEND.map((item) => (
              <div key={item.code} className="attendance-legend__pill">
                {item.icon ? (
                  <span className="attendance-legend__warn-icon" aria-hidden="true">
                    ⚠
                  </span>
                ) : (
                  <AttendanceStatusTag code={item.code} tone={item.tone} />
                )}
                <span className="attendance-legend__pill-label">{item.label}</span>
              </div>
            ))}
          </div>
          <p className="attendance-legend__note muted small">
            * Weekend and holiday statuses are automatically pre-marked unless overtime is logged.
          </p>
        </section>

        <div className="attendance-summary__grid" aria-label="Weekly attendance summary">
          {SUMMARY_CARDS.map((card) => (
            <article key={card.key} className={`attendance-summary card attendance-summary--${card.tone}`}>
              <div className="attendance-summary__head">
                <span className="attendance-summary__label">{card.label}</span>
                <span className={`attendance-summary__dot attendance-summary__dot--${card.tone}`} />
              </div>
              <p className="attendance-summary__value">{summary[card.key]}</p>
              <p className="attendance-summary__hint muted small">{summary[card.hintKey]}</p>
            </article>
          ))}
        </div>

        <section className="attendance-policy card" aria-labelledby="attendance-policy-title">
          <h2 id="attendance-policy-title" className="card__section-title">
            Attendance Policy (Quarterly)
          </h2>
          <ul className="attendance-policy__list">
            <li>
              {policy.warningsPerQuarter} warnings allowed per quarter (3 months).
            </li>
            <li>
              Check-in after {formatPolicyTime(policy.graceThresholdTime)} &amp; before{' '}
              {formatPolicyTime(policy.halfDayThresholdTime)} → Warning issued (if warnings
              remaining).
            </li>
            <li>
              Check-in after {formatPolicyTime(policy.halfDayThresholdTime)} → Marked as Half Day.
            </li>
            <li>
              If 0 warnings remaining, check-in after {formatPolicyTime(policy.graceThresholdTime)}{' '}
              → Half Day.
            </li>
          </ul>
          <p className="attendance-policy__note muted small">
            Office hours Mon–Fri {formatPolicyTime(policy.officeStartTime)} –{' '}
            {formatPolicyTime(policy.officeEndTime)} IST. Thresholds are configured on the
            Geolocation page.
          </p>
        </section>
      </div>
    </div>
  );
}
