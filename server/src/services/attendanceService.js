import mongoose from 'mongoose';
import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { UndoAction } from '../models/UndoAction.js';

const UNDO_WINDOW_MS = 5 * 60 * 1000;
import { LeaveRequest, LEAVE_REQUEST_POPULATE } from '../models/LeaveRequest.js';
import { User } from '../models/User.js';
import { evaluateGeoAttendance, getOfficeSettings } from './geoService.js';
import {
  evaluateCheckInPolicy,
  getQuarterWarningSummaryForUsers,
  parseStatusCodeToPolicyFields,
  statusCodeFromRecord,
} from './attendancePolicyService.js';
import { getHolidayMapForYear } from './leaveService.js';
import {
  isUserInTeamScope,
  resolveTeamScopedUserIds,
} from './teamScopeService.js';
import {
  endOfDayIST,
  formatISTDateTime,
  getISTDateInputValue,
  isWeekendIST,
  listWorkingDaysIST,
  parseDateInputAsISTDay,
  parseMonthInputAsISTRange,
  startOfDayIST,
  buildISTTimestampFromDayAndTime,
  getISTTimeHHmm,
} from '../utils/istDate.js';
import { auditLog } from '../utils/auditLog.js';
import {
  hasApprovedWfhForIstDate,
} from './wfhPolicyService.js';
import { WFH_LEAVE_TYPE_CODE } from '../../../shared/utils/wfhPolicy.js';

function throwError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

async function getTodayRecords(userId, session = null) {
  const query = AttendanceRecord.find({
    userId,
    timestamp: { $gte: startOfDayIST(), $lte: endOfDayIST() },
    status: 'allowed',
  }).sort({ timestamp: 1 });

  if (session) {
    query.session(session);
  }

  return query;
}

async function loadPendingLeaveForToday(userId) {
  const todayDay = parseDateInputAsISTDay(getISTDateInputValue());
  const request = await LeaveRequest.findOne({
    userId,
    status: 'pending',
    startDate: { $lte: todayDay },
    endDate: { $gte: todayDay },
  })
    .populate(LEAVE_REQUEST_POPULATE[0])
    .sort({ createdAt: -1 });

  if (!request) {
    return null;
  }

  const safe = request.toSafeJSON();
  return {
    id: safe.id,
    leaveTypeCode: safe.leaveTypeCode,
    leaveTypeName: safe.leaveTypeName,
    startDate: safe.startDate,
    endDate: safe.endDate,
    days: safe.days,
    halfDay: safe.halfDay,
  };
}

async function loadApprovedLeaveForToday(userId) {
  const todayDay = parseDateInputAsISTDay(getISTDateInputValue());
  const request = await LeaveRequest.findOne({
    userId,
    status: 'approved',
    startDate: { $lte: todayDay },
    endDate: { $gte: todayDay },
  })
    .populate(LEAVE_REQUEST_POPULATE[0])
    .sort({ createdAt: -1 });

  if (!request) {
    return null;
  }

  const safe = request.toSafeJSON();
  return {
    id: safe.id,
    leaveTypeCode: safe.leaveTypeCode,
    leaveTypeName: safe.leaveTypeName,
    startDate: safe.startDate,
    endDate: safe.endDate,
    days: safe.days,
    halfDay: safe.halfDay,
  };
}

export function isCheckInBlockedByApprovedLeave(approvedLeaveToday, wfhApprovedToday) {
  return Boolean(approvedLeaveToday) && !wfhApprovedToday;
}

function buildTodayStatus(
  records,
  office,
  pendingLeaveToday = null,
  wfhApprovedToday = false,
  approvedLeaveToday = null,
) {
  const checkIn = records.find((record) => record.type === 'check_in') ?? null;
  const checkOut = records.find((record) => record.type === 'check_out') ?? null;

  return {
    checkIn,
    checkOut,
    canCheckIn: !checkIn && !isCheckInBlockedByApprovedLeave(approvedLeaveToday, wfhApprovedToday),
    canCheckOut: Boolean(checkIn) && !checkOut,
    pendingLeaveToday,
    approvedLeaveToday,
    wfhApprovedToday,
    istDate: getISTDateInputValue(),
    currentIST: formatISTDateTime(new Date()),
    office: {
      name: office.name,
      latitude: office.latitude,
      longitude: office.longitude,
      radiusMeters: office.radiusMeters,
      maxAccuracyMeters: office.maxAccuracyMeters,
      graceThresholdTime: office.graceThresholdTime ?? '09:00',
      halfDayThresholdTime: office.halfDayThresholdTime ?? '10:00',
      warningsPerQuarter: office.warningsPerQuarter ?? 3,
      weekendDays: office.weekendDays ?? [0, 6],
    },
  };
}

