import mongoose from 'mongoose';
import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { getOfficeSettings } from './geoService.js';
import {
  endOfDayIST,
  getISTMonth,
  getISTYear,
  IST_TIMEZONE,
  isWeekendIST,
  startOfDayIST,
} from '../utils/istDate.js';

const DEFAULT_OFFICE_START = '09:00';
const DEFAULT_OFFICE_END = '17:00';
const DEFAULT_GRACE = '09:00';
const DEFAULT_HALF_DAY = '10:00';
const DEFAULT_WARNINGS_PER_QUARTER = 3;

export const DEFAULT_ATTENDANCE_POLICY = {
  officeStartTime: DEFAULT_OFFICE_START,
  officeEndTime: DEFAULT_OFFICE_END,
  graceThresholdTime: DEFAULT_GRACE,
  halfDayThresholdTime: DEFAULT_HALF_DAY,
  warningsPerQuarter: DEFAULT_WARNINGS_PER_QUARTER,
};

export function parseTimeStringToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

export function getCheckInMinutesIST(timestamp) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

export function getCalendarQuarterInfo(referenceDate = new Date()) {
  const year = getISTYear(referenceDate);
  const month = getISTMonth(referenceDate);
  const quarter = Math.ceil(month / 3);
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  const startKey = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  const endKey = `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return {
    year,
    quarter,
    label: `${year}-Q${quarter}`,
    start: startOfDayIST(new Date(`${startKey}T12:00:00+05:30`)),
    end: endOfDayIST(new Date(`${endKey}T12:00:00+05:30`)),
  };
}

export function resolveAttendancePolicy(office) {
  return {
    officeStartTime: office?.officeStartTime ?? DEFAULT_OFFICE_START,
    officeEndTime: office?.officeEndTime ?? DEFAULT_OFFICE_END,
    graceThresholdTime: office?.graceThresholdTime ?? DEFAULT_GRACE,
    halfDayThresholdTime: office?.halfDayThresholdTime ?? DEFAULT_HALF_DAY,
    warningsPerQuarter: office?.warningsPerQuarter ?? DEFAULT_WARNINGS_PER_QUARTER,
  };
}

export async function countQuarterWarningsUsed(userId, referenceDate = new Date(), session = null) {
  const { start, end } = getCalendarQuarterInfo(referenceDate);
  const query = AttendanceRecord.countDocuments({
    userId,
    type: 'check_in',
    status: 'allowed',
    warningIssued: true,
    timestamp: { $gte: start, $lte: end },
  });
  if (session) query.session(session);
  return query;
}

export async function evaluateCheckInPolicy(userId, timestamp, office, session = null) {
  const policy = resolveAttendancePolicy(office);
  const graceMinutes = parseTimeStringToMinutes(policy.graceThresholdTime);
  const halfDayMinutes = parseTimeStringToMinutes(policy.halfDayThresholdTime);

  if (isWeekendIST(timestamp, office?.weekendDays ?? [0, 6])) {
    return {
      attendanceTag: 'P',
      warningIssued: false,
      quarterWarningIndex: null,
    };
  }

  const checkInMinutes = getCheckInMinutesIST(timestamp);

  if (graceMinutes == null || halfDayMinutes == null) {
    return {
      attendanceTag: 'P',
      warningIssued: false,
      quarterWarningIndex: null,
    };
  }

  if (checkInMinutes <= graceMinutes) {
    return {
      attendanceTag: 'P',
      warningIssued: false,
      quarterWarningIndex: null,
    };
  }

  if (checkInMinutes >= halfDayMinutes) {
    return {
      attendanceTag: 'HD',
      warningIssued: false,
      quarterWarningIndex: null,
    };
  }

  const allowance = policy.warningsPerQuarter;
  const used = await countQuarterWarningsUsed(userId, timestamp, session);
  const remaining = allowance - used;

  if (remaining > 0) {
    return {
      attendanceTag: 'P',
      warningIssued: true,
      quarterWarningIndex: used + 1,
    };
  }

  return {
    attendanceTag: 'LV',
    warningIssued: false,
    quarterWarningIndex: null,
  };
}

export async function getQuarterWarningSummaryForUsers(userIds, referenceDate = new Date()) {
  if (!userIds?.length) {
    return { quarter: getCalendarQuarterInfo(referenceDate), allowance: DEFAULT_WARNINGS_PER_QUARTER, byUser: {} };
  }

  const office = await getOfficeSettings();
  const policy = resolveAttendancePolicy(office);
  const quarterInfo = getCalendarQuarterInfo(referenceDate);
  const objectIds = userIds.map((id) => new mongoose.Types.ObjectId(String(id)));

  const rows = await AttendanceRecord.aggregate([
    {
      $match: {
        userId: { $in: objectIds },
        type: 'check_in',
        status: 'allowed',
        warningIssued: true,
        timestamp: { $gte: quarterInfo.start, $lte: quarterInfo.end },
      },
    },
    { $group: { _id: '$userId', used: { $sum: 1 } } },
  ]);

  const byUser = {};
  for (const userId of userIds) {
    byUser[String(userId)] = {
      used: 0,
      allowance: policy.warningsPerQuarter,
      remaining: policy.warningsPerQuarter,
    };
  }
  for (const row of rows) {
    const key = row._id.toString();
    byUser[key] = {
      used: row.used,
      allowance: policy.warningsPerQuarter,
      remaining: Math.max(0, policy.warningsPerQuarter - row.used),
    };
  }

  return {
    quarter: quarterInfo,
    allowance: policy.warningsPerQuarter,
    byUser,
  };
}

export function parseStatusCodeToPolicyFields(statusCode) {
  if (statusCode === 'P' || statusCode === 'HD' || statusCode === 'LV') {
    return {
      attendanceTag: statusCode,
      warningIssued: false,
      quarterWarningIndex: null,
    };
  }

  const warningMatch = /^W(\d+)$/.exec(statusCode);
  if (warningMatch) {
    const index = Number(warningMatch[1]);
    if (index >= 1 && index <= 10) {
      return {
        attendanceTag: 'P',
        warningIssued: true,
        quarterWarningIndex: index,
      };
    }
  }

  const error = new Error('Invalid attendance status code.');
  error.statusCode = 400;
  throw error;
}

export function statusCodeFromRecord(record) {
  if (record?.warningIssued && record?.quarterWarningIndex) {
    return `W${record.quarterWarningIndex}`;
  }
  return record?.attendanceTag ?? 'P';
}

/**
 * True when an LV tag was produced by evaluateCheckInPolicy after quarterly warnings
 * were exhausted (late check-in between grace and half-day). Does not match HD/P or
 * weekend check-ins. Admin-set LV outside that window is left alone.
 */
export function isExhaustionRelatedLv(timestamp, policy, weekendDays = [0, 6]) {
  if (!timestamp || !policy) return false;
  if (isWeekendIST(timestamp, weekendDays)) return false;
  const graceMinutes = parseTimeStringToMinutes(policy.graceThresholdTime);
  const halfDayMinutes = parseTimeStringToMinutes(policy.halfDayThresholdTime);
  if (graceMinutes == null || halfDayMinutes == null) return false;
  const checkInMinutes = getCheckInMinutesIST(timestamp);
  return checkInMinutes > graceMinutes && checkInMinutes < halfDayMinutes;
}

/**
 * Clear current-IST-quarter warning streaks for the given users.
 * - Sets warningIssued=false and quarterWarningIndex=null on warning check-ins.
 * - Reclassifies exhaustion-related LV (late window) to P; leaves HD and other LV alone.
 */
export async function resetQuarterWarningsForUsers(userIds, referenceDate = new Date()) {
  const quarterInfo = getCalendarQuarterInfo(referenceDate);
  const uniqueIds = [...new Set((userIds ?? []).map((id) => String(id)).filter(Boolean))];

  if (!uniqueIds.length) {
    return {
      quarter: quarterInfo,
      clearedWarnings: 0,
      reclassifiedLv: 0,
      userIds: [],
    };
  }

  const objectIds = uniqueIds.map((id) => new mongoose.Types.ObjectId(id));
  const office = await getOfficeSettings();
  const policy = resolveAttendancePolicy(office);
  const weekendDays = office?.weekendDays ?? [0, 6];

  const baseMatch = {
    userId: { $in: objectIds },
    type: 'check_in',
    status: 'allowed',
    timestamp: { $gte: quarterInfo.start, $lte: quarterInfo.end },
  };

  const warningResult = await AttendanceRecord.updateMany(
    { ...baseMatch, warningIssued: true },
    { $set: { warningIssued: false, quarterWarningIndex: null } },
  );

  const lvRecords = await AttendanceRecord.find({
    ...baseMatch,
    attendanceTag: 'LV',
  })
    .select('_id timestamp')
    .lean();

  const lvIdsToPresent = lvRecords
    .filter((record) => isExhaustionRelatedLv(record.timestamp, policy, weekendDays))
    .map((record) => record._id);

  let reclassifiedLv = 0;
  if (lvIdsToPresent.length) {
    const lvResult = await AttendanceRecord.updateMany(
      { _id: { $in: lvIdsToPresent } },
      {
        $set: {
          attendanceTag: 'P',
          warningIssued: false,
          quarterWarningIndex: null,
        },
      },
    );
    reclassifiedLv = lvResult.modifiedCount ?? 0;
  }

  return {
    quarter: quarterInfo,
    clearedWarnings: warningResult.modifiedCount ?? 0,
    reclassifiedLv,
    userIds: uniqueIds,
  };
}

/** Client-side fallback when legacy records lack stored policy tags. */
export function derivePolicyFromSettings(checkInTimestamp, policy, warningsUsedBefore = 0) {
  const graceMinutes = parseTimeStringToMinutes(policy.graceThresholdTime);
  const halfDayMinutes = parseTimeStringToMinutes(policy.halfDayThresholdTime);
  const checkInMinutes = getCheckInMinutesIST(checkInTimestamp);
  const allowance = policy.warningsPerQuarter ?? DEFAULT_WARNINGS_PER_QUARTER;

  if (checkInMinutes <= graceMinutes) {
    return { statusTag: 'P', warningTag: null };
  }
  if (checkInMinutes >= halfDayMinutes) {
    return { statusTag: 'HD', warningTag: null };
  }
  const remaining = allowance - warningsUsedBefore;
  if (remaining > 0) {
    return { statusTag: 'P', warningTag: `W${warningsUsedBefore + 1}` };
  }
  return { statusTag: 'LV', warningTag: null };
}
