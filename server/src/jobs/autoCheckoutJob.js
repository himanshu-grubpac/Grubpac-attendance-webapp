import { AttendanceRecord } from '../models/AttendanceRecord.js';
import { getOfficeSettings } from '../services/geoService.js';
import { buildAdminSyntheticGeoFields } from '../utils/geoFields.js';
import { auditLogSync } from '../utils/auditLog.js';
import { logError } from '../utils/logger.js';
import { acquireJobLock, releaseJobLock } from '../utils/jobLock.js';
import {
  buildISTTimestampFromDayAndTime,
  getISTDateInputValue,
  parseDateInputAsISTDay,
  endOfDayIST,
} from '../utils/istDate.js';

const DEFAULT_OFFICE_TIME = '23:59';
const DEFAULT_WFH_TIME = '06:00';
let schedulerTimer = null;

function nextISTDayKey(dayKey) {
  const day = parseDateInputAsISTDay(dayKey);
  if (!day) return null;
  const next = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  return getISTDateInputValue(next);
}

export function computeAutoCheckoutDeadline(attendanceMode, dayKey, cfg) {
  const config = cfg || {};
  const day = config.day ?? (attendanceMode === 'wfh' ? 'next' : 'same');
  const time = config.time ?? (attendanceMode === 'wfh' ? DEFAULT_WFH_TIME : DEFAULT_OFFICE_TIME);
  if (day === 'next') {
    const nextKey = nextISTDayKey(dayKey);
    if (!nextKey) return null;
    return buildISTTimestampFromDayAndTime(nextKey, time);
  }
  return buildISTTimestampFromDayAndTime(dayKey, time);
}

export async function runAutoCheckoutJob(now = new Date()) {
  const lock = await acquireJobLock('auto-checkout', { ttlMs: 240_000 });
  if (!lock.acquired) {
    return { skipped: true, reason: lock.reason };
  }
  try {
    const office = await getOfficeSettings();
    const autoCheckout = (office && office.autoCheckout) || {};
    const enabled = autoCheckout.enabled ?? true;
    if (!enabled) {
      return { processed: 0, skipped: true, reason: 'disabled' };
    }
    const officeCfg = autoCheckout.office;
    const wfhCfg = autoCheckout.wfh;

    const scanEnd = endOfDayIST(now);

    const checkIns = await AttendanceRecord.find({
      type: 'check_in',
      status: 'allowed',
      timestamp: { $lte: scanEnd },
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
      timestamp: { $lte: scanEnd },
    })
      .select('userId timestamp attendanceMode')
      .lean();

    const checkOutsByUser = new Map();
    for (const co of checkOuts) {
      const uid = co.userId.toString();
      if (!checkOutsByUser.has(uid)) checkOutsByUser.set(uid, []);
      checkOutsByUser.get(uid).push(co);
    }

    const pending = [];
    const seenKeys = new Set();
    for (const checkIn of checkIns) {
      const dayKey = getISTDateInputValue(checkIn.timestamp);
      const mode = checkIn.attendanceMode === 'wfh' ? 'wfh' : 'office';
      const key = checkIn.userId.toString() + '|' + dayKey + '|' + mode;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const deadline = computeAutoCheckoutDeadline(mode, dayKey, mode === 'wfh' ? wfhCfg : officeCfg);
      if (!deadline) continue;

      const userCheckOuts = checkOutsByUser.get(checkIn.userId.toString()) ?? [];
      const hasCheckOut = userCheckOuts.some(
        (co) =>
          co.attendanceMode === mode &&
          co.timestamp >= checkIn.timestamp &&
          co.timestamp <= deadline,
      );
      if (hasCheckOut) continue;

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
      await auditLogSync('attendance_auto_checkout', {
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
    await releaseJobLock('auto-checkout', lock.lockId);
  }
}

export function startAutoCheckoutScheduler(intervalMs = 60 * 1000) {
  if (process.env.NODE_ENV === 'test') return null;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return null;
  if (schedulerTimer) return schedulerTimer;
  schedulerTimer = setInterval(() => {
    runAutoCheckoutJob().catch((err) => {
      logError('autoCheckout_job_failed', { error: err?.message ?? err });
    });
  }, intervalMs);
  if (schedulerTimer.unref) schedulerTimer.unref();
  const initial = setTimeout(() => {
    runAutoCheckoutJob().catch((err) => {
      logError('autoCheckout_initial_run_failed', { error: err?.message ?? err });
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
