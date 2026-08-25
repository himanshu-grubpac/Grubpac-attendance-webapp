import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { getOfficeSettings } from '../services/geoService.js';
import { buildAdminSyntheticGeoFields } from '../services/attendanceService.js';
import { auditLog } from '../utils/auditLog.js';
import {
  buildISTTimestampFromDayAndTime,
  getISTDateInputValue,
  parseDateInputAsISTDay,
  startOfDayIST,
  endOfDayIST,
} from '../utils/istDate.js';

const DEFAULT_OFFICE_TIME = '23:59';
const DEFAULT_WFH_TIME = '06:00';
const SCAN_WINDOW_DAYS = 3;

let running = false;
let schedulerTimer = null;

function nextISTDayKey(dayKey) {
  const day = parseDateInputAsISTDay(dayKey);
  if (!day) return null;
  const next = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  return getISTDateInputValue(next);
}

export function computeAutoCheckoutDeadline(attendanceMode, dayKey, officeTime, wfhTime) {
  if (attendanceMode === 'wfh') {
    const nextKey = nextISTDayKey(dayKey);
    if (!nextKey) return null;
    return buildISTTimestampFromDayAndTime(nextKey, wfhTime ?? DEFAULT_WFH_TIME);
  }
  return buildISTTimestampFromDayAndTime(dayKey, officeTime ?? DEFAULT_OFFICE_TIME);
}

export async function runAutoCheckoutJob(now = new Date()) {
  if (running) {
    return { skipped: true, reason: 'already_running' };
  }
  running = true;
  try {
    const office = await getOfficeSettings();
    const autoCheckout = (office && office.autoCheckout) || {};
    const enabled = autoCheckout.enabled ?? true;
    if (!enabled) {
      return { processed: 0, skipped: true, reason: 'disabled' };
    }
    const officeTime = autoCheckout.officeTime ?? DEFAULT_OFFICE_TIME;
    const wfhTime = autoCheckout.wfhTime ?? DEFAULT_WFH_TIME;

    const scanStart = startOfDayIST(new Date(now.getTime() - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000));
    const scanEnd = endOfDayIST(now);

    const checkIns = await AttendanceRecord.find({
      type: 'check_in',
      status: 'allowed',
      timestamp: { $gte: scanStart, $lte: scanEnd },
    })
      .select('userId timestamp attendanceMode')
      .lean();

    if (checkIns.length === 0) {
      return { processed: 0, runAt: now.toISOString() };
    }

    const userIds = [...new Set(checkIns.map((c) => c.userId.toString()))];
    const checkOuts = await AttendanceRecord.find({
      type: 'check_out',
      status: 'allowed',
      userId: { $in: userIds },
      timestamp: { $gte: scanStart, $lte: scanEnd },
    })
      .select('userId timestamp attendanceMode')
      .lean();

    const checkedOutKeys = new Set(
      checkOuts.map((o) => o.userId.toString() + '|' + getISTDateInputValue(o.timestamp) + '|' + o.attendanceMode),
    );

    const pending = [];
    const seenKeys = new Set();
    for (const checkIn of checkIns) {
      const dayKey = getISTDateInputValue(checkIn.timestamp);
      const key = checkIn.userId.toString() + '|' + dayKey + '|' + checkIn.attendanceMode;
      if (checkedOutKeys.has(key) || seenKeys.has(key)) continue;
      seenKeys.add(key);
      const mode = checkIn.attendanceMode === 'wfh' ? 'wfh' : 'office';
      const deadline = computeAutoCheckoutDeadline(mode, dayKey, officeTime, wfhTime);
      if (!deadline) continue;
      if (now >= deadline) {
        pending.push({ checkIn, mode, deadline });
      }
    }

    const checkedOut = [];
    for (const item of pending) {
      const record = await AttendanceRecord.create({
        userId: item.checkIn.userId,
        type: 'check_out',
        attendanceMode: item.mode,
        timestamp: item.deadline,
        status: 'allowed',
        rejectionReasons: [],
        autoCheckout: true,
        ...buildAdminSyntheticGeoFields(office),
      });
      auditLog('attendance_auto_checkout', {
        userId: item.checkIn.userId.toString(),
        attendanceMode: item.mode,
        checkInAt: item.checkIn.timestamp,
        autoCheckoutAt: item.deadline,
        recordId: record._id.toString(),
      });
      checkedOut.push(record._id.toString());
    }

    return { processed: checkedOut.length, checkedOut, runAt: now.toISOString() };
  } finally {
    running = false;
  }
}

export function startAutoCheckoutScheduler(intervalMs = 60 * 1000) {
  if (process.env.NODE_ENV === 'test') return null;
  if (schedulerTimer) return schedulerTimer;
  schedulerTimer = setInterval(() => {
    runAutoCheckoutJob().catch((err) => {
      console.error('[autoCheckout] job failed:', (err && err.message) ? err.message : err);
    });
  }, intervalMs);
  if (schedulerTimer.unref) schedulerTimer.unref();
  const initial = setTimeout(() => {
    runAutoCheckoutJob().catch((err) => {
      console.error('[autoCheckout] initial run failed:', (err && err.message) ? err.message : err);
    });
  }, 5000);
  if (initial.unref) initial.unref();
  return schedulerTimer;
}

export function stopAutoCheckoutScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}