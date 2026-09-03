import mongoose from 'mongoose';
import 'dotenv/config';

/**
 * Seed realistic attendance + leave data across all departments and working
 * statuses for the CURRENT IST week, so the admin Attendance page filters and
 * infinite-scroll pagination can be tested end to end.
 *
 * Status coverage per filter option:
 *  - office : allowed check_in with attendanceMode 'office'
 *  - wfh    : allowed check_in with attendanceMode 'wfh'
 *  - sl/cl/el/co/rh : approved LeaveRequest for that leave type covering a day
 *  - absent : no allowed check-in on a past working day
 */

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:60033/?replicaSet=testset';
const c = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000 }).asPromise();
const db = c.getClient().db(c.name);

const OFFICE = { lat: 28.647284, lng: 77.202835, radius: 5000, maxAcc: 100 };
const HOME = { lat: 28.5943, lng: 77.3089 };

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function startOfDayIST(date) {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_OFFSET_MS);
}
function dayKeyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0) - IST_OFFSET_MS);
}
function dateToDayKey(date) {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(key, n) {
  const d = dayKeyToDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return dateToDayKey(d);
}
function getISTWeekday(key) {
  const date = dayKeyToDate(key);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(date);
}
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Load reference data ────────────────────────────────────────────────
const depts = await db.collection('departments').find({}).toArray();
const deptByCode = new Map(depts.map((d) => [d.code, d]));
const leaveTypes = await db.collection('leavetypes').find({}).toArray();
const leaveTypeByCode = new Map(leaveTypes.map((t) => [t.code.toUpperCase(), t]));

// ── 1. Assign departments to users who have none ──────────────────────
// Spread the 27 unassigned active users across Design / GTM / Strategy / Development.
const users = await db.collection('users').find({ isActive: true }).toArray();
const departmentCodes = ['DEV', 'DES', 'GTM', 'STR'];
let assigned = 0;
for (const user of users) {
  if (user.departmentId || user.department) continue;
  if (user.role === 'admin') continue;
  const code = departmentCodes[assigned % departmentCodes.length];
  const dept = deptByCode.get(code);
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { departmentId: dept._id, department: dept.name } },
  );
  assigned += 1;
}
console.log(`Assigned departments to ${assigned} users`);

const finalUsers = await db.collection('users').find({ isActive: true, role: { $ne: 'admin' } }).toArray();
console.log(`Active non-admin users: ${finalUsers.length}`);

// ── 2. Build the current IST week (Mon–Sun) ───────────────────────────
const today = new Date();
const todayKey = dateToDayKey(today);
const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
const todayWk = weekdayMap[getISTWeekday(todayKey)];
const mondayOffset = todayWk === 0 ? -6 : 1 - todayWk;
const weekStart = addDays(todayKey, mondayOffset);
const weekKeys = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
console.log('Seed week:', weekStart, '→', weekKeys[6], '(today:', todayKey + ')');

// Holidays for this week (from DB) so weekend/holiday cells classify right.
const holidays = await db.collection('holidays').find({ isActive: true }).toArray();
const holidayKeys = new Set(holidays.map((h) => dateToDayKey(h.date)));

// ── 3. Clear ALL previous attendance + approved leaves for these users ──
// (not just the seed range) so re-runs are fully idempotent.
const userIds = finalUsers.map((u) => u._id);
const weekStartDate = startOfDayIST(dayKeyToDate(weekStart));
const weekEndDate = new Date(startOfDayIST(dayKeyToDate(weekKeys[6])).getTime() + 24 * 60 * 60 * 1000 - 1);

// Also seed several PAST weeks so infinite scroll has plenty of pages.
const HISTORY_WEEKS = 10; // seed 10 past weeks → ~1000+ records

const historyStartKey = addDays(weekStart, -7 * HISTORY_WEEKS);
const historyStartDate = new Date(startOfDayIST(dayKeyToDate(historyStartKey)).getTime() - 24 * 60 * 60 * 1000);
const historyEndDate = new Date(weekEndDate.getTime() + 24 * 60 * 60 * 1000);
const cleared = await db.collection('attendancerecords').deleteMany({
  userId: { $in: userIds },
});
console.log(`Cleared ${cleared.deletedCount} existing attendance records for seed users`);

// Also clear approved leave requests seeded for this range so statuses stay predictable.
await db.collection('leaverequests').deleteMany({
  userId: { $in: userIds },
  status: 'approved',
  startDate: { $lte: historyEndDate },
  endDate: { $gte: historyStartDate },
});

// ── 4. Assign each user a per-day status plan for each week ────────────
// Build all week start keys from HISTORY_WEEKS past up to the current week.
const allWeekStarts = [];
for (let w = HISTORY_WEEKS; w >= 0; w -= 1) {
  allWeekStarts.push(addDays(weekStart, -7 * w));
}

const statuses = ['office', 'office', 'office', 'wfh', 'wfh', 'absent', 'absent', 'absent', 'sl', 'cl', 'el', 'co', 'rh'];

let attendanceDocs = [];
let leaveDocs = [];
let leaveBalanceUpdates = [];