async function getUndoAvailability(userId) {
  const lastRecord = await AttendanceRecord.findOne({ userId })
    .sort({ timestamp: -1 })
    .lean();
  if (!lastRecord || lastRecord.status !== 'allowed') return null;
  const action = await UndoAction.findOne({
    actorId: userId,
    targetType: 'attendance',
    targetId: lastRecord._id,
    status: 'active',
  }).lean();
  if (!action) return null;
  if (Date.now() - new Date(action.createdAt).getTime() > UNDO_WINDOW_MS) return null;
  return {
    available: true,
    token: action._id.toString(),
    type: lastRecord.type,
    expiresAt: new Date(action.createdAt).getTime() + UNDO_WINDOW_MS,
  };
}

export async function getTodayStatus(userId) {
  const istToday = getISTDateInputValue();
  const [records, office, pendingLeaveToday, wfhApprovedToday, approvedLeaveToday] = await Promise.all([
    getTodayRecords(userId),
    getOfficeSettings(),
    loadPendingLeaveForToday(userId),
    hasApprovedWfhForIstDate(userId, istToday),
    loadApprovedLeaveForToday(userId),
  ]);
  const status = buildTodayStatus(
    records,
    office,
    pendingLeaveToday,
    wfhApprovedToday,
    approvedLeaveToday,
  );
  status.undo = await getUndoAvailability(userId);
  return status;
}

export async function markAttendance(userId, type, payload, auditContext = {}) {
  const session = await mongoose.startSession();

  try {
    let result;
    await session.withTransaction(async () => {
      const office = await getOfficeSettings();
      const records = await getTodayRecords(userId, session);
      const istToday = getISTDateInputValue();
      let wfhApprovedToday = false;
      let approvedLeaveToday = null;
      if (type === 'check_in') {
        [wfhApprovedToday, approvedLeaveToday] = await Promise.all([
          hasApprovedWfhForIstDate(userId, istToday),
          loadApprovedLeaveForToday(userId),
        ]);
      }
      const today = buildTodayStatus(
        records,
        office,
        null,
        wfhApprovedToday,
        approvedLeaveToday,
      );
      const existingCheckIn = records.find((record) => record.type === 'check_in') ?? null;
      let attendanceMode;
      if (type === 'check_out' && existingCheckIn) {
        attendanceMode = existingCheckIn.attendanceMode ?? 'office';
      } else if (type === 'check_in') {
        attendanceMode = wfhApprovedToday ? 'wfh' : 'office';
      } else {
        attendanceMode = payload.attendanceMode ?? 'office';
      }

      const enforceOfficeRadius = attendanceMode === 'office';
      const geo = evaluateGeoAttendance({
        ...payload,
        office,
        enforceOfficeRadius,
      });

      const businessReasons = [];
      if (type === 'check_in') {
        if (today.checkIn) {
          businessReasons.push('You have already checked in today.');
        } else if (isCheckInBlockedByApprovedLeave(approvedLeaveToday, wfhApprovedToday)) {
          businessReasons.push('Check-in is not available on approved leave days.');
        }
      }
      if (type === 'check_out' && !today.canCheckOut) {
        if (!today.checkIn) {
          businessReasons.push('Check-in is required before check-out.');
        } else {
          businessReasons.push('You have already checked out today.');
        }
      }

      const rejectionReasons = [...geo.rejectionReasons, ...businessReasons];
      const status = rejectionReasons.length === 0 ? 'allowed' : 'rejected';

      let policyFields = {};
      if (type === 'check_in' && status === 'allowed') {
        policyFields = await evaluateCheckInPolicy(userId, new Date(), office, session);
      }

      const [record] = await AttendanceRecord.create(
        [
          {
            userId,
            type,
            attendanceMode,
            timestamp: new Date(),
            latitude: payload.latitude,
            longitude: payload.longitude,
            accuracyMeters: payload.accuracyMeters,
            distanceMeters: geo.distanceMeters,
            officeLatitude: office.latitude,
            officeLongitude: office.longitude,
            radiusMeters: office.radiusMeters,
            status,
            rejectionReasons,
            lateNote: type === 'check_in' && status === 'allowed' ? payload.lateNote ?? null : null,
            ...policyFields,
          },
        ],
        { session },
      );

      auditLog('attendance_marked', {
        userId: userId.toString(),
        email: auditContext.email,
        type,
        attendanceMode,
        status,
        distanceMeters: geo.distanceMeters,
        accuracyMeters: payload.accuracyMeters,
        deviceId: payload.deviceId ?? auditContext.deviceId,
        ip: auditContext.ip,
        userAgent: auditContext.userAgent,
      });

      result = { record, office, status, rejectionReasons };

      // Only effective (allowed) actions can be undone. Mint a fresh, single-use
      // token for this action and expire any prior token so only the latest
      // attendance action is undoable ("one chance at a time").
      if (status === 'allowed') {
        await UndoAction.updateMany(
          { actorId: userId, targetType: 'attendance', status: 'active' },
          { $set: { status: 'expired' } },
          { session },
        );
        const [undoAction] = await UndoAction.create(
          [
            {
              actorId: userId,
              targetType: 'attendance',
              targetId: record._id,
            },
          ],
          { session },
        );
        result.undoToken = undoAction._id.toString();
        result.undo = {
          available: true,
          token: undoAction._id.toString(),
          type,
          expiresAt: undoAction.createdAt.getTime() + UNDO_WINDOW_MS,
        };
      }
    });

    if (type === 'check_in' && result?.status === 'allowed') {
      const summary = await getQuarterWarningSummaryForUsers([userId]);
      const userKey = String(userId);
      const row = summary.byUser[userKey] ?? {
        used: 0,
        allowance: summary.allowance,
        remaining: summary.allowance,
      };
      result.quarterWarnings = {
        quarter: summary.quarter,
        allowance: summary.allowance,
        used: row.used,
        remaining: row.remaining,
      };
    }

    result.pendingLeaveToday = await loadPendingLeaveForToday(userId);

    return result;
  } finally {
    session.endSession();
  }
}

