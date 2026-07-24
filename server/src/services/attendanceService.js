import mongoose from 'mongoose';
import { PERMISSIONS, hasPermission } from '../../../shared/permissions.js';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { User } from '../models/User.js';
import { evaluateGeoAttendance, getOfficeSettings } from './geoService.js';
import { getHolidayDateSet } from './leaveService.js';
import {
  endOfDayIST,
  formatISTDateTime,
  getISTDateInputValue,
  isWeekendIST,
  listWorkingDaysIST,
  parseDateInputAsISTDay,
  parseMonthInputAsISTRange,
  startOfDayIST,
} from '../utils/istDate.js';
import { auditLog } from '../utils/auditLog.js';

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

function buildTodayStatus(records, office) {
  const checkIn = records.find((record) => record.type === 'check_in') ?? null;
  const checkOut = records.find((record) => record.type === 'check_out') ?? null;

  return {
    checkIn,
    checkOut,
    canCheckIn: !checkIn,
    canCheckOut: Boolean(checkIn) && !checkOut,
    istDate: getISTDateInputValue(),
    currentIST: formatISTDateTime(new Date()),
    office: {
      name: office.name,
      latitude: office.latitude,
      longitude: office.longitude,
      radiusMeters: office.radiusMeters,
      maxAccuracyMeters: office.maxAccuracyMeters,
    },
  };
}

export async function getTodayStatus(userId) {
  const [records, office] = await Promise.all([
    getTodayRecords(userId),
    getOfficeSettings(),
  ]);
  return buildTodayStatus(records, office);
}

export async function markAttendance(userId, type, payload) {
  const session = await mongoose.startSession();

  try {
    let result;
    await session.withTransaction(async () => {
      const office = await getOfficeSettings();
      const geo = evaluateGeoAttendance({ ...payload, office });
      const records = await getTodayRecords(userId, session);
      const today = buildTodayStatus(records, office);

      const businessReasons = [];
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

      const [record] = await AttendanceRecord.create(
        [
          {
            userId,
            type,
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
          },
        ],
        { session },
      );

      auditLog('attendance_marked', {
        userId: userId.toString(),
        type,
        status,
        distanceMeters: geo.distanceMeters,
        accuracyMeters: payload.accuracyMeters,
      });

      result = { record, office, status, rejectionReasons };
    });

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

export async function getAdminAttendance({ userId, date, page = 1, limit = 20, actor, permissions }) {
  const query = {};
  if (userId) {
    query.userId = userId;
  }

  const canReadAll = hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_ALL);
  const canReadTeam = hasPermission(permissions, PERMISSIONS.ATTENDANCE_READ_TEAM);
  const canReadUsers = hasPermission(permissions, PERMISSIONS.USERS_READ);

  if (!canReadAll && canReadTeam && !canReadUsers && actor?._id) {
    const directReports = await User.find({
      reportingManagerId: actor._id,
      isActive: true,
    }).select('_id');
    const reportIds = directReports.map((item) => item._id);

    if (userId && !reportIds.some((id) => id.toString() === userId.toString())) {
      return {
        records: [],
        pagination: { page, limit, total: 0, totalPages: 1 },
      };
    }

    if (!userId) {
      query.userId = { $in: reportIds };
    }
  }

  if (date) {
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
    records,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

async function loadPresentDaySet(userId, monthStart, monthEnd) {
  const records = await AttendanceRecord.find({
    userId,
    type: 'check_in',
    status: 'allowed',
    timestamp: { $gte: monthStart, $lte: monthEnd },
  }).select('timestamp');

  return new Set(records.map((record) => getISTDateInputValue(record.timestamp)));
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
  const holidayDates = await getHolidayDateSet(year);
  const todayKey = getISTDateInputValue();

  const [presentDaySet, leaveDaySet] = await Promise.all([
    loadPresentDaySet(userId, start, end),
    loadApprovedLeaveDaySet(userId, start, end, holidayDates),
  ]);

  const days = {};
  for (let dayNum = 1; dayNum <= daysInMonth; dayNum += 1) {
    const dayKey = `${monthKey}-${String(dayNum).padStart(2, '0')}`;
    const dayDate = parseDateInputAsISTDay(dayKey);

    if (isWeekendIST(dayDate)) {
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
    if (presentDaySet.has(dayKey)) {
      days[dayKey] = 'present';
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
    const directReports = await User.find({
      reportingManagerId: actor._id,
      isActive: true,
    }).select('_id');
    const allowed = directReports.some((item) => item._id.toString() === requestedUserId);
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
