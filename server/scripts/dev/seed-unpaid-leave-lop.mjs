/**
 * Phase 6 — seed approved overdrawn CL so browser scenario 7 can show Unpaid CL on LOP detail.
 *
 * Usage (from server/):
 *   node --env-file=.env scripts/dev/seed-unpaid-leave-lop.mjs
 *
 * Idempotent: skips if target employee already has Unpaid CL in September 2026.
 */
import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { User } from '../../src/models/User.js';
import { LeaveType } from '../../src/models/LeaveType.js';
import { LeaveRequest } from '../../src/models/LeaveRequest.js';
import { PERMISSIONS } from '../../../shared/permissions.js';
import {
  adjustBalance,
  ensureBalancesForUser,
} from '../../src/services/leaveBalanceService.js';
import {
  createLeaveRequest,
  decideLeaveRequest,
  runLeaveDecisionNotifyJob,
} from '../../src/services/leaveService.js';
import { getLopDetailForUser } from '../../src/services/salaryService.js';
import { getISTYear } from '../../src/utils/istDate.js';

const TARGET_EMAIL = process.env.UNPAID_LOP_EMAIL || 'neha.gupta@grubpac.com';
const LEAVE_DAY = process.env.UNPAID_LOP_DAY || '2026-09-11';
const MONTH = LEAVE_DAY.slice(0, 7);
const YEAR = getISTYear(new Date(`${LEAVE_DAY}T12:00:00+05:30`));

const ADMIN_PERMS = [
  PERMISSIONS.LEAVE_APPROVE,
  PERMISSIONS.LEAVE_READ_ALL,
  PERMISSIONS.SALARY_READ,
  PERMISSIONS.USERS_READ,
];

async function finalizeSubmit(requestId) {
  const doc = await LeaveRequest.findById(requestId).lean();
  if (!doc?.notifyAfter) return;
  await runLeaveDecisionNotifyJob(new Date(new Date(doc.notifyAfter).getTime() + 1000));
}

async function finalizeDecision(requestId) {
  const doc = await LeaveRequest.findById(requestId).lean();
  if (!doc?.notifyAfter) return;
  await runLeaveDecisionNotifyJob(new Date(new Date(doc.notifyAfter).getTime() + 1000));
}

async function main() {
  await connectDatabase();

  const admin = await User.findOne({ email: 'admin@grubpac.com', isActive: true });
  if (!admin) {
    console.error('ERROR: admin@grubpac.com not found');
    process.exit(1);
  }

  let employee = await User.findOne({ email: TARGET_EMAIL, isActive: true });
  if (!employee) {
    employee = await User.findOne({
      isActive: true,
      monthlySalary: { $gt: 0 },
      role: 'employee',
    }).sort({ name: 1 });
  }
  if (!employee) {
    console.error('ERROR: no suitable employee with salary found');
    process.exit(1);
  }

  if (!employee.monthlySalary || employee.monthlySalary <= 0) {
    employee.monthlySalary = 32000;
    employee.salaryEffectiveFrom = employee.salaryEffectiveFrom ?? new Date('2026-01-01T00:00:00.000Z');
    await employee.save();
    console.log(`Set monthlySalary=32000 on ${employee.email}`);
  }

  const clType = await LeaveType.findOne({ code: 'CL', isActive: true });
  if (!clType) {
    console.error('ERROR: CL leave type not found');
    process.exit(1);
  }

  await ensureBalancesForUser(employee._id, YEAR);

  await adjustBalance(
    employee._id,
    {
      leaveTypeId: clType._id.toString(),
      year: YEAR,
      entitled: 0,
      used: 0,
      pending: 0,
      carried: 0,
      encashed: 0,
      reason: 'Phase 6 unpaid LOP browser fixture — zero CL balance',
    },
    admin._id,
  );

  const existingDetail = await getLopDetailForUser(
    admin,
    ADMIN_PERMS,
    employee._id.toString(),
    MONTH,
    '2026-09-16',
  );
  const alreadyHasUnpaid = (existingDetail.deductions ?? []).some(
    (row) => row.reason === 'Unpaid CL' && row.date === LEAVE_DAY,
  );
  if (alreadyHasUnpaid) {
    console.log(`SKIP: ${employee.name} already has Unpaid CL on ${LEAVE_DAY}`);
    console.log(JSON.stringify({ employeeId: employee._id.toString(), email: employee.email, month: MONTH }, null, 2));
    await disconnectDatabase();
    return;
  }

  // Cancel stuck provisional requests for this employee/day that block balance finalize.
  await LeaveRequest.updateMany(
    {
      userId: employee._id,
      status: 'pending',
      startDate: { $lte: new Date(`${LEAVE_DAY}T23:59:59+05:30`) },
      endDate: { $gte: new Date(`${LEAVE_DAY}T00:00:00+05:30`) },
    },
    { $set: { status: 'cancelled', pendingDecision: null, notifyAfter: null } },
  );

  const created = await createLeaveRequest(employee._id, {
    leaveTypeId: clType._id.toString(),
    startDate: LEAVE_DAY,
    endDate: LEAVE_DAY,
    reason: 'Phase 6 unpaid LOP browser fixture',
  });
  console.log(`Created leave request ${created.id} (provisional submit)`);

  await finalizeSubmit(created.id);

  await decideLeaveRequest(created.id, admin, ADMIN_PERMS, 'approved', {
    comment: 'Phase 6 fixture — approve overdrawn CL',
  });
  console.log('Staged approval — waiting for finalize job');

  await finalizeDecision(created.id);

  const finalReq = await LeaveRequest.findById(created.id).lean();
  if (finalReq?.status !== 'approved') {
    console.error('ERROR: leave not finalized', { status: finalReq?.status });
    process.exit(1);
  }

  const detail = await getLopDetailForUser(
    admin,
    ADMIN_PERMS,
    employee._id.toString(),
    MONTH,
    '2026-09-16',
  );
  const unpaidRow = (detail.deductions ?? []).find((row) => row.reason === 'Unpaid CL');
  if (!unpaidRow) {
    console.error('ERROR: Unpaid CL row missing from LOP detail', detail.deductions);
    process.exit(1);
  }

  console.log('PASS: Unpaid CL visible in LOP detail');
  console.log(
    JSON.stringify(
      {
        employeeId: employee._id.toString(),
        name: employee.name,
        email: employee.email,
        monthlySalary: employee.monthlySalary,
        month: MONTH,
        unpaidRow,
      },
      null,
      2,
    ),
  );

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await disconnectDatabase();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