export async function getEmployeeHistory(userId, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;
  const [records, total] = await Promise.all([
    AttendanceRecord.find({ userId })
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit),
    AttendanceRecord.countDocuments({ userId }),
  ]);

  return {
    records,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

export async function getAdminAttendance({
  userId,
  date,
  weekStart,
  page = 1,
  limit = 20,
  actor,
  permissions,
}) {
  const query = {};
  if (userId) {
    query.userId = userId;
  }

  const canReadAll = hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_ALL);
  const canReadTeam = hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_TEAM);

  if (!canReadAll && canReadTeam && actor?._id) {
    const scopedIds = await resolveTeamScopedUserIds(
      actor,
      permissions,
      PERMISSIONS.ATTENDANCE_READ_ALL,
      PERMISSIONS.ATTENDANCE_READ_TEAM,
    );

    if (userId) {
      const allowed = scopedIds === null || scopedIds.some((id) => id.toString() === userId.toString());
      if (!allowed) {
        return {
          records: [],
          pagination: { page, limit, total: 0, totalPages: 1 },
        };
      }
    } else if (scopedIds !== null) {
      query.userId = { $in: scopedIds };
    }
  }

  if (weekStart) {
    const weekStartDay = parseDateInputAsISTDay(weekStart);
    if (weekStartDay) {
      const weekEndDay = new Date(weekStartDay.getTime() + 6 * 24 * 60 * 60 * 1000);
      query.timestamp = {
        $gte: startOfDayIST(weekStartDay),
        $lte: endOfDayIST(weekEndDay),
      };
    }
  } else if (date) {
    const istDay = parseDateInputAsISTDay(date);
    if (istDay) {
      query.timestamp = {
        $gte: startOfDayIST(istDay),
        $lte: endOfDayIST(istDay),
      };
    }
  }

  const skip = (page - 1) * limit;
  const [records, total] = await Promise.all([
    AttendanceRecord.find(query)
      .populate('userId', 'name email mobile employeeCode department')
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit),
    AttendanceRecord.countDocuments(query),
  ]);

  return {
    records: records.map(serializeAdminAttendanceListRecord),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

/** Maps IST day key → calendar status (`present` | `half_day`). Legacy rows without tag count as present. */
export function monthCalendarStatusForCheckInTag(attendanceTag) {
  if (attendanceTag === 'HD' || attendanceTag === 'LV') return 'half_day';
  return 'present';
}

async function loadCheckInDayStatusMap(userId, monthStart, monthEnd) {
  const records = await AttendanceRecord.find({
    userId,
    type: 'check_in',
    status: 'allowed',
    timestamp: { $gte: monthStart, $lte: monthEnd },
  }).select('timestamp attendanceTag');

  const map = new Map();
  for (const record of records) {
    map.set(
      getISTDateInputValue(record.timestamp),
      monthCalendarStatusForCheckInTag(record.attendanceTag),
    );
  }
  return map;
}

/**
 * Split approved leave covering the month into regular leave vs WFH working days (IST keys).
 * WFH is returned separately so the employee calendar can show a WFH status instead of generic leave.
 */
async function loadApprovedLeaveDaySets(userId, monthStart, monthEnd, holidayDates) {
  const requests = await LeaveRequest.find({
    userId,
    status: 'approved',
    startDate: { $lte: monthEnd },
    endDate: { $gte: monthStart },
  })
    .select('startDate endDate leaveTypeId')
    .populate({ path: 'leaveTypeId', select: 'code' });

  const leaveDays = new Set();
  const wfhDays = new Set();
  for (const request of requests) {
    const overlapStart = request.startDate > monthStart ? request.startDate : monthStart;
    const overlapEnd = request.endDate < monthEnd ? request.endDate : monthEnd;
    if (overlapEnd < overlapStart) {
      continue;
    }
    const code = String(request.leaveTypeId?.code ?? '').toUpperCase();
    const target = code === WFH_LEAVE_TYPE_CODE ? wfhDays : leaveDays;
    for (const dayKey of listWorkingDaysIST(overlapStart, overlapEnd, holidayDates)) {
      target.add(dayKey);
    }
  }
  return { leaveDays, wfhDays };
}

/**
 * Pure day classifier for employee month calendar status codes.
 * Priority: weekend → holiday → (future leave/WFH) → check-in present/half_day → WFH → leave → absent.
 */
export function resolveEmployeeMonthDayStatus({
  dayKey,
  todayKey,
  isWeekend,
  isHoliday,
  checkInStatus = null,
  wfhDay = false,
  leaveDay = false,
}) {
  if (isWeekend) return 'weekend';
  if (isHoliday) return 'holiday';
  if (dayKey > todayKey) {
    if (wfhDay) return 'wfh_future';
    if (leaveDay) return 'leave_future';
    return 'future';
  }
  if (checkInStatus) return checkInStatus;
  if (wfhDay) return 'wfh';
  if (leaveDay) return 'leave';
  if (dayKey < todayKey) return 'absent';
  return 'none';
}

/**
 * Group active employees whose DOB month-day falls in the given calendar month (IST).
 * Year of birth is ignored. Feb 29 only appears in leap years on that day.
 * Privacy: returns firstName + display name only.
 */
export function buildMonthBirthdayMap(users, monthKey) {
  const birthdays = {};
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
    return birthdays;
  }
  const [, calendarMonth] = monthKey.split('-');

  for (const user of users) {
    if (!user?.dateOfBirth) continue;
    const dobInput = getISTDateInputValue(user.dateOfBirth);
    if (!dobInput || dobInput.length < 10) continue;
    const month = dobInput.slice(5, 7);
    const day = dobInput.slice(8, 10);
    if (month !== calendarMonth) continue;

    const dayKey = `${monthKey}-${day}`;
    const firstName = (user.firstName || '').trim() || (user.name || '').trim().split(/\s+/)[0] || 'Colleague';
    const name = (user.name || '').trim() || firstName;
    if (!birthdays[dayKey]) {
      birthdays[dayKey] = [];
    }
    birthdays[dayKey].push({ firstName, name });
  }

  for (const dayKey of Object.keys(birthdays)) {
    birthdays[dayKey].sort((a, b) => a.firstName.localeCompare(b.firstName, 'en'));
  }
  return birthdays;
}

