import mongoose from 'mongoose';
import { app } from '../src/index.js';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { User } from '../src/models/User.js';
import { LeaveRequest } from '../src/models/LeaveRequest.js';
import { Notification } from '../src/models/Notification.js';
import { decideLeaveRequest } from '../src/services/leaveService.js';
import { renderLeaveApplicantEmail } from '../src/services/emailService.js';
import bcrypt from 'bcryptjs';

if (!process.env.USE_MEMORY_DB) process.env.USE_MEMORY_DB = 'true';

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
  const employee = await User.create({
    email: 'reject-e2e-employee.' + Date.now() + '@grubpac.com',
    passwordHash: bcrypt.hashSync('Password123!', 8),
    firstName: 'Reject',
    name: 'Reject E2E',
    role: 'employee',
    isActive: true,
    mobile: '9' + String(Date.now()).slice(-9),
    employeeCode: 'RE' + Date.now(),
  });

  const manager = await User.create({
    email: 'reject-e2e-manager.' + Date.now() + '@grubpac.com',
    passwordHash: bcrypt.hashSync('Password123!', 8),
    firstName: 'Mgr',
    name: 'Mgr E2E',
    role: 'admin',
    isActive: true,
    mobile: '8' + String(Date.now()).slice(-9),
    employeeCode: 'MG' + Date.now(),
  });

  const leaveRequest = await LeaveRequest.create({
    userId: employee._id,
    leaveTypeId: new mongoose.Types.ObjectId(),
    startDate: new Date(),
    endDate: new Date(),
    days: 1,
    status: 'pending',
    reason: 'e2e rejection test',
  });
  const requestId = leaveRequest._id.toString();

  const beforeNotifCount = await Notification.countDocuments({ userId: employee._id, type: 'leave.rejected' });

  const consoleOutput = [];
  const origLog = console.log;
  console.log = (...args) => { consoleOutput.push(args.join(' ')); origLog(...args); };

  let result;
  let error;
  try {
    result = await decideLeaveRequest(requestId, manager, ['leave.approve', 'leave.read_all'], 'rejected', { comment: 'Not enough coverage' });
  } catch (e) {
    error = e;
  } finally {
    console.log = origLog;
  }

  check('reject does not throw', !error);
  check('request status is rejected', result && result.status === 'rejected');

  const afterNotifCount = await Notification.countDocuments({ userId: employee._id, type: 'leave.rejected' });
  check('in-app notification created', afterNotifCount > beforeNotifCount);

  const savedRequest = await LeaveRequest.findById(requestId).lean();
  check('notificationsSent is true', savedRequest.notificationsSent === true);
  check('notifyAfter is null', savedRequest.notifyAfter === null);

  const emailLogged = consoleOutput.some((line) => line.includes('email:sent') && line.includes(employee.email));
  check('rejection email sent', emailLogged);

  const notif = await Notification.findOne({ userId: employee._id, type: 'leave.rejected' }).sort({ createdAt: -1 }).lean();
  check('notification body contains comment', notif && notif.body.includes('Not enough coverage'));

  // Email template renders correctly for rejection
  const email = renderLeaveApplicantEmail({
    leaveTypeName: 'Sick Leave',
    status: 'rejected',
    remarks: 'Insufficient balance',
    dateText: '31 Aug 2026',
    timeText: 'Full day',
  });
  check('email subject contains rejected', email.subject.includes('rejected'));
  check('email html contains rejected', email.html.includes('rejected'));
  check('email html contains leave type name', email.html.includes('Sick Leave'));
  check('email text contains rejected', email.text.includes('rejected'));

} catch (e) {
  failed++;
  console.error('ERROR', e);
} finally {
  await disconnectDatabase();
  await new Promise((r) => server.close(r));
}

console.log('LEAVE REJECT EMAIL E2E:', passed, 'passed,', failed, 'failed');
process.exit(failed === 0 ? 0 : 1);