for (let i = 0; i < finalUsers.length; i += 1) {
  const user = finalUsers[i];
  // Deterministic-ish pseudo-random per user so runs are stable.
  const seedBase = (i * 7 + user._id.toString().length) % 17;
  let dayCursor = 0;

  for (const wkStart of allWeekStarts) {
    const wkKeys = Array.from({ length: 7 }, (_, di) => addDays(wkStart, di));
    const wkWorking = wkKeys.filter(
      (k) => !['Sat', 'Sun'].includes(getISTWeekday(k)) && !holidayKeys.has(k),
    );

    for (const dayKey of wkWorking) {
      // Skip days in the future (can't seed attendance for future days).
      if (dayKey > todayKey) continue;

      const status = statuses[(seedBase + dayCursor) % statuses.length];
      dayCursor += 1;
      const isLeave = ['sl', 'cl', 'el', 'co', 'rh', 'wfh'].includes(status);

      if (status === 'absent') continue; // no record → absent cell

      const dayDate = dayKeyToDate(dayKey);
      const checkInTime = new Date(dayDate.getTime() + ((8 + (seedBase % 2)) * 60 + 30) * 60 * 1000);
      const checkOutTime = new Date(dayDate.getTime() + ((17 + (seedBase % 2)) * 60 + 15) * 60 * 1000);
      const isWfh = status === 'wfh';
      const mode = isWfh ? 'wfh' : 'office';
      const loc = isWfh ? HOME : OFFICE;
      const distance = isWfh ? round2(randomInt(9000, 14000)) : round2(randomInt(50, 4800));
      const accuracy = randomInt(8, 90);
      const warning = (seedBase + dayCursor) % 9 === 0;
      const halfDay = (seedBase + dayCursor) % 13 === 0;

      const baseRecord = {
        userId: user._id,
        attendanceMode: mode,
        leaveStatus: 'approved',
        latitude: loc.lat,
        longitude: loc.lng,
        accuracyMeters: accuracy,
        distanceMeters: distance,
        officeLatitude: OFFICE.lat,
        officeLongitude: OFFICE.lng,
        radiusMeters: OFFICE.radius,
        status: 'allowed',
        rejectionReasons: [],
        attendanceTag: halfDay ? 'HD' : 'P',
        lateNote: null,
        warningIssued: warning,
        quarterWarningIndex: warning ? (seedBase % 3) + 1 : null,
        autoCheckout: false,
      };

      attendanceDocs.push({
        ...baseRecord,
        type: 'check_in',
        timestamp: checkInTime,
        createdAt: checkInTime,
        updatedAt: checkInTime,
      });
      attendanceDocs.push({
        ...baseRecord,
        type: 'check_out',
        timestamp: checkOutTime,
        createdAt: checkOutTime,
        updatedAt: checkOutTime,
        attendanceTag: null,
        warningIssued: false,
        quarterWarningIndex: null,
      });

      // For leave statuses, also create an approved LeaveRequest covering the day.
      if (isLeave) {
        const code = status === 'wfh' ? 'WFH' : status.toUpperCase();
        const leaveType = leaveTypeByCode.get(code);
      if (leaveType) {
        leaveDocs.push({
          userId: user._id,
          leaveTypeId: leaveType._id,
          startDate: dayDate,
          endDate: dayDate,
          days: 1,
          halfDay: null,
          reason: code === 'WFH'
            ? 'Working from home for the day.'
            : `On ${leaveType.name.toLowerCase()} leave.`,
          status: 'approved',
          approverId: null,
          decidedAt: new Date(dayDate.getTime() - 24 * 60 * 60 * 1000),
          decisionComment: null,
          adminException: false,
          decisionTokens: [],
          notifyAfter: null,
          notificationsSent: true,
          createdAt: new Date(dayDate.getTime() - 24 * 60 * 60 * 1000),
          updatedAt: new Date(dayDate.getTime() - 24 * 60 * 60 * 1000),
        });
      }
    }
  }

  // A few rejected check-ins for realistic "rejected" cells (count as absent).
  const curWeekWorking = weekKeys.filter(
    (k) => !['Sat', 'Sun'].includes(getISTWeekday(k)) && !holidayKeys.has(k),
  );
  if (i % 5 === 0 && curWeekWorking.length > 1 && curWeekWorking[1] <= todayKey) {
    const dayDate = dayKeyToDate(curWeekWorking[1]);
    attendanceDocs.push({
      userId: user._id,
      type: 'check_in',
      attendanceMode: 'office',
      leaveStatus: 'approved',
      timestamp: new Date(dayDate.getTime() + 10 * 60 * 60 * 1000),
      latitude: HOME.lat + 0.02,
      longitude: HOME.lng + 0.01,
      accuracyMeters: 120,
      distanceMeters: 15000,
      officeLatitude: OFFICE.lat,
      officeLongitude: OFFICE.lng,
      radiusMeters: OFFICE.radius,
      status: 'rejected',
      rejectionReasons: ['Outside office radius.'],
      attendanceTag: null,
      lateNote: null,
      warningIssued: false,
      quarterWarningIndex: null,
      autoCheckout: false,
      createdAt: new Date(dayDate.getTime() + 10 * 60 * 60 * 1000),
      updatedAt: new Date(dayDate.getTime() + 10 * 60 * 60 * 1000),
    });
  }

  // Track balance effect for approved leave days (used += 1 per approved leave day).
  const year = Number(weekStart.slice(0, 4));
  for (const ld of leaveDocs.filter((x) => String(x.userId) === String(user._id))) {
    leaveBalanceUpdates.push({
      userId: user._id,
      leaveTypeId: ld.leaveTypeId,
      year,
      days: ld.days,
    });
  }
  }
}