export async function loadMonthBirthdays(monthKey) {
  const users = await User.find({
    isActive: true,
    dateOfBirth: { $ne: null },
    role: { $ne: 'admin' },
  })
    .select('firstName name dateOfBirth')
    .lean();
  return buildMonthBirthdayMap(users, monthKey);
}

/**
 * Per-day attendance status for a calendar month (IST).
 * v1 scope: employee own data via /attendance/month-summary; admins may pass userId when
 * ATTENDANCE_READ_ALL or ATTENDANCE_READ_TEAM (direct reports only) allows it.
 *
 * Also returns holiday names and company birthdays for the month calendar UI.
 */
export async function getMonthDayStatusSummary(userId, monthInput) {
  const range = parseMonthInputAsISTRange(monthInput);
  if (!range) {
    throwError('Invalid month. Use YYYY-MM.');
  }

  const { year, monthKey, start, end, daysInMonth } = range;
  const office = await getOfficeSettings();
  const weekendDays = office?.weekendDays ?? [0, 6];
  const [holidayMap, birthdays] = await Promise.all([
    getHolidayMapForYear(year),
    loadMonthBirthdays(monthKey),
  ]);
  const holidayDates = new Set(holidayMap.keys());
  const todayKey = getISTDateInputValue();

  const [checkInDayStatusMap, { leaveDays, wfhDays }] = await Promise.all([
    loadCheckInDayStatusMap(userId, start, end),
    loadApprovedLeaveDaySets(userId, start, end, holidayDates),
  ]);

  const days = {};
  const holidays = {};
  for (let dayNum = 1; dayNum <= daysInMonth; dayNum += 1) {
    const dayKey = `${monthKey}-${String(dayNum).padStart(2, '0')}`;
    const dayDate = parseDateInputAsISTDay(dayKey);
    const isHoliday = holidayDates.has(dayKey);

    days[dayKey] = resolveEmployeeMonthDayStatus({
      dayKey,
      todayKey,
      isWeekend: isWeekendIST(dayDate, weekendDays),
      isHoliday,
      checkInStatus: checkInDayStatusMap.get(dayKey) ?? null,
      wfhDay: wfhDays.has(dayKey),
      leaveDay: leaveDays.has(dayKey),
    });

    if (days[dayKey] === 'holiday') {
      const holiday = holidayMap.get(dayKey);
      if (holiday) {
        holidays[dayKey] = { name: holiday.name, type: holiday.type };
      }
    }
  }

  return {
    year,
    month: monthKey,
    today: todayKey,
    days,
    holidays,
    birthdays,
  };
}

