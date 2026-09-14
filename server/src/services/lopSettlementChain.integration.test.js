import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PERMISSIONS } from '../../../shared/permissions.js';
import { User } from '../models/User.js';
import { LeaveType } from '../models/LeaveType.js';
import { LeavePolicy } from '../models/LeavePolicy.js';
import { LeaveBalance } from '../models/LeaveBalance.js';
import { LeaveRequest } from '../models/LeaveRequest.js';
import { LopRecord } from '../models/LopRecord.js';
import { MonthSettlement } from '../models/MonthSettlement.js';
import { SalaryTransfer } from '../models/SalaryTransfer.js';
import { approvePendingDays } from './leaveBalanceService.js';
import {
  createLopOnApproval,
  listRecentSettlements,
  settleMonthPayroll,
} from './lopSettlementService.js';
import { getMonthlySalaryAudit } from './salaryAuditService.js';
import { getSalarySummaryForUser } from './salaryService.js';
import { parseDateInputAsISTDay } from '../utils/istDate.js';

const YEAR = 2025;
const PERIOD = '2025-06';
// Mon 2025-06-02 … Fri 2025-06-06 = 5 working days, no holidays in a clean DB.
const START = parseDateInputAsISTDay('2025-06-02');
const END = parseDateInputAsISTDay('2025-06-06');

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}),
    LeaveType.deleteMany({}),
    LeavePolicy.deleteMany({}),
    LeaveBalance.deleteMany({}),
    LeaveRequest.deleteMany({}),
    LopRecord.deleteMany({}),
    MonthSettlement.deleteMany({}),
    SalaryTransfer.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createOverdrawnFixture() {
  sequence += 1;
  const user = await User.create({
    firstName: 'Lop',
    lastName: `Chain${sequence}`,
    name: `Lop Chain${sequence}`,
    email: `lop.chain.${sequence}@test.example`,
    mobile: `8${String(sequence).padStart(9, '0')}`,
    employeeCode: `LOP${String(sequence).padStart(7, '0')}`,
    passwordHash: 'test-password-hash',
    role: 'employee',
    isActive: true,
    monthlySalary: 30000,
  });

  const leaveType = await LeaveType.create({ code: 'SL', name: 'Sick Leave', isActive: true });
  await LeavePolicy.create({
    leaveTypeId: leaveType._id,
    year: YEAR,
    annualQuota: 2,
    accrualPerMonth: 0,
    paid: true,
    isActive: true,
  });
  await LeaveBalance.create({
    userId: user._id,
    leaveTypeId: leaveType._id,
    year: YEAR,
    entitled: 2,
    used: 0,
    pending: 0,
    carried: 0,
    encashed: 0,
  });

  // Simulate approval of a 5-day request against a quota of 2 (overdraw by 3).
  const request = await LeaveRequest.create({
    userId: user._id,
    leaveTypeId: leaveType._id,
    startDate: START,
    endDate: END,
    days: 5,
    reason: 'Overdrawn sick leave',
    status: 'approved',
    notificationsSent: true,
    submitNotificationsSent: true,
  });
  await approvePendingDays(user._id, leaveType._id, 5, YEAR);

  return { user, leaveType, request };
}

test('approval beyond quota creates a pending LOP record', async () => {
  const { user, leaveType, request } = await createOverdrawnFixture();

  const record = await createLopOnApproval(user._id, leaveType._id, request._id, START, 5);

  assert.ok(record);
  assert.equal(record.status, 'pending');
  assert.equal(record.days, 3);
  assert.equal(record.deductionAmount, 0);
  assert.equal(record.periodKey, PERIOD);
});

test('settleMonthPayroll finalizes LOP and is idempotent', async () => {
  const { user, leaveType, request } = await createOverdrawnFixture();
  await createLopOnApproval(user._id, leaveType._id, request._id, START, 5);

  const result = await settleMonthPayroll(PERIOD, user._id);

  assert.equal(result.settled, true);
  assert.equal(result.periodKey, PERIOD);
  assert.equal(result.employeesWithLop, 1);
  assert.equal(result.totalLopDays, 3);
  assert.ok(result.transfersCreated >= 1);

  const settled = await LopRecord.findOne({ leaveRequestId: request._id });
  assert.equal(settled.status, 'settled');
  assert.equal(settled.days, 3);
  // June 2025 has 21 working days: 30000 / 21 = 1428.57 per day.
  assert.equal(settled.deductionAmount, 4285.71);
  assert.ok(settled.settledAt instanceof Date);

  const doc = await MonthSettlement.findOne({ periodKey: PERIOD });
  assert.ok(doc);

  const again = await settleMonthPayroll(PERIOD, user._id);
  assert.equal(again.settled, false);
  assert.equal(again.alreadySettled, true);
});

