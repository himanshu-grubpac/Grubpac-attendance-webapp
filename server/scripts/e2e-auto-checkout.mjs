import { app } from '../src/index.js';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { AttendanceRecord } from '../src/models/AttendanceRecord.js';
import { User } from '../src/models/User.js';
import { OfficeSettings } from '../src/models/OfficeSettings.js';
import { getOfficeSettings } from '../src/services/geoService.js';
import { buildAdminSyntheticGeoFields } from '../src/services/attendanceService.js';
import { runAutoCheckoutJob, computeAutoCheckoutDeadline } from '../src/jobs/autoCheckoutJob.js';
import bcrypt from 'bcryptjs';
import {
  getISTDateInputValue,
  buildISTTimestampFromDayAndTime,
} from '../src/utils/istDate.js';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name); }
}

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
await connectDatabase();

try {
  const email = 'e2e.ac.' + Date.now() + '@grubpac.com';
  const user = await User.create({
    email,
    passwordHash: bcrypt.hashSync('Password123!', 8),
    role: 'employee',
    isActive: true,
    firstName: 'AC',
    name: 'AC Test',
    mobile: '9' + String(Date.now()).slice(-9),
    employeeCode: 'AC' + Date.now(),
  });

  const office = await getOfficeSettings();
  const geo = buildAdminSyntheticGeoFields(office);
  const now = new Date();
  const todayKey = getISTDateInputValue(now);
  const twoDaysAgoKey = getISTDateInputValue(new Date(now.getTime() - 2 * 86400000));
  const yesterdayKey = getISTDateInputValue(new Date(now.getTime() - 86400000));

  async function makeCheckIn(mode, dayKey, time) {
    return AttendanceRecord.create({
      userId: user._id, type: 'check_in', attendanceMode: mode,
      timestamp: buildISTTimestampFromDayAndTime(dayKey, time),
      status: 'allowed', rejectionReasons: [], ...geo,
    });
  }
  async function countAutoCheckouts() {
    return AttendanceRecord.countDocuments({ userId: user._id, type: 'check_out', autoCheckout: true });
  }

  // Scenario 1: overdue office check-in (2 days ago)
  await makeCheckIn('office', twoDaysAgoKey, '09:00');
  // Scenario 2: overdue wfh check-in (2 days ago)
  await makeCheckIn('wfh', twoDaysAgoKey, '09:00');
  // Scenario 3: today office (09:00) -> NOT due yet
  await makeCheckIn('office', todayKey, '09:00');
  // Scenario 4: already checked out 2 days ago -> no double
  await makeCheckIn('office', yesterdayKey, '08:00');
  const manualCO = await AttendanceRecord.create({
    userId: user._id, type: 'check_out', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(yesterdayKey, '18:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });

  const before = await countAutoCheckouts();
  const result = await runAutoCheckoutJob(now);
  const after = await countAutoCheckouts();

  check('exactly two overdue sessions auto-checked-out', after - before === 2);
  check('job result processed === 2', result.processed === 2);
  const reManual = await AttendanceRecord.findById(manualCO._id);
  check('manual checkout not flagged as auto', reManual.autoCheckout === false);
  const todayCO = await AttendanceRecord.findOne({
    userId: user._id, type: 'check_out', autoCheckout: true,
    timestamp: { $gte: buildISTTimestampFromDayAndTime(todayKey, '00:00') },
  });
  check('today office not auto-checked-out (future deadline)', !todayCO);

  // Deadline computation
  const dOffice = computeAutoCheckoutDeadline('office', twoDaysAgoKey, '23:59', '06:00');
  const dWfh = computeAutoCheckoutDeadline('wfh', twoDaysAgoKey, '23:59', '06:00');
  check('office deadline is same IST day at 23:59', getISTDateInputValue(dOffice) === twoDaysAgoKey);
  const nextKey = getISTDateInputValue(new Date(buildISTTimestampFromDayAndTime(twoDaysAgoKey, '00:00').getTime() + 86400000));
  check('wfh deadline is next IST day at 06:00', getISTDateInputValue(dWfh) === nextKey);

  // Disabled scenario
  let off = await OfficeSettings.findOne().sort({ updatedAt: -1 });
  if (!off) off = await OfficeSettings.create({ name: 'X', latitude: 1, longitude: 1, radiusMeters: 100, maxAccuracyMeters: 50 });
  off.autoCheckout = { enabled: false, officeTime: '23:59', wfhTime: '06:00' };
  await off.save();
  const u2 = await User.create({
    email: 'e2e.ac2.' + Date.now() + '@grubpac.com',
    passwordHash: bcrypt.hashSync('Password123!', 8), role: 'employee', isActive: true,
    firstName: 'AC2', name: 'AC2', mobile: '8' + String(Date.now()).slice(-9), employeeCode: 'AC2' + Date.now(),
  });
  await AttendanceRecord.create({
    userId: u2._id, type: 'check_in', attendanceMode: 'office',
    timestamp: buildISTTimestampFromDayAndTime(twoDaysAgoKey, '09:00'),
    status: 'allowed', rejectionReasons: [], ...geo,
  });
  const beforeDisabled = await AttendanceRecord.countDocuments({ userId: u2._id, type: 'check_out', autoCheckout: true });
  const resDisabled = await runAutoCheckoutJob(now);
  const afterDisabled = await AttendanceRecord.countDocuments({ userId: u2._id, type: 'check_out', autoCheckout: true });
  check('disabled auto-checkout creates nothing', afterDisabled - beforeDisabled === 0 && resDisabled.skipped === true);

  // Re-enable with custom office time -> should now process overdue
  off.autoCheckout = { enabled: true, officeTime: '20:00', wfhTime: '05:00' };
  await off.save();
  const resCustom = await runAutoCheckoutJob(now);
  const afterCustom = await AttendanceRecord.countDocuments({ userId: u2._id, type: 'check_out', autoCheckout: true });
  check('re-enabled auto-checkout processes overdue with custom time', afterCustom - beforeDisabled === 1 && resCustom.processed >= 1);
} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  await disconnectDatabase();
  await new Promise((r) => server.close(r));
}

console.log('AUTOCHECKOUT E2E:', passed, 'passed,', failed, 'failed');
process.exit(failed === 0 ? 0 : 1);