export async function resolveMonthSummaryTargetUserId(actor, permissions, requestedUserId) {
  const actorId = actor._id.toString();
  if (!requestedUserId || requestedUserId === actorId) {
    if (!hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_OWN)) {
      throwError('You do not have permission to view attendance.', 403);
    }
    return actor._id;
  }

  const canReadAll = hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_ALL);
  const canReadTeam = hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_TEAM);

  if (!canReadAll && !canReadTeam) {
    throwError('You do not have permission to view this employee\'s attendance.', 403);
  }

  if (!mongoose.isValidObjectId(requestedUserId)) {
    throwError('Employee not found.', 404);
  }

  if (!canReadAll) {
    const allowed = await isUserInTeamScope(
      actor,
      permissions,
      requestedUserId,
      PERMISSIONS.ATTENDANCE_READ_ALL,
      PERMISSIONS.ATTENDANCE_READ_TEAM,
    );
    if (!allowed) {
      throwError('You do not have permission to view this employee\'s attendance.', 403);
    }
  }

  const target = await User.findById(requestedUserId).select('_id isActive');
  if (!target?.isActive) {
    throwError('Employee not found.', 404);
  }

  return target._id;
}

function snapshotAttendanceRecord(record) {
  if (!record) return null;
  return {
    id: record._id.toString(),
    type: record.type,
    timestamp: record.timestamp,
    attendanceMode: record.attendanceMode,
    attendanceTag: record.attendanceTag,
    warningIssued: record.warningIssued,
    quarterWarningIndex: record.quarterWarningIndex,
    lateNote: record.lateNote ?? null,
    status: record.status,
  };
}

function serializeEditActor(actor) {
  if (!actor) return null;
  return {
    id: actor.id?.toString?.() ?? actor._id?.toString?.() ?? String(actor),
    name: actor.name ?? actor.email ?? 'Unknown',
  };
}

function serializeEditHistoryEntry(entry) {
  if (!entry) return null;
  return {
    editedAt: entry.editedAt,
    editedBy: entry.editedBy
      ? {
        id: entry.editedBy.id,
        name: entry.editedBy.name,
      }
      : null,
    changes: (entry.changes ?? []).map((change) => ({
      field: change.field,
      from: change.from ?? null,
      to: change.to ?? null,
    })),
  };
}

function serializeEditMetadata(record) {
  if (!record?.lastEditedAt) {
    return {
      lastEditedAt: null,
      lastEditedBy: null,
      editHistory: [],
    };
  }
  return {
    lastEditedAt: record.lastEditedAt,
    lastEditedBy: record.lastEditedBy
      ? {
        id: record.lastEditedBy.id,
        name: record.lastEditedBy.name,
      }
      : null,
    editHistory: (record.editHistory ?? []).map(serializeEditHistoryEntry).filter(Boolean),
  };
}

function buildAttendanceEditChanges({
  beforeCheckIn,
  afterCheckIn,
  beforeCheckOut,
  afterCheckOut,
}) {
  const changes = [];
  if (!beforeCheckIn || !afterCheckIn) return changes;

  const beforeCheckInTime = getISTTimeHHmm(beforeCheckIn.timestamp);
  const afterCheckInTime = getISTTimeHHmm(afterCheckIn.timestamp);
  if (beforeCheckInTime !== afterCheckInTime) {
    changes.push({ field: 'checkInTime', from: beforeCheckInTime, to: afterCheckInTime });
  }

  const beforeStatus = statusCodeFromRecord(beforeCheckIn);
  const afterStatus = statusCodeFromRecord(afterCheckIn);
  if (beforeStatus !== afterStatus) {
    changes.push({ field: 'statusCode', from: beforeStatus, to: afterStatus });
  }

  if (beforeCheckIn.attendanceMode !== afterCheckIn.attendanceMode) {
    changes.push({
      field: 'attendanceMode',
      from: beforeCheckIn.attendanceMode,
      to: afterCheckIn.attendanceMode,
    });
  }

  const beforeNote = beforeCheckIn.lateNote ?? null;
  const afterNote = afterCheckIn.lateNote ?? null;
  if (beforeNote !== afterNote) {
    changes.push({ field: 'lateNote', from: beforeNote, to: afterNote });
  }

  if (beforeCheckIn.status !== afterCheckIn.status) {
    changes.push({ field: 'status', from: beforeCheckIn.status, to: afterCheckIn.status });
  }

  const beforeCheckOutTime = beforeCheckOut ? getISTTimeHHmm(beforeCheckOut.timestamp) : null;
  const afterCheckOutTime = afterCheckOut ? getISTTimeHHmm(afterCheckOut.timestamp) : null;
  if (beforeCheckOutTime !== afterCheckOutTime) {
    changes.push({
      field: 'checkOutTime',
      from: beforeCheckOutTime,
      to: afterCheckOutTime,
    });
  }

  return changes;
}

