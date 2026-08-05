import mongoose from 'mongoose';
import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveRequest, LEAVE_REQUEST_POPULATE } from '../models/LeaveRequest.js';
import { User } from '../models/User.js';
import { evaluateGeoAttendance, getOfficeSettings } from './geoService.js';
import {
  evaluateCheckInPolicy,
  getQuarterWarningSummaryForUsers,
  parseStatusCodeToPolicyFields,
  statusCodeFromRecord,
} from './attendancePolicyService.js';
import { getHolidayDateSet } from './leaveService.js';
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
  validateWfhCheckInMode,
} from './wfhPolicyService.js';

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

function buildTodayStatus(records, office, pendingLeaveToday = null, wfhApprovedToday = false) {
  const checkIn = records.find((record) => record.type === 'check_in') ?? null;
  const checkOut = records.find((record) => record.type === 'check_out') ?? null;

  return {
    checkIn,
    checkOut,
    canCheckIn: !checkIn,
    canCheckOut: Boolean(checkIn) && !checkOut,
    pendingLeaveToday,
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

export async function getTodayStatus(userId) {
  const istToday = getISTDateInputValue();
  const [records, office, pendingLeaveToday, wfhApprovedToday] = await Promise.all([
    getTodayRecords(userId),
    getOfficeSettings(),
    loadPendingLeaveForToday(userId),
    hasApprovedWfhForIstDate(userId, istToday),
  ]);
  return buildTodayStatus(records, office, pendingLeaveToday, wfhApprovedToday);
}

export async function markAttendance(userId, type, payload, auditContext = {}) {
  const session = await mongoose.startSession();

  try {
    let result;
    await session.withTransaction(async () => {
      const office = await getOfficeSettings();
      const records = await getTodayRecords(userId, session);
      const today = buildTodayStatus(records, office);
      const existingCheckIn = records.find((record) => record.type === 'check_in') ?? null;
      const attendanceMode = type === 'check_out' && existingCheckIn
        ? existingCheckIn.attendanceMode ?? 'office'
        : payload.attendanceMode;
      const geo = evaluateGeoAttendance({
        ...payload,
        office,
        enforceOfficeRadius: attendanceMode === 'office',
      });

      const businessReasons = [];
      if (type === 'check_in' && attendanceMode === 'wfh') {
        const wfhApprovedToday = await hasApprovedWfhForIstDate(userId, getISTDateInputValue());
        const wfhCheckInError = validateWfhCheckInMode(attendanceMode, wfhApprovedToday);
        if (wfhCheckInError) {
          businessReasons.push(wfhCheckInError);
        }
      }
      if (type === 'check_in' && !today.canCheckIn) {
        businessReasons.push('You have already checked in today.');
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

async function loadApprovedLeaveDaySet(userId, monthStart, monthEnd, holidayDates) {
  const requests = await LeaveRequest.find({
    userId,
    status: 'approved',
    startDate: { $lte: monthEnd },
    endDate: { $gte: monthStart },
  }).select('startDate endDate');

  const leaveDays = new Set();
  for (const request of requests) {
    const overlapStart = request.startDate > monthStart ? request.startDate : monthStart;
    const overlapEnd = request.endDate < monthEnd ? request.endDate : monthEnd;
    if (overlapEnd < overlapStart) {
      continue;
    }
    for (const dayKey of listWorkingDaysIST(overlapStart, overlapEnd, holidayDates)) {
      leaveDays.add(dayKey);
    }
  }
  return leaveDays;
}

/**
 * Per-day attendance status for a calendar month (IST).
 * v1 scope: employee own data via /attendance/month-summary; admins may pass userId when
 * ATTENDANCE_READ_ALL or ATTENDANCE_READ_TEAM (direct reports only) allows it.
 */
export async function getMonthDayStatusSummary(userId, monthInput) {
  const range = parseMonthInputAsISTRange(monthInput);
  if (!range) {
    throwError('Invalid month. Use YYYY-MM.');
  }

  const { year, monthKey, start, end, daysInMonth } = range;
  const office = await getOfficeSettings();
  const weekendDays = office?.weekendDays ?? [0, 6];
  const holidayDates = await getHolidayDateSet(year);
  const todayKey = getISTDateInputValue();

  const [checkInDayStatusMap, leaveDaySet] = await Promise.all([
    loadCheckInDayStatusMap(userId, start, end),
    loadApprovedLeaveDaySet(userId, start, end, holidayDates),
  ]);

  const days = {};
  for (let dayNum = 1; dayNum <= daysInMonth; dayNum += 1) {
    const dayKey = `${monthKey}-${String(dayNum).padStart(2, '0')}`;
    const dayDate = parseDateInputAsISTDay(dayKey);

    if (isWeekendIST(dayDate, weekendDays)) {
      days[dayKey] = 'weekend';
      continue;
    }
    if (holidayDates.has(dayKey)) {
      days[dayKey] = 'holiday';
      continue;
    }
    if (dayKey > todayKey) {
      days[dayKey] = 'future';
      continue;
    }
    if (checkInDayStatusMap.has(dayKey)) {
      days[dayKey] = checkInDayStatusMap.get(dayKey);
      continue;
    }
    if (leaveDaySet.has(dayKey)) {
      days[dayKey] = 'leave';
      continue;
    }
    if (dayKey < todayKey) {
      days[dayKey] = 'absent';
      continue;
    }
    days[dayKey] = 'none';
  }

  return {
    year,
    month: monthKey,
    today: todayKey,
    days,
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
