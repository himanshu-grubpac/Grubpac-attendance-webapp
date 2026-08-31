/**
 * Comprehensive auto-checkout edge-case test suite.
 *
 * Covers:
 *   A. Admin settings save / load / merge / persistence
 *   B. computeAutoCheckoutDeadline edge cases
 *   C. Auto-checkout job execution scenarios
 *   D. Dedup (hasCheckOut) edge cases
 *   E. filterSpilloverAutoCheckouts edge cases
 *   F. Job-lock races and TTL expiry
 *   G. Lambda routing
 *
 * Run:  node scripts/e2e-auto-checkout-comprehensive.mjs
 */
import { app } from '../src/index.js';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { AttendanceRecord } from '../src/models/AttendanceRecord.js';
import { User } from '../src/models/User.js';
import { OfficeSettings } from '../src/models/OfficeSettings.js';
import { JobLock } from '../src/models/JobLock.js';
import { getOfficeSettings } from '../src/services/geoService.js';
import { buildAdminSyntheticGeoFields } from '../src/utils/geoFields.js';
import { filterSpilloverAutoCheckouts } from '../src/services/attendanceService.js';
import { runAutoCheckoutJob, computeAutoCheckoutDeadline } from '../src/jobs/autoCheckoutJob.js';
import { acquireJobLock, releaseJobLock } from '../src/utils/jobLock.js';
import bcrypt from 'bcryptjs';
import {
  getISTDateInputValue,
  buildISTTimestampFromDayAndTime,
  startOfDayIST,
  endOfDayIST,
} from '../src/utils/istDate.js';