function appendAttendanceEditHistory(record, { actor, changes }) {
  const editedBy = serializeEditActor(actor);
  if (!editedBy) return;

  const editedAt = new Date();
  record.lastEditedAt = editedAt;
  record.lastEditedBy = editedBy;
  if (!Array.isArray(record.editHistory)) {
    record.editHistory = [];
  }
  record.editHistory.push({
    editedAt,
    editedBy,
    changes,
  });
}

function serializeAdminAttendanceListRecord(record) {
  const populatedUser = record.userId?._id != null ? record.userId : null;
  return {
    id: record._id.toString(),
    _id: record._id.toString(),
    userId: populatedUser
      ? {
        ...(populatedUser.toObject?.() ?? populatedUser),
        id: populatedUser._id.toString(),
      }
      : record.userId?.toString?.() ?? record.userId,
    type: record.type,
    timestamp: record.timestamp,
    attendanceMode: record.attendanceMode,
    attendanceTag: record.attendanceTag,
    warningIssued: record.warningIssued,
    quarterWarningIndex: record.quarterWarningIndex,
    lateNote: record.lateNote ?? null,
    status: record.status,
    rejectionReasons: record.rejectionReasons ?? [],
    latitude: record.latitude,
    longitude: record.longitude,
    ...serializeEditMetadata(record),
  };
}

/** Synthetic geo fields for admin-created attendance (no live device location). */
export function buildAdminSyntheticGeoFields(office) {
  return {
    latitude: office.latitude,
    longitude: office.longitude,
    accuracyMeters: 1,
    distanceMeters: 0,
    officeLatitude: office.latitude,
    officeLongitude: office.longitude,
    radiusMeters: office.radiusMeters,
  };
}

/**
 * Returns a block reason when admins must not create attendance for dayKey, else null.
 * Used by adminUpsertAttendanceForDay (create path only).
 */
export function getAdminAttendanceCreateDayBlockReason(dayKey, todayKey = getISTDateInputValue()) {
  if (!dayKey || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    return 'Invalid attendance day.';
  }
  if (dayKey > todayKey) {
    return 'Cannot create attendance for a future day.';
  }
  const istDay = parseDateInputAsISTDay(dayKey);
  if (!istDay) {
    return 'Invalid attendance day.';
  }
  if (isWeekendIST(istDay)) {
    return 'Cannot create attendance on a weekend.';
  }
  return null;
}

async function findCheckInForUserDay(userId, dayStart, dayEnd) {
  const allowed = await AttendanceRecord.findOne({
    userId,
    type: 'check_in',
    status: 'allowed',
    timestamp: { $gte: dayStart, $lte: dayEnd },
  }).sort({ timestamp: 1 });
  if (allowed) return allowed;

  return AttendanceRecord.findOne({
    userId,
    type: 'check_in',
    timestamp: { $gte: dayStart, $lte: dayEnd },
  }).sort({ timestamp: 1 });
}

function buildAdminCreateEditChanges({ checkInTime, checkOutTime, statusCode, attendanceMode, lateNote }) {
  const changes = [
    { field: 'checkInTime', from: null, to: checkInTime },
    { field: 'statusCode', from: null, to: statusCode },
    { field: 'attendanceMode', from: null, to: attendanceMode },
  ];
  if (lateNote != null) {
    changes.push({ field: 'lateNote', from: null, to: lateNote });
  }
  if (checkOutTime) {
    changes.push({ field: 'checkOutTime', from: null, to: checkOutTime });
  }
  return changes;
}

