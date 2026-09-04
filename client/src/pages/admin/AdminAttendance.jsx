import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { adminApi, getErrorMessage, leaveApi } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useConfirmDialog } from '../../hooks/useConfirmDialog.jsx';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import TimeField, { isValidHHmmTime, normalizeHHmmTime } from '../../components/TimeField.jsx';
import SelectField from '../../components/SelectField.jsx';
import { useTableColumns } from '../../hooks/useTableColumns.js';
import ColumnEditorPanel from '../../components/ColumnEditorPanel.jsx';
import {
  IST_TIMEZONE,
  getISTDateInputValue,
  formatISTDateTime,
} from '../../utils/datetime.js';
import EmptyState, { EMPTY_ICONS } from '../../components/EmptyState.jsx';

const HISTORY_TABLE_KEY = 'attendanceHistory';

const HISTORY_COLUMNS = [
  { key: 'employee', label: 'Employee', always: true },
  { key: 'department', label: 'Department' },
  { key: 'date', label: 'Date (IST)' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'mode', label: 'Mode' },
  { key: 'time', label: 'Time (IST)' },
];

const HISTORY_DEFAULT_COLUMNS = ['employee', 'department', 'date', 'type', 'status', 'mode', 'time'];

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
  { code: 'H', label: 'Holiday', tone: 'muted' },
  { code: 'LV', label: 'Leave', tone: 'info' },
  { code: 'OFC', label: 'Office', tone: 'office' },
  { code: 'WFH', label: 'WFH', tone: 'wfh' },
  { code: 'WFH*', label: 'WFH pending approval (red)', tone: 'danger' },
  { code: 'W', label: 'Warning (late)', tone: 'warning' },
  { code: 'RJ', label: 'Rejected check-in', tone: 'danger' },
];

/** Working-status filter options (leave codes from live leave types + work modes + presence). */
const WORKING_STATUS_OPTIONS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'office', label: 'Office' },
  { value: 'wfh', label: 'WFH' },
  { value: 'sl', label: 'SL (Sick Leave)' },
  { value: 'cl', label: 'CL (Casual Leave)' },
  { value: 'el', label: 'EL (Earned Leave)' },
  { value: 'co', label: 'CO (Compensatory Off)' },
  { value: 'rh', label: 'RH (Restricted Holiday)' },
  { value: 'present', label: 'Present' },
  { value: 'absent', label: 'Absent' },
];

const LEAVE_CODE_STATUS_KEYS = new Set(['sl', 'cl', 'el', 'co', 'rh']);

/** Maps a classified day cell to a working-status filter key, or null if it has no status. */
function cellStatusKey(cell) {
  if (!cell) return null;
  if (cell.kind === 'leave') {
    const code = String(cell.leaveTypeCode ?? '').trim().toUpperCase();
    if (code === 'WFH') return 'wfh';
    if (LEAVE_CODE_STATUS_KEYS.has(code.toLowerCase())) return code.toLowerCase();
    return 'absent';
  }
  if (cell.kind === 'present') {
    return cell.modeTag === 'WFH' ? 'wfh' : 'office';
  }
  if (cell.kind === 'absent') return 'absent';
  if (cell.kind === 'rejected') return 'absent';
  return null;
}

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