test('salary summary exposes which dates became LOP', async () => {
  const { user, leaveType, request } = await createOverdrawnFixture();
  await createLopOnApproval(user._id, leaveType._id, request._id, START, 5);

  const { summary } = await getSalarySummaryForUser(
    user,
    [PERMISSIONS.SALARY_READ],
    user._id.toString(),
    PERIOD,
  );

  // No attendance: 21 working days minus 2 paid-leave days = 19 unpaid days.
  assert.equal(summary.lopDays, 19);
  assert.equal(summary.lopDates.length, 19);
  // Quota of 2 covers Jun 2–3; Jun 4–6 go minus → LOP with full-day unpaid.
  for (const date of ['2025-06-04', '2025-06-05', '2025-06-06']) {
    const entry = summary.lopDates.find((item) => item.date === date);
    assert.ok(entry, `expected LOP entry for ${date}`);
    assert.equal(entry.unpaidDays, 1);
  }
});

test('recent settlements list the last run month and time', async () => {
  const { user, leaveType, request } = await createOverdrawnFixture();
  await createLopOnApproval(user._id, leaveType._id, request._id, START, 5);
  await settleMonthPayroll(PERIOD, user._id);

  const settlements = await listRecentSettlements(6);

  assert.ok(settlements.length >= 1);
  assert.equal(settlements[0].periodKey, PERIOD);
  assert.ok(settlements[0].settledAt instanceof Date);
});

test('settlement resets the minus carried bucket to zero for the new cycle', async () => {
  const { user, leaveType } = await createOverdrawnFixture();

  // Seed a minus bucket left over from an earlier LOP deduction cycle.
  await LeaveBalance.findOneAndUpdate(
    { userId: user._id, leaveTypeId: leaveType._id, year: YEAR },
    { carried: -2 },
  );

  await settleMonthPayroll('2025-07', user._id);

  const balance = await LeaveBalance.findOne({ userId: user._id, leaveTypeId: leaveType._id, year: YEAR });
  assert.equal(balance.carried, 0);
});

test('monthly audit reflects settled LOP for the employee', async () => {
  const { user, leaveType, request } = await createOverdrawnFixture();
  await createLopOnApproval(user._id, leaveType._id, request._id, START, 5);
  await settleMonthPayroll(PERIOD, user._id);

  const audit = await getMonthlySalaryAudit(
    { _id: user._id },
    [PERMISSIONS.SALARY_READ],
    PERIOD,
  );

  assert.equal(audit.periodKey, PERIOD);
  assert.equal(audit.employees.length, 1);
  const row = audit.employees[0];
  assert.equal(row.status, 'settled');
  assert.equal(row.lopDays, 3);
  assert.equal(row.lopDeduction, 4285.71);
  // Settled months use the generated transfer amount as net-salary truth.
  const transfer = await SalaryTransfer.findOne({ userId: user._id, periodKey: PERIOD });
  assert.equal(row.netSalary, transfer.amount);
  assert.equal(audit.totals.lopDays, 3);
  assert.equal(audit.totals.lopDeduction, 4285.71);
});

test('overdrawn settlement finalizes LOP records AND resets negative carried in one run', async () => {
  // Locks in the deduct-then-reset ordering inside settleMonthPayroll: an
  // overdrawn SL balance (used 5 > entitled 2, carried 0) settles its 3 LOP
  // days while a leftover minus bucket on another type resets to zero.
  // (The minus bucket lives on CL so it cannot change the SL LOP math.)
  const { user, leaveType, request } = await createOverdrawnFixture();
  const clType = await LeaveType.create({ code: 'CL', name: 'Casual Leave', isActive: true });
  await LeaveBalance.create({
    userId: user._id,
    leaveTypeId: clType._id,
    year: YEAR,
    entitled: 0,
    used: 0,
    pending: 0,
    carried: -2,
    encashed: 0,
  });
  await createLopOnApproval(user._id, leaveType._id, request._id, START, 5);

  const result = await settleMonthPayroll(PERIOD, user._id);

  assert.equal(result.settled, true);
  assert.equal(result.employeesWithLop, 1);
  assert.equal(result.totalLopDays, 3);

  const settled = await LopRecord.findOne({ leaveRequestId: request._id });
  assert.equal(settled.status, 'settled');
  assert.equal(settled.days, 3);

  const clBalance = await LeaveBalance.findOne({ userId: user._id, leaveTypeId: clType._id, year: YEAR });
  assert.equal(clBalance.carried, 0);
});