export async function adminEditAttendanceRecord({
  recordId,
  payload,
  actor,
  permissions,
  auditContext = {},
}) {
  if (!mongoose.isValidObjectId(recordId)) {
    throwError('Attendance record not found.', 404);
  }

  const checkInRecord = await AttendanceRecord.findById(recordId);
  if (!checkInRecord || checkInRecord.type !== 'check_in') {
    throwError('Attendance record not found.', 404);
  }

  const allowed = await isUserInTeamScope(
    actor,
    permissions,
    checkInRecord.userId,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );
  if (!allowed) {
    throwError('You do not have permission to edit this attendance record.', 403);
  }

  const dayKey = getISTDateInputValue(checkInRecord.timestamp);
  const istDay = parseDateInputAsISTDay(dayKey);
  if (!istDay) {
    throwError('Invalid attendance day on record.');
  }

  const dayStart = startOfDayIST(istDay);
  const dayEnd = endOfDayIST(istDay);
  const newCheckInTs = buildISTTimestampFromDayAndTime(dayKey, payload.checkInTime);
  if (!newCheckInTs) {
    throwError('Invalid check-in time.');
  }
  if (newCheckInTs < dayStart || newCheckInTs > dayEnd) {
    throwError('Check-in time must fall within the attendance day (IST).');
  }

  const policyFields = parseStatusCodeToPolicyFields(payload.statusCode);
  const beforeCheckIn = snapshotAttendanceRecord(checkInRecord);

  checkInRecord.timestamp = newCheckInTs;
  checkInRecord.attendanceMode = payload.attendanceMode;
  checkInRecord.attendanceTag = policyFields.attendanceTag;
  checkInRecord.warningIssued = policyFields.warningIssued;
  checkInRecord.quarterWarningIndex = policyFields.quarterWarningIndex;
  checkInRecord.lateNote = payload.lateNote ?? null;
  if (checkInRecord.status === 'rejected') {
    checkInRecord.status = 'allowed';
    checkInRecord.rejectionReasons = [];
  }

  let checkOutRecord = null;
  let beforeCheckOut = null;
  if (payload.checkOutTime !== undefined) {
    checkOutRecord = await AttendanceRecord.findOne({
      userId: checkInRecord.userId,
      type: 'check_out',
      status: 'allowed',
      timestamp: { $gte: dayStart, $lte: dayEnd },
    }).sort({ timestamp: 1 });

    if (payload.checkOutTime) {
      const newCheckOutTs = buildISTTimestampFromDayAndTime(dayKey, payload.checkOutTime);
      if (!newCheckOutTs) {
        throwError('Invalid check-out time.');
      }
      if (newCheckOutTs <= newCheckInTs) {
        throwError('Check-out time must be after check-in time.');
      }
      if (newCheckOutTs > dayEnd) {
        throwError('Check-out time must fall within the attendance day (IST).');
      }

      if (checkOutRecord) {
        beforeCheckOut = snapshotAttendanceRecord(checkOutRecord);
        checkOutRecord.timestamp = newCheckOutTs;
        checkOutRecord.attendanceMode = payload.attendanceMode;
        await checkOutRecord.save();
      } else {
        const office = await getOfficeSettings();
        checkOutRecord = await AttendanceRecord.create({
          userId: checkInRecord.userId,
          type: 'check_out',
          attendanceMode: payload.attendanceMode,
          timestamp: newCheckOutTs,
          status: 'allowed',
          rejectionReasons: [],
          ...buildAdminSyntheticGeoFields(office),
        });
      }
    }
  }

  const afterCheckIn = snapshotAttendanceRecord(checkInRecord);
  const afterCheckOut = snapshotAttendanceRecord(checkOutRecord);
  const changes = buildAttendanceEditChanges({
    beforeCheckIn,
    afterCheckIn,
    beforeCheckOut,
    afterCheckOut,
  });
  appendAttendanceEditHistory(checkInRecord, { actor, changes });
  await checkInRecord.save();

  auditLog('attendance_admin_edit', {
    adminId: actor._id.toString(),
    email: auditContext.email,
    recordId: recordId.toString(),
    userId: checkInRecord.userId.toString(),
    dayKey,
    before: { checkIn: beforeCheckIn, checkOut: beforeCheckOut },
    after: {
      checkIn: afterCheckIn,
      checkOut: afterCheckOut,
    },
    changes,
    ip: auditContext.ip,
    userAgent: auditContext.userAgent,
  });

  return {
    checkIn: checkInRecord,
    checkOut: checkOutRecord,
    dayKey,
    checkInTime: getISTTimeHHmm(checkInRecord.timestamp),
    checkOutTime: checkOutRecord ? getISTTimeHHmm(checkOutRecord.timestamp) : null,
  };
}

/**
 * Create attendance for a user/day when no check-in exists, or update the existing check-in.
 * Same RBAC scope as adminEditAttendanceRecord.
 */