function formatDayPickerLabel(dayKey) {
  const date = parseDayKeyToDate(dayKey);
  if (!date) return dayKey;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function isEditableAttendanceCell(cell) {
  if (!cell) return false;
  if (cell.kind === 'absent') return true;
  return Boolean(cell.checkInRecordId && cell.checkInRecord);
}

function getEditableWeekDays(cells, weekDayKeys) {
  return weekDayKeys
    .map((dayKey, index) => ({ dayKey, cell: cells[index] }))
    .filter(({ cell }) => isEditableAttendanceCell(cell));
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

function timestampToHHmmIST(value) {
  const date = parseTimestamp(value);
  if (!date) return '09:00';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '09';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  return normalizeHHmmTime(`${hour}:${minute}`) ?? '09:00';
}

function recordId(record) {
  if (!record) return null;
  return record.id ?? record._id?.toString?.() ?? String(record._id);
}

function statusCodeFromCheckInRecord(record) {
  if (record?.quarterWarningIndex && record?.warningIssued) {
    return `W${record.quarterWarningIndex}`;
  }
  return record?.attendanceTag ?? 'P';
}

function buildStatusOptions(warningsPerQuarter = 3) {
  const allowance = Math.max(1, Math.min(10, Number(warningsPerQuarter) || 3));
  const options = [
    { value: 'P', label: 'Present (P)' },
    { value: 'HD', label: 'Half Day (HD)' },
    { value: 'LV', label: 'Leave Violation (LV)' },
  ];
  for (let index = 1; index <= allowance; index += 1) {
    options.push({ value: `W${index}`, label: `Warning ${index} (W${index})` });
  }
  return options;
}

const MODE_OPTIONS = [
  { value: 'office', label: 'Office (OFC)' },
  { value: 'wfh', label: 'Work From Home (WFH)' },
];

const EDIT_FIELD_LABELS = {
  checkInTime: 'Check-in time',
  checkOutTime: 'Check-out time',
  statusCode: 'Status',
  attendanceMode: 'Work mode',
  lateNote: 'Late note',
  status: 'Record status',
};

function formatEditModeValue(value) {
  if (value === 'wfh') return 'WFH';
  if (value === 'office') return 'Office';
  return value ?? '(empty)';
}

function formatEditChangeValue(field, value) {
  if (value == null || value === '') return '(empty)';
  if (field === 'attendanceMode') return formatEditModeValue(value);
  return String(value);
}

function formatEditChangeLine(change) {
  const label = EDIT_FIELD_LABELS[change.field] ?? change.field;
  const from = formatEditChangeValue(change.field, change.from);
  const to = formatEditChangeValue(change.field, change.to);
  return `${label}: ${from} → ${to}`;
}

function formatEditTimestamp(value) {
  const date = parseTimestamp(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function pickEditMetadata(record) {
  if (!record?.lastEditedAt) {
    return {
      lastEditedAt: null,
      lastEditedBy: null,
      editHistory: [],
    };
  }
  return {
    lastEditedAt: record.lastEditedAt,
    lastEditedBy: record.lastEditedBy ?? null,
    editHistory: Array.isArray(record.editHistory) ? record.editHistory : [],
  };
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

function resolveLeaveTypeDisplayCode(entry, leaveTypeCodeById = null) {
  const leaveTypeRef = entry?.leaveTypeId;
  const rawCode =
    entry?.leaveTypeCode
    || entry?.leaveType?.code
    || (leaveTypeRef && typeof leaveTypeRef === 'object' ? leaveTypeRef.code : null);
  if (rawCode) return String(rawCode).trim().toUpperCase();
  const typeId =
    leaveTypeRef && typeof leaveTypeRef === 'object'
      ? leaveTypeRef.id ?? leaveTypeRef._id
      : leaveTypeRef;
  if (typeId && leaveTypeCodeById) {
    const mapped = leaveTypeCodeById.get(String(typeId));
    if (mapped) return mapped;
  }
  const name = String(entry?.leaveTypeName || entry?.leaveType?.name || '').trim();
  if (/work\s*from\s*home|^wfh$/i.test(name)) return 'WFH';
  return 'LV';
}

function isPendingWfhApproval(entry, now = Date.now()) {
  if (resolveLeaveTypeDisplayCode(entry) !== 'WFH' || entry?.status !== 'approved') return false;
  const expiresAt = parseTimestamp(entry.decisionUndoExpiresAt)?.getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function buildLeaveTypeCodeById(types, leaveEntries) {
  const map = new Map(
    (types ?? []).map((item) => [
      String(item.id),
      String(item.code ?? '').trim().toUpperCase(),
    ]),
  );
  for (const entry of leaveEntries ?? []) {
    const leaveTypeRef = entry?.leaveTypeId;
    const typeId =
      leaveTypeRef && typeof leaveTypeRef === 'object'
        ? leaveTypeRef.id ?? leaveTypeRef._id
        : leaveTypeRef;
    const code =
      entry?.leaveTypeCode
      || entry?.leaveType?.code
      || (leaveTypeRef && typeof leaveTypeRef === 'object' ? leaveTypeRef.code : null);
    if (typeId && code) {
      map.set(String(typeId), String(code).trim().toUpperCase());
    }
  }
  return map;
}

function employeeDesignation(employee) {
  return employee.designation || employee.departmentName || employee.department || null;
}

function employeeDepartmentId(employee) {
  return employee.departmentId ?? employee.department?.id ?? null;
}

function employeeDepartmentName(employee) {
  return employee.departmentName ?? employee.department?.name ?? employee.department ?? null;
}

function uniqueMonthsForWeek(dayKeys) {
  return [...new Set(dayKeys.map((key) => key.slice(0, 7)))];
}

async function fetchWeekRecords(weekStartKey) {
  const records = [];
  let page = 1;
  let totalPages = 1;
  do {
    const data = await adminApi.listAttendance({ weekStart: weekStartKey, page, limit: 100 });
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
  leaveTypeCodeById,
  todayKey,
  policy,
  now = Date.now(),
}) {
  if (isWeekendDayKey(dayKey)) {
    return { kind: 'weekend' };
  }
  if (holidaySet.has(dayKey)) {
    return { kind: 'holiday' };
  }

  const dayRecords = recordIndex.get(userId)?.get(dayKey) ?? [];
  const allowedCheckIn = dayRecords.find((r) => r.type === 'check_in' && r.status === 'allowed');
  const allowedCheckOut = dayRecords.find((r) => r.type === 'check_out' && r.status === 'allowed');
  const rejectedCheckIn = dayRecords.find((r) => r.type === 'check_in' && r.status === 'rejected');

  const leaveEntry = leaveEntries.find((entry) => {
    const userRef = entry.userId;
    const entryUserId =
      userRef && typeof userRef === 'object'
        ? userRef.id ?? userRef._id
        : userRef;
    return String(entryUserId) === String(userId) && leaveCoversDay(entry, dayKey);
  });
  if (leaveEntry) {
    const leaveTypeCode = resolveLeaveTypeDisplayCode(leaveEntry, leaveTypeCodeById);
    const pendingWfh = isPendingWfhApproval(leaveEntry, now);
    const leaveCell = {
      kind: 'leave',
      leaveTypeCode,
      pendingWfh,
    };
    if (allowedCheckIn) {
      const editMeta = pickEditMetadata(allowedCheckIn);
      return {
        ...leaveCell,
        kind: 'present',
        pendingWfh: pendingWfh || allowedCheckIn.leaveStatus === 'pending',
        modeTag: allowedCheckIn.attendanceMode === 'wfh' ? 'WFH' : 'OFC',
        checkInTime: formatCompactISTTime(allowedCheckIn.timestamp),
        checkOutTime: formatCompactISTTime(allowedCheckOut?.timestamp),
        checkInLocationHref: mapsLocationHref(allowedCheckIn),
        checkOutLocationHref: mapsLocationHref(allowedCheckOut),
        lateNote: allowedCheckIn.lateNote ?? null,
        checkInRecordId: recordId(allowedCheckIn),
        checkOutRecordId: recordId(allowedCheckOut),
        checkInRecord: allowedCheckIn,
        checkOutRecord: allowedCheckOut ?? null,
        ...editMeta,
      };
    }
    return leaveCell;
  }

  if (allowedCheckIn) {
    const { statusTag, warningTag } = derivePolicyFromRecord(allowedCheckIn, policy);
    const editMeta = pickEditMetadata(allowedCheckIn);
    const pendingWfh = allowedCheckIn.leaveStatus === 'pending';
    return {
      kind: 'present',
      statusTag,
      warningTag,
      modeTag: allowedCheckIn.attendanceMode === 'wfh' ? 'WFH' : 'OFC',
      pendingWfh,
      checkInTime: formatCompactISTTime(allowedCheckIn.timestamp),
      checkOutTime: formatCompactISTTime(allowedCheckOut?.timestamp),
      lateNote: allowedCheckIn.lateNote ?? null,
      checkInLocationHref: mapsLocationHref(allowedCheckIn),
      checkOutLocationHref: mapsLocationHref(allowedCheckOut),
      hasRejectedAttempt: Boolean(rejectedCheckIn),
      checkInRecordId: recordId(allowedCheckIn),
      checkOutRecordId: recordId(allowedCheckOut),
      checkInRecord: allowedCheckIn,
      checkOutRecord: allowedCheckOut ?? null,
      ...editMeta,
    };
  }

  if (rejectedCheckIn) {
    const editMeta = pickEditMetadata(rejectedCheckIn);
    return {
      kind: 'rejected',
      checkInTime: formatCompactISTTime(rejectedCheckIn.timestamp),
      rejectionReasons: Array.isArray(rejectedCheckIn.rejectionReasons)
        ? rejectedCheckIn.rejectionReasons.filter(Boolean)
        : [],
      checkInRecordId: recordId(rejectedCheckIn),
      checkInRecord: rejectedCheckIn,
      ...editMeta,
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

function formatLateNoteTitle(lateNote) {
  const text = typeof lateNote === 'string' ? lateNote.trim() : '';
  return text ? `Late note: ${text}` : undefined;
}

function buildCheckInHoverTitle({ lateNote, checkInLocationHref }) {
  const parts = [];
  const lateTitle = formatLateNoteTitle(lateNote);
  if (lateTitle) parts.push(lateTitle);
  if (checkInLocationHref) parts.push('Open check-in location');
  return parts.length ? parts.join(' · ') : undefined;
}

function AttendanceStatusTag({ code, tone, title }) {
  return (
    <span className={`attendance-tag attendance-tag--${tone}`} title={title ?? code}>
      {code}
    </span>
  );
}

function AttendanceUpdatedChip({ lastEditedAt, lastEditedBy, editHistory = [] }) {
  if (!lastEditedAt) return null;

  const history = editHistory.length > 0
    ? editHistory
    : [{
        editedAt: lastEditedAt,
        editedBy: lastEditedBy,
        changes: [],
      }];
  const latest = history[history.length - 1];
  const latestChanges = latest?.changes ?? [];

  return (
    <span className="attendance-edit-chip">
      <span className="attendance-edit-chip__label">Updated</span>
      <span className="attendance-edit-chip__tooltip" role="tooltip">
        <span className="attendance-edit-chip__tooltip-section">
          <strong>Latest edit</strong>
          <span>Updated at: {formatEditTimestamp(latest?.editedAt ?? lastEditedAt)}</span>
          <span>Updated by: {latest?.editedBy?.name ?? lastEditedBy?.name ?? 'Unknown'}</span>
          {latestChanges.length > 0 ? (
            <span className="attendance-edit-chip__changes">
              {latestChanges.map((change) => (
                <span key={`${change.field}-${change.from}-${change.to}`}>
                  {formatEditChangeLine(change)}
                </span>
              ))}
            </span>
          ) : (
            <span>No field changes recorded.</span>
          )}
        </span>
        {history.length > 1 ? (
          <span className="attendance-edit-chip__tooltip-section attendance-edit-chip__tooltip-history">
            <strong>Full history</strong>
            {[...history].reverse().map((entry, index) => (
              <span key={`${entry.editedAt}-${index}`} className="attendance-edit-chip__history-entry">
                <span>
                  {formatEditTimestamp(entry.editedAt)} · {entry.editedBy?.name ?? 'Unknown'}
                </span>
                {(entry.changes ?? []).length > 0 ? (
                  <span className="attendance-edit-chip__changes">
                    {entry.changes.map((change) => (
                      <span key={`${entry.editedAt}-${change.field}-${change.from}-${change.to}`}>
                        {formatEditChangeLine(change)}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span>No field changes</span>
                )}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function dayCellModifier(cell, dayKey, todayKey) {
  if (!cell) return '';
  if (cell.kind === 'weekend') return 'attendance-grid__day--weekend';
  if (cell.kind === 'holiday') return 'attendance-grid__day--holiday';
  if (cell.kind === 'leave') {
    return cell.pendingWfh
      ? 'attendance-grid__day--pending-wfh'
      : 'attendance-grid__day--leave';
  }
  if (cell.kind === 'absent') return 'attendance-grid__day--absent';
  if (cell.kind === 'rejected') return 'attendance-grid__day--rejected';
  if (cell.kind === 'future' || cell.kind === 'pending') {
    return dayKey === todayKey ? 'attendance-grid__day--today' : 'attendance-grid__day--empty';
  }
  if (cell.kind === 'present') {
    if (cell.pendingWfh) {
      return dayKey === todayKey
        ? 'attendance-grid__day--today attendance-grid__day--present attendance-grid__day--pending-wfh'
        : 'attendance-grid__day--present attendance-grid__day--pending-wfh';
    }
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
    mods.push(cell.pendingWfh ? 'attendance-day-card--pending-wfh' : 'attendance-day-card--leave');
  } else if (cell.kind === 'absent') {
    mods.push('attendance-day-card--absent');
  } else if (cell.kind === 'rejected') {
    mods.push('attendance-day-card--rejected');
  } else if (cell.kind === 'present') {
    if (cell.pendingWfh) {
      mods.push('attendance-day-card--pending-wfh');
    } else {
      mods.push(
        cell.statusTag === 'HD' || cell.statusTag === 'LV'
          ? 'attendance-day-card--half-day'
          : 'attendance-day-card--present',
      );
    }
    if (cell.modeTag && cell.warningTag) mods.push('attendance-day-card--stacked');
  }
  if (dayKey === todayKey) mods.push('attendance-day-card--today');
  if (isDaySelected) mods.push('attendance-day-card--selected');
  return mods.join(' ');
}

function CheckInOutTimes({
  checkInTime,
  checkOutTime,
  checkInLocationHref,
  checkOutLocationHref,
  lateNote,
}) {
  if (!checkInTime && !checkOutTime) {
    return <span className="attendance-grid__empty">—</span>;
  }

  const checkInTitle = buildCheckInHoverTitle({ lateNote, checkInLocationHref });

  return (
    <div className="attendance-grid__times-stack">
      {checkInTime ? (
        checkInLocationHref ? (
          <a className="attendance-grid__time attendance-grid__time--in attendance-grid__location-link" href={checkInLocationHref} target="_blank" rel="noreferrer" title={checkInTitle}>{checkInTime}</a>
        ) : <span className="attendance-grid__time attendance-grid__time--in" title={checkInTitle}>{checkInTime}</span>
      ) : null}
      {checkOutTime ? (
        checkOutLocationHref ? (
          <a className="attendance-grid__time attendance-grid__time--out attendance-grid__location-link" href={checkOutLocationHref} target="_blank" rel="noreferrer" title="Open check-out location">{checkOutTime}</a>
        ) : <span className="attendance-grid__time attendance-grid__time--out">{checkOutTime}</span>
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
  if (statusTag === 'LV') return 'info';
  if (statusTag === 'L') return 'late';
  return 'warning';
}

function modeTagTone(modeTag) {
  return modeTag === 'WFH' ? 'wfh' : 'office';
}

function leaveTypeTagTone(leaveTypeCode) {
  if (String(leaveTypeCode ?? '').toUpperCase() === 'WFH') return 'wfh';
  return 'info';
}

function mapsLocationHref(record) {
  if (!Number.isFinite(record?.latitude) || !Number.isFinite(record?.longitude)) return null;
  return `https://www.google.com/maps?q=${record.latitude},${record.longitude}`;
}

function DayCell({ cell, cardClassName }) {
  const cellTitle = formatLateNoteTitle(cell?.lateNote);
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
    const leaveCode = cell.leaveTypeCode || resolveLeaveTypeDisplayCode(cell);
    const pendingWfh = Boolean(cell.pendingWfh && leaveCode === 'WFH');
    inner = (
      <div className="attendance-grid__cell attendance-grid__cell--leave">
        <DayCellBadgeRow
          left={
            cell.modeTag ? (
              <AttendanceStatusTag
                code={cell.modeTag}
                tone={modeTagTone(cell.modeTag)}
                title={cellTitle ?? cell.modeTag}
              />
            ) : null
          }
          right={
            <AttendanceStatusTag
              code={pendingWfh ? `${leaveCode}*` : leaveCode}
              tone={pendingWfh ? 'danger' : leaveTypeTagTone(leaveCode)}
              title={pendingWfh ? 'WFH approval pending — shown in red until approved' : leaveCode}
            />
          }
        />
        <CheckInOutTimes
          checkInTime={cell.checkInTime}
          checkOutTime={cell.checkOutTime}
          checkInLocationHref={cell.checkInLocationHref}
          checkOutLocationHref={cell.checkOutLocationHref}
          lateNote={cell.lateNote}
        />
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
        <AttendanceUpdatedChip
          lastEditedAt={cell.lastEditedAt}
          lastEditedBy={cell.lastEditedBy}
          editHistory={cell.editHistory}
        />
      </div>
    );
  } else {
    const statusRight = cell.warningTag ? (
      <>
        <AttendanceStatusTag
          code={cell.warningTag}
          tone="warning"
          title={cellTitle ?? cell.warningTag}
        />
        <AttendanceStatusTag
          code={cell.statusTag}
          tone={presentStatusTone(cell.statusTag)}
          title={cellTitle ?? cell.statusTag}
        />
      </>
    ) : (
      <AttendanceStatusTag
        code={cell.statusTag}
        tone={cell.pendingWfh ? 'danger' : presentStatusTone(cell.statusTag)}
        title={
          cell.pendingWfh
            ? `${cellTitle ?? cell.statusTag} — WFH approval pending, shown in red until approved`
            : (cellTitle ?? cell.statusTag)
        }
      />
    );

    inner = (
      <div className="attendance-grid__cell attendance-grid__cell--present">
        <DayCellBadgeRow
          left={
            cell.modeTag ? (
              <AttendanceStatusTag
                code={cell.pendingWfh ? `${cell.modeTag}*` : cell.modeTag}
                tone={cell.pendingWfh ? 'danger' : modeTagTone(cell.modeTag)}
                title={
                  cell.pendingWfh
                    ? 'WFH approval pending — shown in red until approved'
                    : (cellTitle ?? cell.modeTag)
                }
              />
            ) : null
          }
          right={statusRight}
        />
        <CheckInOutTimes
          checkInTime={cell.checkInTime}
          checkOutTime={cell.checkOutTime}
          checkInLocationHref={cell.checkInLocationHref}
          checkOutLocationHref={cell.checkOutLocationHref}
          lateNote={cell.lateNote}
        />
        {cell.hasRejectedAttempt ? (
          <span className="attendance-grid__note" title="Additional rejected check-in attempt">
            +RJ
          </span>
        ) : null}
        <AttendanceUpdatedChip
          lastEditedAt={cell.lastEditedAt}
          lastEditedBy={cell.lastEditedBy}
          editHistory={cell.editHistory}
        />
      </div>
    );
  }

  return <div className={cardClassName} title={cellTitle}>{inner}</div>;
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

function AttendanceDayPickerModal({ target, onClose, onSelectDay }) {
  const titleId = useId();
  if (!target) return null;

  return createPortal(
    <div className="modal__backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal--compact attendance-day-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id={titleId} className="modal__title">
            Select day to edit
          </h2>
          <p className="modal__lead muted">
            {target.employee.name} · {target.editableDays.length} editable day
            {target.editableDays.length === 1 ? '' : 's'} this week
          </p>
        </header>
        <div className="modal__body attendance-day-picker-modal__list">
          {target.editableDays.map(({ dayKey, cell }) => (
            <button
              key={dayKey}
              type="button"
              className="attendance-day-picker-modal__option"
              onClick={() => onSelectDay(dayKey, cell)}
            >
              <span className="attendance-day-picker-modal__day">{formatDayPickerLabel(dayKey)}</span>
              {cell.checkInTime ? (
                <span className="attendance-day-picker-modal__time muted">
                  In {cell.checkInTime}
                  {cell.checkOutTime ? ` · Out ${cell.checkOutTime}` : ''}
                </span>
              ) : cell.kind === 'absent' ? (
                <span className="attendance-day-picker-modal__time muted">Absent — create attendance</span>
              ) : null}
            </button>
          ))}
        </div>
        <footer className="modal__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function AttendanceEditModal({
  target,
  form,
  error,
  saving,
  statusOptions,
  onClose,
  onChange,
  onSubmit,
}) {
  const titleId = useId();
  if (!target) return null;

  const dayLabel = parseDayKeyToDate(target.dayKey);
  const formattedDay = dayLabel
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: IST_TIMEZONE,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(dayLabel)
    : target.dayKey;
  const priorEdit = pickEditMetadata(target.checkInRecord);

  return createPortal(
    <div className="modal__backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal modal--compact attendance-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id={titleId} className="modal__title">
            Edit attendance
          </h2>
          <p className="modal__lead muted">
            {target.employee.name} · {formattedDay}
          </p>
        </header>
        <form
          className="modal__form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <div className="modal__body">
            {error ? <div className="alert alert--error modal__alert">{error}</div> : null}

            {priorEdit.lastEditedAt ? (
              <div className="attendance-edit-modal__prior muted">
                Last edited {formatEditTimestamp(priorEdit.lastEditedAt)} by{' '}
                {priorEdit.lastEditedBy?.name ?? 'Unknown'}
              </div>
            ) : null}

            <label className="modal__field">
              <span className="modal__label">Check-in time (IST)</span>
              <TimeField
                value={form.checkInTime}
                onChange={(value) => onChange({ checkInTime: value })}
                disabled={saving}
                aria-label="Check-in time"
              />
            </label>

            {target.hasCheckOutField ? (
              <label className="modal__field">
                <span className="modal__label">
                  Check-out time (IST){target.isCreate ? ' (optional)' : ''}
                </span>
                <TimeField
                  value={form.checkOutTime}
                  onChange={(value) => onChange({ checkOutTime: value })}
                  disabled={saving}
                  aria-label="Check-out time"
                />
              </label>
            ) : null}

            <label className="modal__field">
              <span className="modal__label">Attendance status</span>
              <SelectField
                value={form.statusCode}
                onChange={(value) => onChange({ statusCode: value })}
                options={statusOptions}
                disabled={saving}
                aria-label="Attendance status"
              />
            </label>

            <label className="modal__field">
              <span className="modal__label">Work mode</span>
              <SelectField
                value={form.attendanceMode}
                onChange={(value) => onChange({ attendanceMode: value })}
                options={MODE_OPTIONS}
                disabled={saving}
                aria-label="Work mode"
              />
            </label>

            <label className="modal__field">
              <span className="modal__label">Late note (optional)</span>
              <textarea
                className="input"
                rows={3}
                maxLength={500}
                value={form.lateNote}
                onChange={(event) => onChange({ lateNote: event.target.value })}
                disabled={saving}
                placeholder="Reason for late arrival, if applicable"
              />
            </label>
          </div>
          <footer className="modal__footer">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
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
  const remaining = summary.remaining ?? Math.max(0, allowance - used);
  const pct = allowance > 0 ? Math.min(100, Math.round((used / allowance) * 100)) : 0;
  const remainingLabel =
    remaining > 0 ? `${remaining} left` : remaining === 0 && allowance > 0 ? 'None left' : null;

  return (
    <div className="attendance-warnings-cell">
      <span className="attendance-warnings-cell__count">
        {used}/{allowance}
        {remainingLabel ? ` · ${remainingLabel}` : ''}
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
  const { showSuccess, showError } = useToast();
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();
  const [weekStart, setWeekStart] = useState(() => getWeekStartDayKey());
  const [selectedDayKey, setSelectedDayKey] = useState(() => getISTDateInputValue());
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [recordIndex, setRecordIndex] = useState(new Map());
  const [leaveEntries, setLeaveEntries] = useState([]);
  const [leaveTypeCodeById, setLeaveTypeCodeById] = useState(() => new Map());
  const [decisionNow, setDecisionNow] = useState(() => Date.now());
  const [holidaySet, setHolidaySet] = useState(new Set());
  const [policy, setPolicy] = useState(DEFAULT_POLICY);
  const [quarterWarnings, setQuarterWarnings] = useState({ byUser: {}, quarter: null, allowance: 3 });
  const [weekConfirmations, setWeekConfirmations] = useState({});
  const [confirmingUserId, setConfirmingUserId] = useState(null);
  const [unconfirmingUserId, setUnconfirmingUserId] = useState(null);
  const [editPickerTarget, setEditPickerTarget] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState({
    checkInTime: '09:00',
    checkOutTime: '',
    statusCode: 'P',
    attendanceMode: 'office',
    lateNote: '',
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [gridVisibleCount, setGridVisibleCount] = useState(20);
  const GRID_PAGE_SIZE = 20;
  const [deptFilter, setDeptFilter] = useState(null); // null = all, array = selected names, [] = none
  const [statusFilter, setStatusFilter] = useState(null); // null = all, array = selected keys, [] = none
  const [filterOpen, setFilterOpen] = useState(false);
  const filterTriggerRef = useRef(null);
  const filterPanelRef = useRef(null);
  // History list (infinite scroll) state.
  const [historyRecords, setHistoryRecords] = useState([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const {
    columnsLoading: historyColumnsLoading,
    columnsError: historyColumnsError,
    editorOpen: historyEditorOpen,
    setEditorOpen: setHistoryEditorOpen,
    isColumnVisible: isHistoryColumnVisible,
    handleColumnToggle: handleHistoryColumnToggle,
  } = useTableColumns({
    tableKey: HISTORY_TABLE_KEY,
    allColumns: HISTORY_COLUMNS,
    defaultVisible: HISTORY_DEFAULT_COLUMNS,
  });

  const weekDays = useMemo(() => buildWeekDayKeys(weekStart), [weekStart]);
  const weekEnd = weekDays[6];
  const todayKey = getISTDateInputValue();
  const isCurrentWeek = weekStart === getWeekStartDayKey(todayKey);

  const loadOfficePolicy = useCallback(async () => {
    try {
      const officeResponse = await adminApi.getOfficeSettings();
      setPolicy(resolvePolicy(officeResponse.settings));
    } catch {
      // Keep the last known policy when the settings request fails.
    }
  }, []);

  const loadWeek = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const dayKeys = buildWeekDayKeys(weekStart);
      const years = [...new Set(dayKeys.map((key) => key.slice(0, 4)))];

      const [employeeList, officeResponse, warningResponse, confirmationResponse, weekRecords, leaveTypesResponse, departmentResponse] =
        await Promise.all([
          fetchActiveEmployees(),
          adminApi.getOfficeSettings().catch(() => ({ settings: null })),
          adminApi.getQuarterWarnings().catch(() => ({ byUser: {}, quarter: null, allowance: 3 })),
          adminApi.listWeekConfirmations(weekStart).catch(() => ({ confirmations: [] })),
          fetchWeekRecords(weekStart),
          leaveApi.listTypes().catch(() => ({ types: [] })),
          adminApi.listDepartments().catch(() => ({ departments: [] })),
        ]);

      setPolicy(resolvePolicy(officeResponse.settings));
      setDepartments(departmentResponse.departments ?? []);
      setQuarterWarnings(warningResponse);
      const confirmationMap = {};
      for (const row of confirmationResponse.confirmations ?? []) {
        confirmationMap[String(row.userId)] = row;
      }
      setWeekConfirmations(confirmationMap);

      const allRecords = weekRecords;
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
      setLeaveTypeCodeById(buildLeaveTypeCodeById(leaveTypesResponse.types, leaves));
    } catch (err) {
      setError(getErrorMessage(err));
      setEmployees([]);
      setRecordIndex(new Map());
      setLeaveEntries([]);
      setLeaveTypeCodeById(new Map());
      setHolidaySet(new Set());
      setQuarterWarnings({ byUser: {}, quarter: null, allowance: 3 });
    } finally {
      setLoading(false);
    }
  }, [weekStart]);

  // ── History list (infinite scroll) ──────────────────────────────────────
  const loadHistoryPage = useCallback(async (nextPage) => {
    if (nextPage < 1) return;
    const isFirst = nextPage === 1;
    if (isFirst) {
      setHistoryLoading(true);
    } else {
      setHistoryLoadingMore(true);
    }
    setHistoryError('');
    try {
      const data = await adminApi.listAttendance({ weekStart, page: nextPage, limit: 20 });
      const incoming = data.records ?? [];
      setHistoryRecords((current) => {
        const seen = new Set(current.map((record) => record.id ?? record._id));
        return [...current, ...incoming.filter((record) => !seen.has(record.id ?? record._id))];
      });
      setHistoryPage(nextPage);
      setHistoryTotalPages(data.pagination?.totalPages ?? 1);
    } catch (err) {
      setHistoryError(getErrorMessage(err));
    } finally {
      setHistoryLoading(false);
      setHistoryLoadingMore(false);
    }
  }, [weekStart]);

  useEffect(() => {
    setHistoryRecords([]);
    setHistoryPage(1);
    setHistoryTotalPages(1);
    setHistoryError('');
    loadHistoryPage(1);
  }, [loadHistoryPage]);

  useEffect(() => {
    // Reset pagination whenever filters change; keep the current week's first page.
    setHistoryRecords([]);
    setHistoryPage(1);
    setHistoryTotalPages(1);
    setHistoryError('');
    setGridVisibleCount(GRID_PAGE_SIZE);
    loadHistoryPage(1);
  }, [deptFilter, statusFilter, loadHistoryPage]);

  function handleGridScroll(event) {
    const el = event.currentTarget;
    if (gridVisibleCount >= filteredGridRows.length) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) {
      setGridVisibleCount((current) => Math.min(current + GRID_PAGE_SIZE, filteredGridRows.length));
    }
  }

  function handleHistoryScroll(event) {
    const el = event.currentTarget;
    if (historyLoading || historyLoadingMore) return;
    if (historyPage >= historyTotalPages) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      loadHistoryPage(historyPage + 1);
    }
  }

  useEffect(() => {
    setGridVisibleCount(GRID_PAGE_SIZE);
    loadWeek();
  }, [loadWeek]);

  useEffect(() => {
    const nextExpiry = leaveEntries
      .filter((entry) => resolveLeaveTypeDisplayCode(entry) === 'WFH' && entry?.status === 'approved')
      .map((entry) => parseTimestamp(entry.decisionUndoExpiresAt)?.getTime())
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > Date.now())
      .sort((a, b) => a - b)[0];
    if (!nextExpiry) return undefined;

    const timeout = setTimeout(
      () => setDecisionNow(Date.now()),
      Math.max(0, nextExpiry - Date.now() + 1),
    );
    return () => clearTimeout(timeout);
  }, [leaveEntries, decisionNow]);

  useEffect(() => {
    function applyOfficePolicy(settings) {
      if (!settings) return;
      setPolicy(resolvePolicy(settings));
    }

    function handlePolicyUpdate(event) {
      applyOfficePolicy(event.detail);
    }

    function handleStorageUpdate(event) {
      if (event.key !== 'attendance.office-policy-updated' || !event.newValue) return;
      try {
        applyOfficePolicy(JSON.parse(event.newValue));
      } catch {
        // Ignore invalid cached event data.
      }
    }

    function handlePolicyRefresh() {
      loadOfficePolicy();
      loadWeek();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        loadOfficePolicy();
        loadWeek();
      }
    }

    window.addEventListener('attendance:office-policy-updated', handlePolicyUpdate);
    window.addEventListener('storage', handleStorageUpdate);
    window.addEventListener('focus', handlePolicyRefresh);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('attendance:office-policy-updated', handlePolicyUpdate);
      window.removeEventListener('storage', handleStorageUpdate);
      window.removeEventListener('focus', handlePolicyRefresh);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadOfficePolicy, loadWeek]);

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
          leaveTypeCodeById,
          todayKey,
          policy,
          now: decisionNow,
        }),
      );
      const rejectedCount = cells.filter((cell) => cell.kind === 'rejected').length;
      const warningCount = cells.filter((cell) => cell.warningTag).length;
      return { employee, cells, rejectedCount, warningCount };
    });
  }, [employees, weekDays, recordIndex, holidaySet, leaveEntries, leaveTypeCodeById, todayKey, policy, decisionNow]);

  const departmentOptions = useMemo(() => {
    const names = new Set();
    for (const dept of departments) {
      const name = dept.name ?? dept.departmentName;
      if (name) names.add(name);
    }
    for (const employee of employees) {
      const name = employeeDepartmentName(employee);
      if (name) names.add(name);
    }
    const options = [...names].sort((a, b) => a.localeCompare(b));
    return [
      { value: 'all', label: 'All Departments' },
      ...options.map((name) => ({ value: name, label: name })),
    ];
  }, [departments, employees]);

  const allDeptNames = useMemo(
    () => departmentOptions.filter((option) => option.value !== 'all').map((option) => option.value),
    [departmentOptions],
  );

  const allStatusKeys = useMemo(
    () => WORKING_STATUS_OPTIONS.filter((option) => option.value !== 'all').map((option) => option.value),
    [],
  );

  const filteredGridRows = useMemo(() => {
    return gridRows.filter(({ employee, cells }) => {
      if (deptFilter !== null) {
        if (deptFilter.length === 0) return false;
        if (!deptFilter.includes(employeeDepartmentName(employee))) return false;
      }
      if (statusFilter !== null) {
        if (statusFilter.length === 0) return false;
        if (!cells.some((cell) => statusFilter.includes(cellStatusKey(cell)))) return false;
      }
      return true;
    });
  }, [gridRows, deptFilter, statusFilter]);

  const activeFilterCount =
    (deptFilter === null ? 0 : allDeptNames.length - deptFilter.length) +
    (statusFilter === null ? 0 : allStatusKeys.length - statusFilter.length);

  function isDeptChecked(name) {
    return deptFilter === null || deptFilter.includes(name);
  }

  function isStatusChecked(key) {
    return statusFilter === null || statusFilter.includes(key);
  }

  function toggleDept(name) {
    setDeptFilter((current) => {
      if (current === null) {
        const next = allDeptNames.filter((item) => item !== name);
        return next.length === 0 ? [] : next;
      }
      if (current.includes(name)) {
        const next = current.filter((item) => item !== name);
        return next.length === 0 ? [] : next;
      }
      const next = [...current, name];
      return next.length === allDeptNames.length ? null : next;
    });
  }

  function toggleStatus(key) {
    setStatusFilter((current) => {
      if (current === null) {
        const next = allStatusKeys.filter((item) => item !== key);
        return next.length === 0 ? [] : next;
      }
      if (current.includes(key)) {
        const next = current.filter((item) => item !== key);
        return next.length === 0 ? [] : next;
      }
      const next = [...current, key];
      return next.length === allStatusKeys.length ? null : next;
    });
  }

  function setAllDepts(selectAll) {
    setDeptFilter(selectAll ? null : []);
  }

  function setAllStatuses(selectAll) {
    setStatusFilter(selectAll ? null : []);
  }

  useEscapeKey(filterOpen, () => setFilterOpen(false));

  useEffect(() => {
    if (!filterOpen) return undefined;

    function handlePointerDown(event) {
      if (
        filterTriggerRef.current?.contains(event.target) ||
        filterPanelRef.current?.contains(event.target) ||
        (event.target instanceof Element && event.target.closest('.select-field__panel'))
      ) {
        return;
      }
      setFilterOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [filterOpen]);

  const summary = useMemo(() => {
    let present = 0;
    let absent = 0;
    let late = 0;
    let halfDay = 0;
    let workingSlots = 0;

    for (const row of filteredGridRows) {
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
  }, [filteredGridRows]);

  const quarterLabel = quarterWarnings.quarter?.label ?? 'Current quarter';
  const statusOptions = useMemo(
    () => buildStatusOptions(policy.warningsPerQuarter),
    [policy.warningsPerQuarter],
  );

  function openEditForDay(employee, dayKey, cell) {
    if (!isEditableAttendanceCell(cell)) return;

    setEditPickerTarget(null);

    if (cell.kind === 'absent') {
      setEditTarget({
        employee,
        dayKey,
        checkInRecordId: null,
        isCreate: true,
        hasCheckOutField: true,
        cellKind: cell.kind,
        checkInRecord: null,
      });
      setEditForm({
        checkInTime: normalizeHHmmTime(policy.officeStartTime) ?? '09:00',
        checkOutTime: '',
        statusCode: 'P',
        attendanceMode: 'office',
        lateNote: '',
      });
      setEditError('');
      return;
    }

    setEditTarget({
      employee,
      dayKey,
      checkInRecordId: cell.checkInRecordId,
      isCreate: false,
      hasCheckOutField: Boolean(cell.checkOutRecordId),
      cellKind: cell.kind,
      checkInRecord: cell.checkInRecord,
    });
    setEditForm({
      checkInTime: timestampToHHmmIST(cell.checkInRecord.timestamp),
      checkOutTime: cell.checkOutRecord ? timestampToHHmmIST(cell.checkOutRecord.timestamp) : '',
      statusCode: statusCodeFromCheckInRecord(cell.checkInRecord),
      attendanceMode: cell.checkInRecord.attendanceMode ?? 'office',
      lateNote: cell.checkInRecord.lateNote ?? '',
    });
    setEditError('');
  }

  function openEditForRow(employee, cells) {
    const editableDays = getEditableWeekDays(cells, weekDays);
    if (editableDays.length === 0) return;

    if (editableDays.length === 1) {
      const { dayKey, cell } = editableDays[0];
      openEditForDay(employee, dayKey, cell);
      return;
    }

    setEditPickerTarget({ employee, editableDays });
  }

  function closeEditPickerModal() {
    setEditPickerTarget(null);
  }

  function closeEditModal() {
    if (editSaving) return;
    setEditTarget(null);
    setEditError('');
  }

  function patchEditForm(patch) {
    setEditForm((current) => ({ ...current, ...patch }));
  }

  async function saveAttendanceEdit() {
    if (!editTarget) return;
    if (!editTarget.isCreate && !editTarget.checkInRecordId) return;
    if (!isValidHHmmTime(editForm.checkInTime)) {
      setEditError('Enter a valid check-in time.');
      return;
    }
    if (
      editTarget.hasCheckOutField &&
      editForm.checkOutTime &&
      !isValidHHmmTime(editForm.checkOutTime)
    ) {
      setEditError('Enter a valid check-out time.');
      return;
    }

    setEditSaving(true);
    setEditError('');
    try {
      const payload = {
        checkInTime: normalizeHHmmTime(editForm.checkInTime),
        statusCode: editForm.statusCode,
        attendanceMode: editForm.attendanceMode,
        lateNote: editForm.lateNote.trim() ? editForm.lateNote.trim() : null,
      };
      if (editTarget.hasCheckOutField) {
        payload.checkOutTime = editForm.checkOutTime
          ? normalizeHHmmTime(editForm.checkOutTime)
          : null;
      }

      if (editTarget.isCreate) {
        await adminApi.upsertAttendanceRecord({
          userId: editTarget.employee.id,
          dayKey: editTarget.dayKey,
          ...payload,
        });
      } else {
        await adminApi.editAttendanceRecord(editTarget.checkInRecordId, payload);
      }
      const employeeName = editTarget.employee.name;
      const created = editTarget.isCreate;
      setEditTarget(null);
      await loadWeek();
      showSuccess(
        created
          ? `Attendance created for ${employeeName}.`
          : `Attendance updated for ${employeeName}.`,
      );
    } catch (err) {
      const message = getErrorMessage(err);
      setEditError(message);
      showError(message);
    } finally {
      setEditSaving(false);
    }
  }

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

  async function confirmWeekForEmployee(employeeId, employeeName) {
    setConfirmingUserId(employeeId);
    setError('');
    try {
      const result = await adminApi.confirmWeekAttendance({
        userId: employeeId,
        weekStart,
      });
      setWeekConfirmations((current) => ({
        ...current,
        [String(employeeId)]: result.confirmation,
      }));
      showSuccess(`Week attendance confirmed for ${employeeName}.`);
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      showError(message);
    } finally {
      setConfirmingUserId(null);
    }
  }

  async function unconfirmWeekForEmployee(employeeId, employeeName) {
    await requestConfirm({
      title: 'Undo week confirmation?',
      message: `Remove confirmation for ${employeeName} for this week?`,
      confirmLabel: 'Undo',
      variant: 'danger',
      onConfirm: async () => {
        setUnconfirmingUserId(employeeId);
        setError('');
        try {
          await adminApi.unconfirmWeekAttendance({
            userId: employeeId,
            weekStart,
          });
          setWeekConfirmations((current) => {
            const next = { ...current };
            delete next[String(employeeId)];
            return next;
          });
          showSuccess(`Week confirmation undone for ${employeeName}.`);
        } catch (err) {
          const message = getErrorMessage(err);
          setError(message);
          showError(message);
        } finally {
          setUnconfirmingUserId(null);
        }
      },
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
            <div className="attendance-filter-popover-wrap">
              <button
                ref={filterTriggerRef}
                type="button"
                className={[
                  'btn btn-ghost attendance-filter-trigger',
                  activeFilterCount > 0 ? 'attendance-filter-trigger--active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-haspopup="dialog"
                aria-expanded={filterOpen}
                onClick={() => setFilterOpen((current) => !current)}
              >
                Filter
                {activeFilterCount > 0 ? (
                  <span className="attendance-filter-trigger__badge">{activeFilterCount}</span>
                ) : null}
              </button>
              {filterOpen ? (
                <div
                  ref={filterPanelRef}
                  className="attendance-filter-popover"
                  role="dialog"
                  aria-label="Attendance filters"
                >
                  <div className="attendance-filter-popover__group">
                    <div className="attendance-filter-popover__group-head">
                      <span className="attendance-filters__label">Department</span>
                      <button
                        type="button"
                        className="attendance-filter-popover__select-all"
                        onClick={() => setAllDepts(deptFilter !== null)}
                      >
                        {deptFilter === null ? 'Deselect all' : 'Select all'}
                      </button>
                    </div>
                    <div className="attendance-filter-popover__options">
                      {departmentOptions
                        .filter((option) => option.value !== 'all')
                        .map((option) => (
                          <label
                            key={option.value}
                            className="attendance-filter-checkbox"
                          >
                            <input
                              type="checkbox"
                              checked={isDeptChecked(option.value)}
                              onChange={() => toggleDept(option.value)}
                            />
                            <span>{option.label}</span>
                          </label>
                        ))}
                    </div>
                  </div>
                  <div className="attendance-filter-popover__group">
                    <div className="attendance-filter-popover__group-head">
                      <span className="attendance-filters__label">Working Status</span>
                      <button
                        type="button"
                        className="attendance-filter-popover__select-all"
                        onClick={() => setAllStatuses(statusFilter !== null)}
                      >
                        {statusFilter === null ? 'Deselect all' : 'Select all'}
                      </button>
                    </div>
                    <div className="attendance-filter-popover__options">
                      {WORKING_STATUS_OPTIONS.filter((option) => option.value !== 'all').map((option) => (
                        <label
                          key={option.value}
                          className="attendance-filter-checkbox"
                        >
                          <input
                            type="checkbox"
                            checked={isStatusChecked(option.value)}
                            onChange={() => toggleStatus(option.value)}
                          />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  {activeFilterCount > 0 ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm attendance-filter-popover__clear"
                      onClick={() => {
                        setDeptFilter(null);
                        setStatusFilter(null);
                      }}
                    >
                      Clear filters
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
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
        ) : filteredGridRows.length === 0 ? (
          <div className="attendance-grid-empty">
            <EmptyState
              icon={EMPTY_ICONS.calendar}
              title="No employees match the filters"
              description="Adjust the department or working status filters to see more."
            />
          </div>
        ) : (
          <div
            className="attendance-grid-scroll table-wrap"
            onScroll={handleGridScroll}
            style={{
              '--selected-day-left': selectedDayKey
                ? `calc(var(--attendance-row-num-width) + 14rem + ${weekDays.indexOf(selectedDayKey)} * 5.25rem)`
                : undefined,
            }}
          >
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
                {filteredGridRows.slice(0, gridVisibleCount).map(({ employee, cells, rejectedCount }, rowIndex) => {
                  const id = employee.id;
                  const confirmation = weekConfirmations[String(id)];
                  const isConfirming = confirmingUserId === id;
                  const isUnconfirming = unconfirmingUserId === id;
                  const designation = employeeDesignation(employee);
                  const email = employee.email ?? null;
                  const editableWeekDays = getEditableWeekDays(cells, weekDays);
                  const canEditWeek = editableWeekDays.length > 0;
                  const editButtonTitle = canEditWeek
                    ? editableWeekDays.length === 1
                      ? `Edit ${formatDayPickerLabel(editableWeekDays[0].dayKey)} attendance`
                      : `Edit attendance (${editableWeekDays.length} editable days this week)`
                    : 'No past working days to edit this week';
                  return (
                    <tr key={id}>
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
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm attendance-grid__edit"
                            disabled={!canEditWeek || isConfirming || isUnconfirming || editSaving}
                            title={editButtonTitle}
                            aria-label={
                              canEditWeek
                                ? `Edit attendance for ${employee.name}, ${editableWeekDays.length} day${editableWeekDays.length === 1 ? '' : 's'} available`
                                : 'Edit unavailable — no past working days this week'
                            }
                            onClick={() => openEditForRow(employee, cells)}
                          >
                            Edit
                          </button>
                          {confirmation ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm attendance-grid__undo"
                              disabled={isUnconfirming || isConfirming}
                              onClick={() => unconfirmWeekForEmployee(id, employee.name)}
                            >
                              {isUnconfirming ? '…' : 'Undo'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm attendance-grid__confirm"
                              disabled={isConfirming || isUnconfirming}
                              onClick={() => confirmWeekForEmployee(id, employee.name)}
                            >
                              {isConfirming ? '…' : 'Confirm'}
                            </button>
                          )}
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
            <div className="attendance-grid-scroll__status">
              {gridVisibleCount < filteredGridRows.length
                ? `Showing ${gridVisibleCount} of ${filteredGridRows.length} employees — scroll for more`
                : `Showing all ${filteredGridRows.length} employees`}
            </div>
          </div>
        )}
      </section>

      <section
        className="attendance-history-panel card card--table"
        aria-label="Attendance history list"
      >
        <div className="attendance-history-panel__header">
          <h2 className="card__section-title">Attendance History</h2>
          <span className="muted small">
            Scroll to load more · Week of {formatWeekRangeLabel(weekStart, weekEnd)}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setHistoryEditorOpen(true)}
          >
            Edit columns
          </button>
        </div>
        {historyError ? <div className="alert alert--error">{historyError}</div> : null}
        {historyColumnsError ? <div className="alert alert--error">{historyColumnsError}</div> : null}
        {historyLoading ? (
          <GridSkeleton />
        ) : historyRecords.length === 0 ? (
          <div className="attendance-grid-empty">
            <EmptyState
              icon={EMPTY_ICONS.calendar}
              title="No attendance records for this week"
              description={
                deptFilter !== 'all' || statusFilter !== 'all'
                  ? 'Adjust the filters to see more records.'
                  : 'Employees have not checked in during this week.'
              }
            />
          </div>
        ) : (
          <div
            className="attendance-history-scroll table-wrap"
            onScroll={handleHistoryScroll}
          >
            <table className="attendance-history">
              <thead>
                <tr>
                  {isHistoryColumnVisible('employee') && <th scope="col">Employee</th>}
                  {isHistoryColumnVisible('department') && <th scope="col">Department</th>}
                  {isHistoryColumnVisible('date') && <th scope="col">Date (IST)</th>}
                  {isHistoryColumnVisible('type') && <th scope="col">Type</th>}
                  {isHistoryColumnVisible('status') && <th scope="col">Status</th>}
                  {isHistoryColumnVisible('mode') && <th scope="col">Mode</th>}
                  {isHistoryColumnVisible('time') && <th scope="col">Time (IST)</th>}
                </tr>
              </thead>
              <tbody>
                {historyRecords.map((record) => {
                  const user = record.userId;
                  const userName =
                    (typeof user === 'object' && user ? user.name : null) ?? 'Unknown';
                  const userDept =
                    (typeof user === 'object' && user
                      ? user.departmentName ?? user.department ?? null
                      : null) ?? '—';
                  return (
                    <tr key={record.id ?? record._id}>
                      {isHistoryColumnVisible('employee') && <td data-label="Employee">{userName}</td>}
                      {isHistoryColumnVisible('department') && <td data-label="Department">{userDept}</td>}
                      {isHistoryColumnVisible('date') && <td data-label="Date (IST)">{toIstDayKey(record.timestamp) ?? '—'}</td>}
                      {isHistoryColumnVisible('type') && (
                        <td data-label="Type">
                          {record.type === 'check_in' ? 'Check-in' : 'Check-out'}
                        </td>
                      )}
                      {isHistoryColumnVisible('status') && (
                        <td data-label="Status">
                          <span
                            className={`badge ${
                              record.status === 'allowed' ? 'badge-success' : 'badge-warning'
                            }`}
                          >
                            {record.status}
                          </span>
                        </td>
                      )}
                      {isHistoryColumnVisible('mode') && (
                        <td data-label="Mode">
                          <span
                            className={`attendance-mode-badge attendance-mode-badge--${
                              record.attendanceMode === 'wfh' ? 'wfh' : 'office'
                            }`}
                          >
                            {record.attendanceMode === 'wfh' ? 'WFH' : 'Office'}
                          </span>
                        </td>
                      )}
                      {isHistoryColumnVisible('time') && <td data-label="Time (IST)">{formatISTDateTime(record.timestamp)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {historyLoadingMore ? (
              <div className="attendance-history-more">
                <span className="spinner spinner--sm" aria-hidden="true" /> Loading more…
              </div>
            ) : null}
            {!historyLoadingMore && historyPage >= historyTotalPages && historyRecords.length > 0 ? (
              <p className="attendance-history-end muted small">End of records</p>
            ) : null}
          </div>
        )}

        <ColumnEditorPanel
          open={historyEditorOpen}
          columns={HISTORY_COLUMNS}
          isColumnVisible={isHistoryColumnVisible}
          onToggle={handleHistoryColumnToggle}
          loading={historyColumnsLoading}
          onClose={() => setHistoryEditorOpen(false)}
        />
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
            Late arrivals are shown as W1/W2/W3 warning tags alongside Present — not a separate L code.
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
            <li>Employees receive {policy.warningsPerQuarter} warning chances per quarter (3 months).</li>
            <li>
              With warnings remaining, check-in after {formatPolicyTime(policy.graceThresholdTime)} and before{' '}
              {formatPolicyTime(policy.halfDayThresholdTime)} is marked as a full day with the next warning.
            </li>
            <li>With 0 warnings remaining, any check-in after {formatPolicyTime(policy.graceThresholdTime)} before the half-day threshold is marked as LV (leave violation).</li>
            <li>Check-in at or after {formatPolicyTime(policy.halfDayThresholdTime)} is marked as Half Day.</li>
            <li>With 0 warnings remaining after the half-day threshold, check-in is still Half Day.</li>
          </ul>
          <p className="attendance-policy__note muted small">
            Office hours are Monday to Friday, {formatPolicyTime(policy.officeStartTime)} to{' '}
            {formatPolicyTime(policy.officeEndTime)} IST. Saturday and Sunday are non-working days.
            Thresholds are configured on the Geolocation page.
          </p>
        </section>
      </div>
      {confirmDialog}
      <AttendanceDayPickerModal
        target={editPickerTarget}
        onClose={closeEditPickerModal}
        onSelectDay={(dayKey, cell) => openEditForDay(editPickerTarget.employee, dayKey, cell)}
      />
      <AttendanceEditModal
        target={editTarget}
        form={editForm}
        error={editError}
        saving={editSaving}
        statusOptions={statusOptions}
        onClose={closeEditModal}
        onChange={patchEditForm}
        onSubmit={saveAttendanceEdit}
      />
    </div>
  );
}