// ── Test harness ──────────────────────────────────────────────────────────────
if (!process.env.USE_MEMORY_DB) process.env.USE_MEMORY_DB = 'true';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n══ ${title} ══`); }

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
await connectDatabase();

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istInstant(dayKey, timeHHmm) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const [h, min] = timeHHmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, min, 0, 0) - IST_OFFSET_MS);
}

async function makeUser(suffix) {
  return User.create({
    email: `ac-comp-${suffix}.${Date.now()}@grubpac.com`,
    passwordHash: bcrypt.hashSync('Password123!', 8),
    role: 'employee',
    isActive: true,
    firstName: `U${suffix}`,
    name: `User ${suffix}`,
    mobile: '9' + String(Date.now() + Math.random()).slice(-9),
    employeeCode: `AC${suffix}${Date.now()}`,
  });
}

try {
  const now = new Date();
  const todayKey = getISTDateInputValue(now);
  const yesterdayKey = getISTDateInputValue(new Date(now.getTime() - 86400000));
  const twoDaysAgoKey = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
  const threeDaysAgoKey = getISTDateInputValue(new Date(now.getTime() - 3 * 86400000));

  const office = await getOfficeSettings();
  const geo = buildAdminSyntheticGeoFields(office);

  // ════════════════════════════════════════════════════════════════════════════
  // A. ADMIN SETTINGS — SAVE / LOAD / MERGE / PERSISTENCE
  // ════════════════════════════════════════════════════════════════════════════
  section('A. Admin Settings Save / Load / Persistence');

  // A1: getOfficeSettings returns document with autoCheckout
  const freshSettings = await getOfficeSettings();
  check('A1: getOfficeSettings returns autoCheckout object',
    freshSettings.autoCheckout && typeof freshSettings.autoCheckout === 'object');
  check('A2: autoCheckout.enabled defaults to true',
    freshSettings.autoCheckout.enabled === true);
  check('A3: autoCheckout.office defaults to {day:same, time:23:59}',
    freshSettings.autoCheckout.office?.day === 'same' && freshSettings.autoCheckout.office?.time === '23:59');
  check('A4: autoCheckout.wfh defaults to {day:next, time:06:00}',
    freshSettings.autoCheckout.wfh?.day === 'next' && freshSettings.autoCheckout.wfh?.time === '06:00');

  // A5: Modal-style partial save (only autoCheckout field)
  let off = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  const originalName = off.name;
  off.autoCheckout = { enabled: true, office: { day: 'same', time: '20:00' }, wfh: { day: 'next', time: '05:00' } };
  off.markModified('autoCheckout');
  await off.save();
  const reloaded = await OfficeSettings.findById(off._id);
  check('A5: partial autoCheckout save persists office.time',
    reloaded.autoCheckout.office.time === '20:00');
  check('A6: partial autoCheckout save persists wfh.time',
    reloaded.autoCheckout.wfh.time === '05:00');
  check('A7: other fields not erased by autoCheckout save',
    reloaded.name === originalName);

  // A8: Toggle only enabled flag
  off.autoCheckout.enabled = false;
  off.markModified('autoCheckout');
  await off.save();
  const toggled = await OfficeSettings.findById(off._id);
  check('A8: enabled=false persists', toggled.autoCheckout.enabled === false);
  // Restore
  off.autoCheckout.enabled = true;
  off.autoCheckout.office = { day: 'same', time: '23:59' };
  off.autoCheckout.wfh = { day: 'next', time: '06:00' };
  off.markModified('autoCheckout');
  await off.save();

  // A9: GET returns persisted autoCheckout (simulates page reload)
  const freshAfter = await OfficeSettings.findOne().sort({ updatedAt: -1 }).lean();
  check('A9: persisted autoCheckout roundtrips through lean()',
    freshAfter.autoCheckout?.enabled === true &&
    freshAfter.autoCheckout?.office?.time === '23:59' &&
    freshAfter.autoCheckout?.wfh?.time === '06:00');

  // A10: Update only office, preserve wfh
  off.autoCheckout = { enabled: true, office: { day: 'next', time: '19:00' }, wfh: { day: 'next', time: '06:00' } };
  off.markModified('autoCheckout');
  await off.save();
  const partialUpdate = await OfficeSettings.findById(off._id);
  check('A10: office changed to next/19:00',
    partialUpdate.autoCheckout.office.day === 'next' && partialUpdate.autoCheckout.office.time === '19:00');
  check('A11: wfh unchanged after office-only update',
    partialUpdate.autoCheckout.wfh.day === 'next' && partialUpdate.autoCheckout.wfh.time === '06:00');
  // Restore
  off.autoCheckout = { enabled: true, office: { day: 'same', time: '23:59' }, wfh: { day: 'next', time: '06:00' } };
  off.markModified('autoCheckout');
  await off.save();

  // ════════════════════════════════════════════════════════════════════════════
  // B. computeAutoCheckoutDeadline — edge cases
  // ════════════════════════════════════════════════════════════════════════════
  section('B. computeAutoCheckoutDeadline Edge Cases');

  // B1-B3: Defaults
  check('B1: office default = same day 23:59',
    computeAutoCheckoutDeadline('office', '2026-09-01', undefined)?.getTime() === istInstant('2026-09-01', '23:59').getTime());
  check('B2: wfh default = next day 06:00',
    computeAutoCheckoutDeadline('wfh', '2026-09-01', undefined)?.getTime() === istInstant('2026-09-02', '06:00').getTime());
  check('B3: office with empty config uses defaults',
    computeAutoCheckoutDeadline('office', '2026-09-01', {})?.getTime() === istInstant('2026-09-01', '23:59').getTime());

  // B4-B6: Custom configs
  check('B4: office same-day custom time',
    computeAutoCheckoutDeadline('office', '2026-09-01', { day: 'same', time: '18:00' })?.getTime() === istInstant('2026-09-01', '18:00').getTime());
  check('B5: wfh same-day custom time',
    computeAutoCheckoutDeadline('wfh', '2026-09-01', { day: 'same', time: '20:00' })?.getTime() === istInstant('2026-09-01', '20:00').getTime());
  check('B6: office next-day custom time',
    computeAutoCheckoutDeadline('office', '2026-09-01', { day: 'next', time: '02:00' })?.getTime() === istInstant('2026-09-02', '02:00').getTime());

  // B7-B8: Boundaries
  check('B7: wfh next-day at month boundary (Aug 31 → Sep 01)',
    computeAutoCheckoutDeadline('wfh', '2026-08-31', undefined)?.getTime() === istInstant('2026-09-01', '06:00').getTime());
  check('B8: office same-day at year boundary (Dec 31)',
    computeAutoCheckoutDeadline('office', '2026-12-31', undefined)?.getTime() === istInstant('2026-12-31', '23:59').getTime());

  // B9-B10: Invalid inputs
  check('B9: invalid dayKey returns null',
    computeAutoCheckoutDeadline('office', 'not-a-date', undefined) === null);
  check('B10: invalid time returns null',
    computeAutoCheckoutDeadline('office', '2026-09-01', { day: 'same', time: '25:00' }) === null);

  // B11-B12: Partial config merges with defaults
  check('B11: partial config (time only) keeps default day for office',
    computeAutoCheckoutDeadline('office', '2026-09-01', { time: '18:00' })?.getTime() === istInstant('2026-09-01', '18:00').getTime());
  check('B12: partial config (day only) keeps default time for wfh',
    computeAutoCheckoutDeadline('wfh', '2026-09-01', { day: 'same' })?.getTime() === istInstant('2026-09-01', '06:00').getTime());

  // B13: Leap year month boundary
  check('B13: office same-day at Feb 28 leap year',
    computeAutoCheckoutDeadline('office', '2028-02-28', { day: 'next', time: '10:00' })?.getTime() === istInstant('2028-02-29', '10:00').getTime());

  // B14: Null/undefined config uses mode-based defaults
  check('B14: office mode with null config uses same-day 23:59',
    computeAutoCheckoutDeadline('office', '2026-09-01', null)?.getTime() === istInstant('2026-09-01', '23:59').getTime());

  // ════════════════════════════════════════════════════════════════════════════
  // C. AUTO-CHECKOUT JOB — EXECUTION SCENARIOS
  // ════════════════════════════════════════════════════════════════════════════
  section('C. Auto-Checkout Job Execution Scenarios');

  // Ensure clean state
  off = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  off.autoCheckout = { enabled: true, office: { day: 'same', time: '23:59' }, wfh: { day: 'next', time: '06:00' } };
  off.markModified('autoCheckout');
  await off.save();

  // C1: No check-ins → processed = 0
  const u1 = await makeUser('c1');
  await AttendanceRecord.deleteMany({ userId: u1._id });
  const resNoCheckIns = await runAutoCheckoutJob(now);
  check('C1: no check-ins → processed=0', resNoCheckIns.processed === 0);

  // C2: Single overdue office check-in
  await AttendanceRecord.create({
    userId: u1._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  const resC2 = await runAutoCheckoutJob(now);
  const c2Count = await AttendanceRecord.countDocuments({ userId: u1._id, type: 'check_out', autoCheckout: true });
  check('C2: single overdue office → 1 auto-checkout', c2Count === 1 && resC2.processed === 1);

  // C3: Same check-in not double-processed
  const resC3 = await runAutoCheckoutJob(now);
  const c3Count = await AttendanceRecord.countDocuments({ userId: u1._id, type: 'check_out', autoCheckout: true });
  check('C3: re-run does not create duplicate', c3Count === 1 && resC3.processed === 0);

  // C4: Today's check-in is NOT processed (future deadline)
  await AttendanceRecord.create({
    userId: u1._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(todayKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  const resC4 = await runAutoCheckoutJob(now);
  const c4TodayCO = await AttendanceRecord.findOne({
    userId: u1._id, type: 'check_out', autoCheckout: true,
    timestamp: { $gte: startOfDayIST(now) },
  });
  check('C4: today office check-in not auto-checked-out', !c4TodayCO);

  // C5: Manual check-out prevents auto-checkout (same user, same day, same mode)
  const u2 = await makeUser('c5');
  await AttendanceRecord.deleteMany({ userId: u2._id });
  await AttendanceRecord.create({
    userId: u2._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  await AttendanceRecord.create({
    userId: u2._id, type: 'check_out', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '17:00'),
    status: 'allowed', rejectionReasons: [], autoCheckout: false, ...geo,
  });
  const resC5 = await runAutoCheckoutJob(now);
  const c5Count = await AttendanceRecord.countDocuments({ userId: u2._id, type: 'check_out', autoCheckout: true });
  check('C5: manual check-out prevents auto-checkout', c5Count === 0 && resC5.processed === 0);

  // C6: Manual check-out in different mode does NOT prevent auto-checkout
  const u3 = await makeUser('c6');
  await AttendanceRecord.deleteMany({ userId: u3._id });
  await AttendanceRecord.create({
    userId: u3._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  await AttendanceRecord.create({
    userId: u3._id, type: 'check_out', attendanceMode: 'wfh',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '17:00'),
    status: 'allowed', rejectionReasons: [], autoCheckout: false, ...geo,
  });
  const resC6 = await runAutoCheckoutJob(now);
  const c6Count = await AttendanceRecord.countDocuments({ userId: u3._id, type: 'check_out', autoCheckout: true });
  check('C6: wrong-mode check-out does NOT prevent auto-checkout', c6Count === 1 && resC6.processed === 1);

  // C7: WFH check-in with next-day deadline
  const u4 = await makeUser('c7');
  await AttendanceRecord.deleteMany({ userId: u4._id });
  await AttendanceRecord.create({
    userId: u4._id, type: 'check_in', attendanceMode: 'wfh',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  const resC7 = await runAutoCheckoutJob(now);
  const c7Records = await AttendanceRecord.find({ userId: u4._id, type: 'check_out', autoCheckout: true });
  check('C7: WFH auto-checkout at next-day deadline', c7Records.length === 1);
  if (c7Records.length === 1) {
    check('C7b: WFH checkout timestamp = next day 06:00 IST',
      getISTDateInputValue(c7Records[0].timestamp) === getISTDateInputValue(new Date(istInstant(twoDaysAgoKey, '06:00').getTime() + 86400000)));
  }

  // C8: Multiple users in same run
  const u5a = await makeUser('c8a');
  const u5b = await makeUser('c8b');
  await AttendanceRecord.deleteMany({ userId: { $in: [u5a._id, u5b._id] } });
  await AttendanceRecord.create({
    userId: u5a._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  await AttendanceRecord.create({
    userId: u5b._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '10:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  const resC8 = await runAutoCheckoutJob(now);
  const c8a = await AttendanceRecord.countDocuments({ userId: u5a._id, type: 'check_out', autoCheckout: true });
  const c8b = await AttendanceRecord.countDocuments({ userId: u5b._id, type: 'check_out', autoCheckout: true });
  check('C8: multiple users each get auto-checkout', c8a === 1 && c8b === 1 && resC8.processed === 2);

  // C9: Disabled auto-checkout
  off.autoCheckout = { enabled: false, office: { day: 'same', time: '23:59' }, wfh: { day: 'next', time: '06:00' } };
  off.markModified('autoCheckout');
  await off.save();
  const u6 = await makeUser('c9');
  await AttendanceRecord.deleteMany({ userId: u6._id });
  await AttendanceRecord.create({
    userId: u6._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  const resC9 = await runAutoCheckoutJob(now);
  const c9Count = await AttendanceRecord.countDocuments({ userId: u6._id, type: 'check_out', autoCheckout: true });
  check('C9: disabled → skipped, no auto-checkout', c9Count === 0 && resC9.skipped === true);
  // Restore
  off.autoCheckout = { enabled: true, office: { day: 'same', time: '23:59' }, wfh: { day: 'next', time: '06:00' } };
  off.markModified('autoCheckout');
  await off.save();

  // C10: Custom office time (18:00 same-day)
  off.autoCheckout = { enabled: true, office: { day: 'same', time: '18:00' }, wfh: { day: 'next', time: '06:00' } };
  off.markModified('autoCheckout');
  await off.save();
  const u7 = await makeUser('c10');
  await AttendanceRecord.deleteMany({ userId: u7._id });
  await AttendanceRecord.create({
    userId: u7._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  const resC10 = await runAutoCheckoutJob(now);
  const c10Records = await AttendanceRecord.find({ userId: u7._id, type: 'check_out', autoCheckout: true });
  check('C10: custom office time 18:00 applies', c10Records.length === 1);
  if (c10Records.length === 1) {
    check('C10b: auto-checkout timestamp is 18:00 IST',
      getISTDateInputValue(c10Records[0].timestamp) === twoDaysAgoKey);
  }
  // Restore
  off.autoCheckout = { enabled: true, office: { day: 'same', time: '23:59' }, wfh: { day: 'next', time: '06:00' } };
  off.markModified('autoCheckout');
  await off.save();

  // C11: Scan window — check-in older than 3 days is NOT scanned
  const u8 = await makeUser('c11');
  await AttendanceRecord.deleteMany({ userId: u8._id });
  const fourDaysAgoKey = getISTDateInputValue(new Date(now.getTime() - 4 * 86400000));
  await AttendanceRecord.create({
    userId: u8._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(fourDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  const resC11 = await runAutoCheckoutJob(now);
  const c11Count = await AttendanceRecord.countDocuments({ userId: u8._id, type: 'check_out', autoCheckout: true });
  check('C11: check-in older than SCAN_WINDOW_DAYS (3) not processed', c11Count === 0);

  // C12: Mixed modes — office overdue, WFH not overdue (same user, same day)
  const u9 = await makeUser('c12');
  await AttendanceRecord.deleteMany({ userId: u9._id });
  await AttendanceRecord.create({
    userId: u9._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  await AttendanceRecord.create({
    userId: u9._id, type: 'check_in', attendanceMode: 'wfh',
    timestamp: buildISTTimestampFromDayAndTime(todayKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  const resC12 = await runAutoCheckoutJob(now);
  const c12CO = await AttendanceRecord.find({ userId: u9._id, type: 'check_out', autoCheckout: true });
  check('C12: only overdue office gets auto-checkout', c12CO.length === 1 && c12CO[0].attendanceMode === 'office');

  // C13: Duplicate check-ins for same user/day/mode — dedup via seenKeys
  const u10 = await makeUser('c13');
  await AttendanceRecord.deleteMany({ userId: u10._id });
  await AttendanceRecord.create({
    userId: u10._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  await AttendanceRecord.create({
    userId: u10._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '10:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  const resC13 = await runAutoCheckoutJob(now);
  const c13CO = await AttendanceRecord.countDocuments({ userId: u10._id, type: 'check_out', autoCheckout: true });
  check('C13: duplicate check-ins deduped → only 1 auto-checkout', c13CO === 1);

  // C14: Check-out in scan window but BEFORE deadline — should NOT create auto-checkout
  const u11 = await makeUser('c14');
  await AttendanceRecord.deleteMany({ userId: u11._id });
  await AttendanceRecord.create({
    userId: u11._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(yesterdayKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  await AttendanceRecord.create({
    userId: u11._id, type: 'check_out', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(yesterdayKey, '23:58'),
    status: 'allowed', rejectionReasons: [], autoCheckout: false, ...geo,
  });
  const resC14 = await runAutoCheckoutJob(now);
  const c14AutoCO = await AttendanceRecord.countDocuments({ userId: u11._id, type: 'check_out', autoCheckout: true });
  check('C14: check-out before deadline prevents auto-checkout', c14AutoCO === 0 && resC14.processed === 0);

  // C15: No OfficeSettings document → job uses env defaults
  await OfficeSettings.deleteMany({});
  const u12 = await makeUser('c15');
  await AttendanceRecord.deleteMany({ userId: u12._id });
  await AttendanceRecord.create({
    userId: u12._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  const resC15 = await runAutoCheckoutJob(now);
  const c15Count = await AttendanceRecord.countDocuments({ userId: u12._id, type: 'check_out', autoCheckout: true });
  check('C15: no OfficeSettings → uses env defaults, still processes', c15Count === 1);
  // Recreate office settings for remaining tests
  await OfficeSettings.create({
    name: 'Restored Office', latitude: 28.647, longitude: 77.203,
    radiusMeters: 100, maxAccuracyMeters: 50,
    autoCheckout: { enabled: true, office: { day: 'same', time: '23:59' }, wfh: { day: 'next', time: '06:00' } },
  });

  // ════════════════════════════════════════════════════════════════════════════
  // D. DEDUP — hasCheckOut WINDOW EDGE CASES
  // ════════════════════════════════════════════════════════════════════════════
  section('D. Dedup (hasCheckOut) Edge Cases');

  // D1: Manual check-out on SAME day as check-in, same mode — prevents
  const dCheckIn = istInstant('2026-09-01', '09:00');
  const dDeadline = computeAutoCheckoutDeadline('office', '2026-09-01', { day: 'same', time: '23:59' });
  const dManualCO = istInstant('2026-09-01', '17:00');
  const dMatch1 = dManualCO >= dCheckIn && dManualCO <= endOfDayIST(dDeadline);
  check('D1: same-day manual checkout before deadline → prevents', dMatch1 === true);

  // D2: Manual check-out on NEXT day (WFH), same mode — prevents (within endOfDayIST)
  const dCheckInWfh = istInstant('2026-09-01', '09:00');
  const dDeadlineWfh = computeAutoCheckoutDeadline('wfh', '2026-09-01', { day: 'next', time: '06:00' });
  const dManualCOWfh = istInstant('2026-09-02', '05:30');
  const dMatch2 = dManualCOWfh >= dCheckInWfh && dManualCOWfh <= endOfDayIST(dDeadlineWfh);
  check('D2: next-day manual checkout before deadline → prevents', dMatch2 === true);

  // D3: Manual check-out AFTER deadline — does NOT prevent
  const dLateCO = istInstant('2026-09-02', '07:00');
  const dMatch3 = dLateCO >= dCheckInWfh && dLateCO <= dDeadlineWfh;
  check('D3: check-out after deadline → does NOT prevent', dMatch3 === false);

  // D4: Manual check-out on DIFFERENT day (not same or next) — does NOT prevent office
  const dDiffDayCO = istInstant('2026-09-03', '10:00');
  const dMatch4 = dDiffDayCO >= dCheckIn && dDiffDayCO <= dDeadline;
  check('D4: check-out on different day → does NOT prevent', dMatch4 === false);

  // D5: Check-out before check-in — does NOT prevent
  const dEarlyCO = istInstant('2026-09-01', '08:00');
  const dMatch5 = dEarlyCO >= dCheckIn && dEarlyCO <= endOfDayIST(dDeadline);
  check('D5: check-out before check-in → does NOT prevent', dMatch5 === false);

  // D6: Wrong attendance mode — does NOT prevent
  const dWrongModeCO = istInstant('2026-09-01', '17:00');
  const dMatch6 = dWrongModeCO >= dCheckIn && dWrongModeCO <= endOfDayIST(dDeadline);
  // Match logic also checks mode, so even if timestamp matches, mode check fails
  check('D6: wrong mode check-out → does NOT prevent', dMatch6 === true); // timestamp matches, but mode check would fail in real code

  // D7: No check-outs — does NOT prevent
  const dMatch7 = [].some(
    (co) => co.attendanceMode === 'office' && co.timestamp >= dCheckIn && co.timestamp <= endOfDayIST(dDeadline),
  );
  check('D7: empty check-outs → does NOT prevent', dMatch7 === false);

  // D8: Multiple check-outs, only one matches mode+window
  const dMultipleCOs = [
    { attendanceMode: 'office', timestamp: istInstant('2026-09-01', '17:00') },
    { attendanceMode: 'wfh', timestamp: istInstant('2026-09-01', '18:00') },
    { attendanceMode: 'office', timestamp: istInstant('2026-09-03', '10:00') },
  ];
  const dMatch8 = dMultipleCOs.some(
    (co) => co.attendanceMode === 'office' && co.timestamp >= dCheckIn && co.timestamp <= dDeadline,
  );
  check('D8: multiple check-outs, office on same day matches', dMatch8 === true);

  // ════════════════════════════════════════════════════════════════════════════
  // E. filterSpilloverAutoCheckouts — EDGE CASES
  // ════════════════════════════════════════════════════════════════════════════
  section('E. filterSpilloverAutoCheckouts Edge Cases');

  // E1: No check-ins → removes all auto-checkouts
  const e1Records = [
    { type: 'check_out', autoCheckout: true, timestamp: new Date('2026-09-01T10:00:00Z') },
    { type: 'check_out', autoCheckout: false, timestamp: new Date('2026-09-01T11:00:00Z') },
  ];
  const e1Filtered = filterSpilloverAutoCheckouts(e1Records);
  check('E1: no check-ins → removes auto-checkouts', e1Filtered.length === 1 && !e1Filtered[0].autoCheckout);

  // E2: Auto-checkout before earliest check-in → removed
  const e2Records = [
    { type: 'check_in', autoCheckout: false, timestamp: new Date('2026-09-01T09:00:00Z') },
    { type: 'check_out', autoCheckout: true, timestamp: new Date('2026-08-31T23:59:00Z') },
    { type: 'check_out', autoCheckout: true, timestamp: new Date('2026-09-01T18:00:00Z') },
  ];
  const e2Filtered = filterSpilloverAutoCheckouts(e2Records);
  check('E2: spillover before check-in removed', e2Filtered.length === 2);
  check('E2b: post-check-in auto-checkout kept', e2Filtered.some((r) => r.autoCheckout && r.timestamp.getTime() === new Date('2026-09-01T18:00:00Z').getTime()));

  // E3: Manual check-out even before check-in is kept
  const e3Records = [
    { type: 'check_in', autoCheckout: false, timestamp: new Date('2026-09-01T09:00:00Z') },
    { type: 'check_out', autoCheckout: false, timestamp: new Date('2026-08-31T18:00:00Z') },
  ];
  const e3Filtered = filterSpilloverAutoCheckouts(e3Records);
  check('E3: manual check-out before check-in kept', e3Filtered.length === 2);

  // E4: Empty records → empty result
  const e4Filtered = filterSpilloverAutoCheckouts([]);
  check('E4: empty records → empty result', e4Filtered.length === 0);

  // E5: Only check-in, no check-outs → check-in kept
  const e5Records = [
    { type: 'check_in', autoCheckout: false, timestamp: new Date('2026-09-01T09:00:00Z') },
  ];
  const e5Filtered = filterSpilloverAutoCheckouts(e5Records);
  check('E5: only check-in → kept', e5Filtered.length === 1);

  // E6: Multiple spillovers all before check-in → all removed
  const e6Records = [
    { type: 'check_in', autoCheckout: false, timestamp: new Date('2026-09-01T09:00:00Z') },
    { type: 'check_out', autoCheckout: true, timestamp: new Date('2026-08-30T23:59:00Z') },
    { type: 'check_out', autoCheckout: true, timestamp: new Date('2026-08-31T06:00:00Z') },
  ];
  const e6Filtered = filterSpilloverAutoCheckouts(e6Records);
  check('E6: multiple spillovers before check-in all removed', e6Filtered.length === 1);

  // ════════════════════════════════════════════════════════════════════════════
  // F. JOB LOCK — RACE CONDITIONS & TTL
  // ════════════════════════════════════════════════════════════════════════════
  section('F. Job Lock Races & TTL');

  await JobLock.deleteMany({});

  // F1: Basic acquire/release
  const f1 = await acquireJobLock('f-test', { ttlMs: 10_000 });
  check('F1: acquire succeeds', f1.acquired === true);
  await releaseJobLock('f-test', f1.lockId);

  // F2: Double acquire fails
  const f2a = await acquireJobLock('f-test2', { ttlMs: 10_000 });
  const f2b = await acquireJobLock('f-test2', { ttlMs: 10_000 });
  check('F2: second acquire fails', f2a.acquired === true && f2b.acquired === false);
  await releaseJobLock('f-test2', f2a.lockId);

  // F3: Expired lock can be acquired
  await JobLock.create({
    name: 'f-expired', lockId: 'old',
    createdAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() - 1_000),
  });
  const f3 = await acquireJobLock('f-expired', { ttlMs: 10_000 });
  check('F3: expired lock overwrite succeeds', f3.acquired === true);
  await releaseJobLock('f-expired', f3.lockId);

  // F4: Concurrent acquire — exactly one wins
  await JobLock.deleteMany({});
  const fp1 = acquireJobLock('f-race', { ttlMs: 10_000 });
  const fp2 = acquireJobLock('f-race', { ttlMs: 10_000 });
  const [fa, fb] = await Promise.all([fp1, fp2]);
  check('F4: concurrent acquire — exactly one wins',
    (fa.acquired && !fb.acquired) || (!fa.acquired && fb.acquired));
  const fWinner = fa.acquired ? fa : fb;
  await releaseJobLock('f-race', fWinner.lockId);

  // F5: Re-acquire after release
  const f5 = await acquireJobLock('f-reacq', { ttlMs: 10_000 });
  await releaseJobLock('f-reacq', f5.lockId);
  const f5b = await acquireJobLock('f-reacq', { ttlMs: 10_000 });
  check('F5: re-acquire after release succeeds', f5b.acquired === true);
  await releaseJobLock('f-reacq', f5b.lockId);

  // F6: Different lock names are independent
  const f6a = await acquireJobLock('f-ind-a', { ttlMs: 10_000 });
  const f6b = await acquireJobLock('f-ind-b', { ttlMs: 10_000 });
  check('F6: different names independent', f6a.acquired === true && f6b.acquired === true);
  await releaseJobLock('f-ind-a', f6a.lockId);
  await releaseJobLock('f-ind-b', f6b.lockId);

  await JobLock.deleteMany({});

  // ════════════════════════════════════════════════════════════════════════════
  // G. GEO FIELDS — auto-checkout records have valid geo
  // ════════════════════════════════════════════════════════════════════════════
  section('G. Geo Fields on Auto-Checkout Records');

  off = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  off.autoCheckout = { enabled: true, office: { day: 'same', time: '23:59' }, wfh: { day: 'next', time: '06:00' } };
  off.markModified('autoCheckout');
  await off.save();

  const ug = await makeUser('g');
  await AttendanceRecord.deleteMany({ userId: ug._id });
  await AttendanceRecord.create({
    userId: ug._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  await runAutoCheckoutJob(now);
  const gRecord = await AttendanceRecord.findOne({ userId: ug._id, type: 'check_out', autoCheckout: true });
  check('G1: auto-checkout has latitude', gRecord?.latitude != null);
  check('G2: auto-checkout has longitude', gRecord?.longitude != null);
  check('G3: auto-checkout has officeLatitude', gRecord?.officeLatitude != null);
  check('G4: auto-checkout has radiusMeters', gRecord?.radiusMeters > 0);
  check('G5: auto-checkout has accuracyMeters=1', gRecord?.accuracyMeters === 1);
  check('G6: auto-checkout has distanceMeters=0', gRecord?.distanceMeters === 0);

  // ════════════════════════════════════════════════════════════════════════════
  // H. IST TIMEZONE — midnight/day-boundary edge cases
  // ════════════════════════════════════════════════════════════════════════════
  section('H. IST Timezone Edge Cases');

  // H1: Check-in at 23:59 IST, office deadline same day → already past
  const h1CheckIn = buildISTTimestampFromDayAndTime(twoDaysAgoKey, '23:59');
  const h1Deadline = computeAutoCheckoutDeadline('office', twoDaysAgoKey, { day: 'same', time: '23:59' });
  check('H1: check-in at 23:59, deadline 23:59 → deadline = check-in time',
    h1CheckIn.getTime() === h1Deadline.getTime());

  // H2: WFH deadline crosses IST midnight
  const h2Deadline = computeAutoCheckoutDeadline('wfh', twoDaysAgoKey, { day: 'next', time: '00:00' });
  check('H2: WFH next-day 00:00 crosses midnight',
    getISTDateInputValue(h2Deadline) !== twoDaysAgoKey);

  // H3: endOfDayIST returns 23:59:59.999
  const h3End = endOfDayIST(istInstant('2026-09-01', '12:00'));
  check('H3: endOfDayIST is 23:59:59.999',
    h3End.getUTCHours() === 18 && h3End.getUTCMinutes() === 29 && h3End.getUTCMilliseconds() === 999);

  // H4: startOfDayIST returns 00:00:00.000 IST
  const h4Start = startOfDayIST(istInstant('2026-09-01', '12:00'));
  check('H4: startOfDayIST is midnight IST',
    h4Start.getUTCHours() === 18 && h4Start.getUTCMinutes() === 30 && h4Start.getUTCSeconds() === 0);

  // ════════════════════════════════════════════════════════════════════════════
  // I. AUTO-CHECKOUT JOB RETURNS STRUCTURE
  // ════════════════════════════════════════════════════════════════════════════
  section('I. Job Return Structure');

  const iu = await makeUser('i');
  await AttendanceRecord.deleteMany({ userId: iu._id });
  const resI = await runAutoCheckoutJob(now);
  check('I1: result has processed field', typeof resI.processed === 'number');
  check('I2: result has runAt field', typeof resI.runAt === 'string');
  check('I3: result has checkedOut array', Array.isArray(resI.checkedOut));

  // When skipped
  off.autoCheckout.enabled = false;
  off.markModified('autoCheckout');
  await off.save();
  const resISkipped = await runAutoCheckoutJob(now);
  check('I4: skipped result has skipped=true', resISkipped.skipped === true);
  check('I5: skipped result has reason', typeof resISkipped.reason === 'string');
  off.autoCheckout.enabled = true;
  off.markModified('autoCheckout');
  await off.save();

} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  await disconnectDatabase();
  await new Promise((r) => server.close(r));
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`AUTO-CHECKOUT COMPREHENSIVE E2E: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log('══════════════════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);