export async function adminUpsertAttendanceForDay({
  userId,
  dayKey,
  payload,
  actor,
  permissions,
  auditContext = {},
}) {
  if (!mongoose.isValidObjectId(userId)) {
    throwError('Employee not found.', 404);
  }

  const allowed = await isUserInTeamScope(
    actor,
    permissions,
    userId,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
  );
  if (!allowed) {
    throwError('You do not have permission to edit this attendance record.', 403);
  }

  const employee = await User.findById(userId).select('_id isActive');
  if (!employee?.isActive) {
    throwError('Employee not found.', 404);
  }

  const istDay = parseDateInputAsISTDay(dayKey);
  if (!istDay) {
    throwError('Invalid attendance day.');
  }

  const dayStart = startOfDayIST(istDay);
  const dayEnd = endOfDayIST(istDay);
  const existingCheckIn = await findCheckInForUserDay(userId, dayStart, dayEnd);
  if (existingCheckIn) {
    return adminEditAttendanceRecord({
      recordId: existingCheckIn._id.toString(),
      payload,
      actor,
      permissions,
      auditContext,
    });
  }

  const blockReason = getAdminAttendanceCreateDayBlockReason(dayKey);
  if (blockReason) {
    throwError(blockReason);
  }

  const newCheckInTs = buildISTTimestampFromDayAndTime(dayKey, payload.checkInTime);
  if (!newCheckInTs) {
    throwError('Invalid check-in time.');
  }
  if (newCheckInTs < dayStart || newCheckInTs > dayEnd) {
    throwError('Check-in time must fall within the attendance day (IST).');
  }

  let newCheckOutTs = null;
  if (payload.checkOutTime) {
    newCheckOutTs = buildISTTimestampFromDayAndTime(dayKey, payload.checkOutTime);
    if (!newCheckOutTs) {
      throwError('Invalid check-out time.');
    }
    if (newCheckOutTs <= newCheckInTs) {
      throwError('Check-out time must be after check-in time.');
    }
    if (newCheckOutTs > dayEnd) {
      throwError('Check-out time must fall within the attendance day (IST).');
    }
  }

  const policyFields = parseStatusCodeToPolicyFields(payload.statusCode);
  const office = await getOfficeSettings();
  const geoFields = buildAdminSyntheticGeoFields(office);

  const checkInRecord = await AttendanceRecord.create({
    userId,
    type: 'check_in',
    attendanceMode: payload.attendanceMode,
    timestamp: newCheckInTs,
    status: 'allowed',
    rejectionReasons: [],
    lateNote: payload.lateNote ?? null,
    ...policyFields,
    ...geoFields,
  });

  let checkOutRecord = null;
  if (newCheckOutTs) {
    checkOutRecord = await AttendanceRecord.create({
      userId,
      type: 'check_out',
      attendanceMode: payload.attendanceMode,
      timestamp: newCheckOutTs,
      status: 'allowed',
      rejectionReasons: [],
      ...geoFields,
    });
  }

  const checkInTime = getISTTimeHHmm(checkInRecord.timestamp);
  const checkOutTime = checkOutRecord ? getISTTimeHHmm(checkOutRecord.timestamp) : null;
  const changes = buildAdminCreateEditChanges({
    checkInTime,
    checkOutTime,
    statusCode: payload.statusCode,
    attendanceMode: payload.attendanceMode,
    lateNote: payload.lateNote ?? null,
  });
  appendAttendanceEditHistory(checkInRecord, { actor, changes });
  await checkInRecord.save();

  auditLog('attendance_admin_create', {
    adminId: actor._id.toString(),
    email: auditContext.email,
    recordId: checkInRecord._id.toString(),
    userId: userId.toString(),
    dayKey,
    after: {
      checkIn: snapshotAttendanceRecord(checkInRecord),
      checkOut: snapshotAttendanceRecord(checkOutRecord),
    },
    changes,
    ip: auditContext.ip,
    userAgent: auditContext.userAgent,
  });

  return {
    checkIn: checkInRecord,
    checkOut: checkOutRecord,
    dayKey,
    checkInTime,
    checkOutTime,
    created: true,
  };
}


export async function undoAttendance(
  actionId,
  userId,
  auditContext = {},
) {
  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      // 1. Find active UndoAction
      const undoAction = await UndoAction.findOne({
        _id: actionId,
        actorId: userId,
        status: 'active',
      }).session(session);

      if (!undoAction) {
        throw new Error('Undo action is invalid or already used');
      }

      if (Date.now() - new Date(undoAction.createdAt).getTime() > UNDO_WINDOW_MS) {
        undoAction.status = 'expired';
        await undoAction.save({ session });
        throw new Error('Undo is only available within 5 minutes of the action.');
      }

      // 2. Find the target attendance
      const attendanceRecord = await AttendanceRecord.findOne({
        _id: undoAction.targetId,
        userId,
      }).session(session);

      if (!attendanceRecord) {
        throw new Error('Attendance record not found');
      }

      // 3. Find LAST attendance
      const lastAttendance = await AttendanceRecord.findOne({
        userId,
      })
        .sort({ timestamp: -1 })
        .session(session);

      // 4. Only last action can be undone
      if (
        !lastAttendance ||
        String(lastAttendance._id) !==
          String(attendanceRecord._id)
      ) {
        throw new Error(
          'Only the last attendance action can be undone',
        );
      }

      // 5. Audit BEFORE deleting
      auditLog('attendance_undo', {
        userId: userId.toString(),
        email: auditContext.email,
        type: attendanceRecord.type,
        attendanceMode: attendanceRecord.attendanceMode,
        status: 'undone',
        recordId: attendanceRecord._id.toString(),
        actionId: undoAction._id.toString(),
        distanceMeters: attendanceRecord.distanceMeters,
        accuracyMeters: attendanceRecord.accuracyMeters,
        deviceId: auditContext.deviceId,
        ip: auditContext.ip,
        userAgent: auditContext.userAgent,
      });

      // 6. Delete ONLY last attendance
      await AttendanceRecord.deleteOne(
        {
          _id: attendanceRecord._id,
          userId,
        },
        { session },
      );

      // 7. Make UndoAction unusable
      undoAction.status = 'undone';
      undoAction.undoneAt = new Date();

      await undoAction.save({ session });

      result = {
        actionId: undoAction._id,
        type: attendanceRecord.type,
        status: 'undone',
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}