// ── 5. Insert attendance records in batches ────────────────────────────
console.log(`Inserting ${attendanceDocs.length} attendance records...`);
for (let i = 0; i < attendanceDocs.length; i += 500) {
  await db.collection('attendancerecords').insertMany(attendanceDocs.slice(i, i + 500));
}

// ── 6. Insert approved leave requests ──────────────────────────────────
console.log(`Inserting ${leaveDocs.length} approved leave requests...`);
const insertedLeaves = await db.collection('leaverequests').insertMany(leaveDocs);

// ── 7. Update leave balances (used += days for approved leaves) ────────
let balanceUpdates = 0;
const seenBalances = new Set();
for (const upd of leaveBalanceUpdates) {
  const key = `${String(upd.userId)}|${String(upd.leaveTypeId)}|${upd.year}`;
  if (seenBalances.has(key)) continue;
  seenBalances.add(key);
  const res = await db.collection('leavebalances').updateOne(
    { userId: upd.userId, leaveTypeId: upd.leaveTypeId, year: upd.year },
    { $inc: { used: upd.days } },
  );
  if (res.matchedCount === 0) {
    await db.collection('leavebalances').insertOne({
      userId: upd.userId,
      leaveTypeId: upd.leaveTypeId,
      year: upd.year,
      entitled: 7,
      used: upd.days,
      pending: 0,
      carried: 0,
      encashed: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  balanceUpdates += 1;
}
console.log(`Updated ${balanceUpdates} leave balances`);

// ── 8. Summary ─────────────────────────────────────────────────────────
const byDept = {};
for (const u of finalUsers) {
  const dept = u.department || 'none';
  byDept[dept] = (byDept[dept] || 0) + 1;
}
console.log('Department distribution:', JSON.stringify(byDept, null, 2));

const total = await db.collection('attendancerecords').countDocuments({});
const weekTotal = await db.collection('attendancerecords').countDocuments({
  timestamp: { $gte: weekStartDate, $lte: weekEndDate },
});
console.log('Total attendance records:', total, '| in seed week:', weekTotal);
console.log('Approved leaves inserted:', insertedLeaves.insertedCount);

// Per-status coverage summary (current seed week, past days)
const coverage = { office: 0, wfh: 0, sl: 0, cl: 0, el: 0, co: 0, rh: 0, absent: 0 };
const curWeekWorking = weekKeys.filter(
  (k) => !['Sat', 'Sun'].includes(getISTWeekday(k)) && !holidayKeys.has(k),
);
for (const u of finalUsers) {
  const userId = u._id;
  const myLeaves = await db.collection('leaverequests').find({
    userId, status: 'approved', startDate: { $lte: weekEndDate }, endDate: { $gte: weekStartDate },
  }).toArray();
  const leaveDayKeys = new Set();
  for (const l of myLeaves) {
    let cur = dateToDayKey(l.startDate);
    const end = dateToDayKey(l.endDate);
    while (cur <= end) { leaveDayKeys.add(cur); cur = addDays(cur, 1); }
  }
  const myRecords = await db.collection('attendancerecords').find({
    userId, type: 'check_in', timestamp: { $gte: weekStartDate, $lte: weekEndDate },
  }).toArray();
  const recordDays = new Map();
  for (const r of myRecords) recordDays.set(dateToDayKey(r.timestamp), r);

  for (const dayKey of curWeekWorking) {
    if (dayKey > todayKey) continue;
    if (leaveDayKeys.has(dayKey)) {
      const code = myLeaves.find((l) => {
        const s = dateToDayKey(l.startDate); const e = dateToDayKey(l.endDate);
        return dayKey >= s && dayKey <= e;
      })?.leaveTypeId;
      const type = leaveTypes.find((t) => String(t._id) === String(code));
      const key = type?.code?.toLowerCase();
      if (key && key in coverage) coverage[key] += 1;
      continue;
    }
    const rec = recordDays.get(dayKey);
    if (rec && rec.status === 'allowed') {
      coverage[rec.attendanceMode === 'wfh' ? 'wfh' : 'office'] += 1;
    } else {
      coverage.absent += 1;
    }
  }
}
console.log('Per-status coverage (seed week, past days):', JSON.stringify(coverage, null, 2));
console.log('History range:', historyStartKey, '→', weekKeys[6]);

await c.close();
console.log('DONE');
