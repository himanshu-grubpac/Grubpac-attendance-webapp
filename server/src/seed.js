import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { pinSchema } from '../../shared/validation/auth.js';
import {
  SEED_DEPARTMENTS,
  SYSTEM_ROLE_SLUGS,
  SYSTEM_ROLES,
  legacyRoleFromSlug,
} from '../../shared/permissions.js';
import { User } from './models/User.js';
import { Role } from './models/Role.js';
import { Department } from './models/Department.js';
import { OfficeSettings } from './models/OfficeSettings.js';
import {
  seedLeaveTypesAndPolicies,
  initBalancesForAllUsers,
} from './services/leaveBalanceService.js';
import { AttendanceRecord } from './models/AttendanceRecord.js';
import { AuditLog } from './models/AuditLog.js';
import { LeaveRequest } from './models/LeaveRequest.js';
import { LeaveType } from './models/LeaveType.js';
import { LeaveCarryForwardEntry } from './models/LeaveCarryForwardEntry.js';
import { WeekAttendanceConfirmation } from './models/WeekAttendanceConfirmation.js';
import { SalaryTransfer } from './models/SalaryTransfer.js';
import { Holiday } from './models/Holiday.js';
import {
  DEFAULT_ATTENDANCE_POLICY,
  parseTimeStringToMinutes,
} from './services/attendancePolicyService.js';
import {
  endOfDayIST,
  getISTDateInputValue,
  getISTWeekday,
  getISTYear,
  parseDateInputAsISTDay,
  startOfDayIST,
} from './utils/istDate.js';

async function upsertSystemRoles() {
  const roleMap = new Map();

  for (const seedRole of SYSTEM_ROLES) {
    let role = await Role.findOne({ slug: seedRole.slug });
    if (!role) {
      role = await Role.create(seedRole);
      console.log(`Seeded role: ${seedRole.name}`);
    } else {
      role.name = seedRole.name;
      role.description = seedRole.description;
      role.isSystem = true;
      role.permissions = seedRole.permissions;
      await role.save();
      console.log(`Updated role: ${seedRole.name}`);
    }
    roleMap.set(seedRole.slug, role);
  }

  return roleMap;
}

async function upsertDepartments() {
  const departmentMap = new Map();

  for (const seedDept of SEED_DEPARTMENTS) {
    let department = await Department.findOne({ code: seedDept.code });
    if (!department) {
      department = await Department.create(seedDept);
      console.log(`Seeded department: ${seedDept.name}`);
    } else {
      department.name = seedDept.name;
      department.isActive = true;
      await department.save();
      console.log(`Updated department: ${seedDept.name}`);
    }
    departmentMap.set(seedDept.code, department);
  }

  return departmentMap;
}

/**
 * Deletes all documents from every collection that actually exists in the connected
 * database (this app's dedicated DB only — MONGODB_URI points at a single-purpose DB).
 * Uses the native driver's listCollections rather than mongoose.connection.collections,
 * since the latter only reflects models registered in this process and would silently
 * skip collections (e.g. attendancerecords, auditlogs) whose models weren't imported here.
 */
async function wipeDatabase() {
  const collectionInfos = await mongoose.connection.db.listCollections().toArray();
  const names = collectionInfos.map((info) => info.name).filter((name) => !name.startsWith('system.'));
  for (const name of names) {
    await mongoose.connection.db.collection(name).deleteMany({});
  }
  console.log(`Wiped ${names.length} collection(s): ${names.join(', ')}`);
}

/** Accounts that survive a full wipe — admin (env) and Himanshu's production login. */
const HIMANSHU_EMAIL = 'salunke.himanshu@grubpac.com';

function getPreservedUserEmails() {
  return [env.adminEmail.toLowerCase(), HIMANSHU_EMAIL.toLowerCase()];
}

async function backupPreservedUsers() {
  const emails = getPreservedUserEmails();
  const users = await User.find({ email: { $in: emails } }).lean();
  if (users.length > 0) {
    console.log(`Backed up ${users.length} preserved user(s): ${users.map((u) => u.email).join(', ')}`);
  }
  return users;
}

async function restorePreservedUsers(backups, roleMap, departmentMap) {
  const adminEmail = env.adminEmail.toLowerCase();

  for (const doc of backups) {
    if (doc.email === adminEmail) {
      continue;
    }

    if (await User.findOne({ email: doc.email })) {
      console.log(`Preserved user already present, skipped restore: ${doc.email}`);
      continue;
    }

    const roleSlug =
      doc.role === 'admin' ? SYSTEM_ROLE_SLUGS.ADMIN : SYSTEM_ROLE_SLUGS.EMPLOYEE;
    const roleId = roleMap.get(roleSlug)?._id ?? roleMap.get(SYSTEM_ROLE_SLUGS.EMPLOYEE)?._id;

    let departmentId = null;
    let department = doc.department ?? undefined;
    if (doc.department) {
      const byName = [...departmentMap.values()].find((dept) => dept.name === doc.department);
      if (byName) {
        departmentId = byName._id;
        department = byName.name;
      }
    }

    const {
      reportingManagerId: _rm,
      managedDepartmentIds: _md,
      delegateApproverId: _da,
      createdBy: _cb,
      roleId: _roleId,
      departmentId: _deptId,
      ...profile
    } = doc;

    await User.collection.insertOne({
      ...profile,
      roleId,
      role: doc.role,
      departmentId,
      department,
      reportingManagerId: null,
      managedDepartmentIds: [],
      delegateApproverId: null,
      createdBy: null,
    });
    console.log(`Restored preserved user: ${doc.email}`);
  }
}

/** Idempotently seeds one sample employee so admin-created data and multi-identifier login (email/mobile/employeeCode) can be exercised after a reseed. */
async function upsertSampleEmployee(roleMap, departmentMap) {
  const employeeRole = roleMap.get(SYSTEM_ROLE_SLUGS.EMPLOYEE);
  const devDepartment = departmentMap.get('DEV');

  const email = 'employee.sample@grubpac.com';
  const mobile = '9876543210';
  const employeeCode = 'EMP001';
  const samplePassword = 'Employee@12345';

  let employee = await User.findOne({ email });

  if (!employee) {
    employee = await User.create({
      role: 'employee',
      roleId: employeeRole._id,
      firstName: 'Sample',
      lastName: 'Employee',
      name: 'Sample Employee',
      email,
      mobile,
      employeeCode,
      designation: 'Software Engineer',
      joiningDate: new Date('2025-01-15'),
      departmentId: devDepartment?._id ?? null,
      department: devDepartment?.name ?? undefined,
      passwordHash: await bcrypt.hash(samplePassword, 12),
      isActive: true,
    });
    console.log(
      `Seeded sample employee: ${email} (mobile ${mobile}, employeeCode ${employeeCode})`,
    );
  } else {
    employee.roleId = employeeRole._id;
    employee.role = 'employee';
    employee.firstName = employee.firstName || 'Sample';
    employee.lastName = employee.lastName || 'Employee';
    employee.designation = employee.designation ?? 'Software Engineer';
    employee.joiningDate = employee.joiningDate ?? new Date('2025-01-15');
    employee.departmentId = employee.departmentId ?? devDepartment?._id ?? null;
    employee.department = employee.department ?? devDepartment?.name ?? undefined;
    employee.mobile = employee.mobile || mobile;
    employee.employeeCode = employee.employeeCode || employeeCode;
    employee.isActive = true;
    await employee.save();
    console.log(`Updated sample employee: ${email}`);
  }

  return employee;
}

function addDaysToDayKey(dayKey, delta) {
  const date = parseDateInputAsISTDay(dayKey);
  date.setUTCDate(date.getUTCDate() + delta);
  return getISTDateInputValue(date);
}

function getWeekStartDayKey(referenceDayKey = getISTDateInputValue()) {
  const weekday = getISTWeekday(parseDateInputAsISTDay(referenceDayKey));
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return addDaysToDayKey(referenceDayKey, mondayOffset);
}

function buildWeekDayKeys(weekStartKey) {
  return Array.from({ length: 7 }, (_, index) => addDaysToDayKey(weekStartKey, index));
}

function istTimestampForDayAndTime(dayKey, hour, minute) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return new Date(`${dayKey}T${hh}:${mm}:00+05:30`);
}

async function upsertTeamLead(roleMap, departmentMap) {
  const managerRole = roleMap.get(SYSTEM_ROLE_SLUGS.REPORTING_MANAGER);
  const devDepartment = departmentMap.get('DEV');
  const email = 'teamlead@grubpac.com';
  const password = 'TeamLead@12345';

  let teamLead = await User.findOne({ email });
  if (!teamLead) {
    teamLead = await User.create({
      role: 'admin',
      roleId: managerRole._id,
      firstName: 'Mohit',
      lastName: 'Sharma',
      name: 'Mohit Sharma',
      email,
      mobile: '9876500001',
      employeeCode: 'TL001',
      designation: 'Team Lead',
      joiningDate: new Date('2024-06-01'),
      departmentId: devDepartment?._id ?? null,
      department: devDepartment?.name ?? undefined,
      managedDepartmentIds: devDepartment?._id ? [devDepartment._id] : [],
      passwordHash: await bcrypt.hash(password, 12),
      isActive: true,
    });
    console.log(`Seeded team lead: ${email} / ${password}`);
  } else {
    teamLead.roleId = managerRole._id;
    teamLead.role = 'admin';
    teamLead.isActive = true;
    teamLead.managedDepartmentIds = devDepartment?._id ? [devDepartment._id] : [];
    teamLead.passwordHash = await bcrypt.hash(password, 12);
    teamLead.managedDepartmentIds = devDepartment?._id ? [devDepartment._id] : [];
    await teamLead.save();
    console.log(`Updated team lead: ${email}`);
  }
  return teamLead;
}

async function upsertTeamMembers(teamLead, roleMap, departmentMap) {
  const employeeRole = roleMap.get(SYSTEM_ROLE_SLUGS.EMPLOYEE);
  const devDepartment = departmentMap.get('DEV');
  const members = [
    { firstName: 'Aarav', lastName: 'Patel', code: 'EMP101', email: 'aarav.patel@grubpac.com', mobile: '9876500101' },
    { firstName: 'Neha', lastName: 'Gupta', code: 'EMP102', email: 'neha.gupta@grubpac.com', mobile: '9876500102' },
    { firstName: 'Rahul', lastName: 'Singh', code: 'EMP103', email: 'rahul.singh@grubpac.com', mobile: '9876500103' },
    { firstName: 'Priya', lastName: 'Mehta', code: 'EMP104', email: 'priya.mehta@grubpac.com', mobile: '9876500104' },
    { firstName: 'Vikram', lastName: 'Rao', code: 'EMP105', email: 'vikram.rao@grubpac.com', mobile: '9876500105' },
  ];

  const created = [];
  for (const seed of members) {
    let employee = await User.findOne({ email: seed.email });
    const name = `${seed.firstName} ${seed.lastName}`;
    if (!employee) {
      employee = await User.create({
        role: 'employee',
        roleId: employeeRole._id,
        firstName: seed.firstName,
        lastName: seed.lastName,
        name,
        email: seed.email,
        mobile: seed.mobile,
        employeeCode: seed.code,
        designation: 'Software Engineer',
        joiningDate: new Date('2025-02-01'),
        departmentId: devDepartment?._id ?? null,
        department: devDepartment?.name ?? undefined,
        reportingManagerId: teamLead._id,
        passwordHash: await bcrypt.hash('Employee@12345', 12),
        isActive: true,
      });
      console.log(`Seeded team member: ${seed.email}`);
    } else {
      employee.reportingManagerId = teamLead._id;
      employee.roleId = employeeRole._id;
      employee.isActive = true;
      await employee.save();
      console.log(`Updated team member: ${seed.email}`);
    }
    created.push(employee);
  }
  return created;
}

const DEMO_HOLIDAY_NAME = 'Demo Republic Day (seed)';

function minutesToHourMinute(totalMinutes) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, totalMinutes));
  return [Math.floor(clamped / 60), clamped % 60];
}

function policyCheckInTimes(office) {
  const graceMinutes =
    parseTimeStringToMinutes(office.graceThresholdTime ?? DEFAULT_ATTENDANCE_POLICY.graceThresholdTime) ??
    9 * 60;
  const halfDayMinutes =
    parseTimeStringToMinutes(office.halfDayThresholdTime ?? DEFAULT_ATTENDANCE_POLICY.halfDayThresholdTime) ??
    10 * 60;
  return {
    onTime: minutesToHourMinute(graceMinutes - 5),
    warn1: minutesToHourMinute(graceMinutes + 15),
    warn2: minutesToHourMinute(graceMinutes + 30),
    warn3: minutesToHourMinute(graceMinutes + 45),
    halfDay: minutesToHourMinute(halfDayMinutes + 20),
    rejectedAttempt: minutesToHourMinute(graceMinutes + 5),
  };
}

function buildAttendancePayload(user, office, timestamp, type, fields = {}) {
  const {
    status = 'allowed',
    rejectionReasons = [],
    attendanceMode = 'office',
    attendanceTag = null,
    lateNote = null,
    warningIssued = false,
    quarterWarningIndex = null,
    ...rest
  } = fields;
  return {
    userId: user._id,
    type,
    timestamp,
    attendanceMode,
    latitude: office.latitude,
    longitude: office.longitude,
    accuracyMeters: 12,
    distanceMeters: status === 'rejected' ? office.radiusMeters + 250 : 8,
    officeLatitude: office.latitude,
    officeLongitude: office.longitude,
    radiusMeters: office.radiusMeters,
    status,
    rejectionReasons,
    attendanceTag,
    lateNote,
    warningIssued,
    quarterWarningIndex,
    ...rest,
  };
}

function planDemoWeek(workingDays, todayKey) {
  const holidayDay = workingDays[Math.min(2, workingDays.length - 1)];
  const absentDay = workingDays[0] < todayKey ? workingDays[0] : null;
  const futureWorkingDays = workingDays.filter((dayKey) => dayKey > todayKey && dayKey !== holidayDay);

  const dayAt = (index) => {
    const day = workingDays[index];
    if (!day || day > todayKey || day === holidayDay) return null;
    return day;
  };

  const fallbackDay =
    workingDays.find((dayKey) => dayKey <= todayKey && dayKey !== holidayDay) ?? null;
  const resolve = (index) => dayAt(index) ?? fallbackDay;

  return {
    holidayDay,
    absentDay,
    leaveDay: futureWorkingDays[0] ?? null,
    rejectedOnlyDay: futureWorkingDays[1] ?? futureWorkingDays[0] ?? null,
    presentOfficeDay: resolve(0),
    wfhDay: resolve(0),
    warn1Day: resolve(1),
    warn2Day: resolve(2),
    warn3Day: resolve(3),
    halfDayDay: resolve(4),
    rejectedAttemptDay: resolve(0),
  };
}

async function seedDemoHoliday(dayKey, adminUser) {
  const holidayDate = parseDateInputAsISTDay(dayKey);
  await Holiday.deleteMany({ name: DEMO_HOLIDAY_NAME });
  await Holiday.create({
    date: holidayDate,
    name: DEMO_HOLIDAY_NAME,
    description: 'Seeded public holiday for attendance grid H status testing.',
    type: 'public',
    isActive: true,
    createdBy: adminUser?._id ?? null,
  });
  console.log(`Seeded demo holiday "${DEMO_HOLIDAY_NAME}" on ${dayKey}.`);
}

async function seedSampleAttendance(teamMembers, sampleEmployee, teamLead, office, adminUser) {
  const todayKey = getISTDateInputValue();
  const weekStart = getWeekStartDayKey(todayKey);
  const weekDays = buildWeekDayKeys(weekStart);
  const workingDays = weekDays.filter((dayKey) => {
    const weekday = getISTWeekday(parseDateInputAsISTDay(dayKey));
    return weekday >= 1 && weekday <= 5;
  });

  if (workingDays.length === 0) {
    console.log('Skipped sample attendance: no working days in current IST week.');
    return;
  }

  const demoUsers = [...teamMembers, sampleEmployee];
  const demoUserIds = demoUsers.map((user) => user._id);
  const weekStartDate = startOfDayIST(parseDateInputAsISTDay(weekStart));
  const weekEndDate = endOfDayIST(parseDateInputAsISTDay(weekDays[6]));
  const plan = planDemoWeek(workingDays, todayKey);
  const times = policyCheckInTimes(office);

  const removed = await AttendanceRecord.deleteMany({
    userId: { $in: demoUserIds },
    timestamp: { $gte: weekStartDate, $lte: weekEndDate },
  });
  if (removed.deletedCount > 0) {
    console.log(`Cleared ${removed.deletedCount} demo attendance record(s) for current IST week.`);
  }

  await LeaveRequest.deleteMany({
    userId: { $in: demoUserIds },
    startDate: { $lte: weekEndDate },
    endDate: { $gte: weekStartDate },
    reason: /Seeded approved leave for attendance grid UI testing/i,
  });

  await seedDemoHoliday(plan.holidayDay, adminUser);

  const [aarav, neha, rahul, priya, vikram] = teamMembers;
  const checkInScenarios = [
    {
      user: aarav,
      dayKey: plan.presentOfficeDay,
      hour: times.onTime[0],
      minute: times.onTime[1],
      attendanceTag: 'P',
      attendanceMode: 'office',
      checkOut: [17, 5],
    },
    {
      user: neha,
      dayKey: plan.wfhDay,
      hour: times.onTime[0],
      minute: times.onTime[1],
      attendanceTag: 'P',
      attendanceMode: 'wfh',
    },
    {
      user: rahul,
      dayKey: plan.warn1Day,
      hour: times.warn1[0],
      minute: times.warn1[1],
      attendanceTag: 'P',
      warningIssued: true,
      quarterWarningIndex: 1,
      lateNote: 'Traffic delay on Ring Road — seeded demo late note.',
    },
    {
      user: priya,
      dayKey: plan.warn2Day,
      hour: times.warn2[0],
      minute: times.warn2[1],
      attendanceTag: 'P',
      warningIssued: true,
      quarterWarningIndex: 2,
      lateNote: 'Doctor appointment ran over — seeded demo late note.',
    },
    {
      user: sampleEmployee,
      dayKey: plan.warn3Day,
      hour: times.warn3[0],
      minute: times.warn3[1],
      attendanceTag: 'P',
      warningIssued: true,
      quarterWarningIndex: 3,
    },
    {
      user: vikram,
      dayKey: plan.halfDayDay,
      hour: times.halfDay[0],
      minute: times.halfDay[1],
      attendanceTag: 'HD',
    },
  ];

  let created = 0;
  for (const scenario of checkInScenarios) {
    const {
      user,
      dayKey,
      hour,
      minute,
      attendanceTag,
      attendanceMode = 'office',
      lateNote = null,
      warningIssued = false,
      quarterWarningIndex = null,
      checkOut,
    } = scenario;
    const checkInAt = istTimestampForDayAndTime(dayKey, hour, minute);
    await AttendanceRecord.create(
      buildAttendancePayload(user, office, checkInAt, 'check_in', {
        attendanceTag,
        attendanceMode,
        lateNote,
        warningIssued,
        quarterWarningIndex,
      }),
    );
    created += 1;

    if (checkOut) {
      const [outHour, outMinute] = checkOut;
      const checkOutAt = istTimestampForDayAndTime(dayKey, outHour, outMinute);
      await AttendanceRecord.create(
        buildAttendancePayload(user, office, checkOutAt, 'check_out', { attendanceMode }),
      );
      created += 1;
    }
  }

  if (plan.rejectedOnlyDay) {
    const rejectedAt = istTimestampForDayAndTime(
      plan.rejectedOnlyDay,
      times.rejectedAttempt[0],
      times.rejectedAttempt[1],
    );
    await AttendanceRecord.create(
      buildAttendancePayload(priya, office, rejectedAt, 'check_in', {
        status: 'rejected',
        rejectionReasons: ['Outside office radius.'],
      }),
    );
    created += 1;
  }

  const attemptAt = istTimestampForDayAndTime(
    plan.rejectedAttemptDay,
    times.rejectedAttempt[0],
    times.rejectedAttempt[1],
  );
  await AttendanceRecord.create(
    buildAttendancePayload(aarav, office, attemptAt, 'check_in', {
      status: 'rejected',
      rejectionReasons: ['Location accuracy too low.'],
    }),
  );
  created += 1;

  if (plan.leaveDay) {
    await seedSampleLeave(sampleEmployee, plan.leaveDay, teamLead);
  }

  if (plan.wfhDay && neha && adminUser) {
    const wfhCheckInAt = istTimestampForDayAndTime(plan.wfhDay, times.onTime[0], times.onTime[1]);
    const demoEditedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const editor = {
      id: adminUser._id.toString(),
      name: adminUser.name ?? adminUser.email ?? 'Admin',
    };
    await AttendanceRecord.updateOne(
      {
        userId: neha._id,
        type: 'check_in',
        timestamp: wfhCheckInAt,
      },
      {
        $set: {
          lastEditedAt: demoEditedAt,
          lastEditedBy: editor,
          editHistory: [
            {
              editedAt: demoEditedAt,
              editedBy: editor,
              changes: [
                { field: 'attendanceMode', from: 'office', to: 'wfh' },
                { field: 'checkInTime', from: '09:20', to: `${String(times.onTime[0]).padStart(2, '0')}:${String(times.onTime[1]).padStart(2, '0')}` },
              ],
            },
          ],
        },
      },
    );
    console.log(`Seeded demo attendance edit history for ${neha.name ?? neha.email} on ${plan.wfhDay}.`);
  }

  const absentNote = plan.absentDay
    ? `Rahul absent on ${plan.absentDay}`
    : 'Absent status visible from Tuesday onward (no past working days yet on Monday)';

  console.log(
    `Seeded ${created} attendance record(s) for IST week ${weekStart}–${weekDays[6]} ` +
      `(P+OFC, P+WFH, W1–W3, HD, RJ, +RJ; holiday ${plan.holidayDay}; leave ${plan.leaveDay ?? 'n/a'}; ${absentNote}).`,
  );
}

async function seedSampleLeave(employee, dayKey, approver) {
  const leaveType = await LeaveType.findOne({ code: 'CL' });
  if (!leaveType) {
    console.log('Skipped sample leave: CL leave type not found.');
    return;
  }

  const leaveDay = parseDateInputAsISTDay(dayKey);
  await LeaveRequest.deleteMany({
    userId: employee._id,
    status: 'approved',
    startDate: { $lte: endOfDayIST(leaveDay) },
    endDate: { $gte: startOfDayIST(leaveDay) },
  });

  await LeaveRequest.create({
    userId: employee._id,
    leaveTypeId: leaveType._id,
    startDate: leaveDay,
    endDate: leaveDay,
    days: 1,
    reason: 'Seeded approved leave for attendance grid UI testing.',
    status: 'approved',
    approverId: approver._id,
    decidedAt: new Date(),
    decisionComment: 'Approved for demo data.',
  });
  console.log(`Seeded approved leave for ${employee.email} on ${dayKey}.`);
}

const SEED_AUDIT_TAG = 'device-conflict-demo';
const SEED_SHARED_DEVICE_ID = 'seed-device-shared-001';
const SEED_SHARED_IP = '203.0.113.50';
const SEED_IP_ONLY_CONFLICT = '198.51.100.77';

/** Idempotent demo login audit logs — two users share a device, one pair shares IP only. */
async function seedDeviceConflictAuditLogs(teamMembers) {
  const [aarav, neha, rahul, priya] = teamMembers;
  if (!aarav || !neha || !rahul) {
    console.log('Skipped device-conflict audit logs: team members not found.');
    return;
  }

  await AuditLog.deleteMany({ 'metadata.seedTag': SEED_AUDIT_TAG });

  const baseTime = Date.now() - 2 * 60 * 60 * 1000;
  const entries = [
    {
      action: 'login_success',
      userId: aarav._id,
      email: aarav.email,
      role: 'employee',
      ip: SEED_SHARED_IP,
      deviceId: SEED_SHARED_DEVICE_ID,
      userAgent: 'Mozilla/5.0 (seed) Chrome/120',
      status: 'success',
      timestamp: new Date(baseTime),
      metadata: { seedTag: SEED_AUDIT_TAG, scenario: 'device-conflict-user-a' },
    },
    {
      action: 'login_success',
      userId: neha._id,
      email: neha.email,
      role: 'employee',
      ip: SEED_SHARED_IP,
      deviceId: SEED_SHARED_DEVICE_ID,
      userAgent: 'Mozilla/5.0 (seed) Chrome/120',
      status: 'success',
      timestamp: new Date(baseTime + 30 * 60 * 1000),
      metadata: { seedTag: SEED_AUDIT_TAG, scenario: 'device-conflict-user-b' },
    },
    {
      action: 'login_success',
      userId: rahul._id,
      email: rahul.email,
      role: 'employee',
      ip: SEED_IP_ONLY_CONFLICT,
      deviceId: 'seed-device-rahul-002',
      userAgent: 'Mozilla/5.0 (seed) Firefox/121',
      status: 'success',
      timestamp: new Date(baseTime + 45 * 60 * 1000),
      metadata: { seedTag: SEED_AUDIT_TAG, scenario: 'ip-conflict-user-c' },
    },
    {
      action: 'login_success',
      userId: priya?._id ?? neha._id,
      email: priya?.email ?? neha.email,
      role: 'employee',
      ip: SEED_IP_ONLY_CONFLICT,
      deviceId: 'seed-device-priya-003',
      userAgent: 'Mozilla/5.0 (seed) Safari/17',
      status: 'success',
      timestamp: new Date(baseTime + 60 * 60 * 1000),
      metadata: { seedTag: SEED_AUDIT_TAG, scenario: 'ip-conflict-user-d' },
    },
    {
      action: 'login_failed',
      userId: null,
      email: 'unknown.demo@grubpac.com',
      role: null,
      ip: SEED_SHARED_IP,
      deviceId: SEED_SHARED_DEVICE_ID,
      userAgent: 'Mozilla/5.0 (seed) Chrome/120',
      status: 'failed',
      reason: 'Invalid credentials (seed demo)',
      timestamp: new Date(baseTime + 15 * 60 * 1000),
      metadata: { seedTag: SEED_AUDIT_TAG, scenario: 'failed-login-same-device' },
    },
  ];

  await AuditLog.insertMany(entries);
  console.log(
    `Seeded ${entries.length} login audit log(s) for device/IP conflict testing ` +
      `(shared device: ${SEED_SHARED_DEVICE_ID}; shared IP: ${SEED_IP_ONLY_CONFLICT}).`,
  );
}

async function seedWeekAttendanceConfirmations(teamMembers, teamLead) {
  const todayKey = getISTDateInputValue();
  const weekStart = getWeekStartDayKey(todayKey);
  const demoUser = teamMembers[0];
  if (!demoUser || !teamLead) {
    console.log('Skipped week attendance confirmations: demo user or team lead missing.');
    return;
  }

  await WeekAttendanceConfirmation.findOneAndUpdate(
    { userId: demoUser._id, weekStart },
    {
      userId: demoUser._id,
      weekStart,
      confirmedBy: teamLead._id,
      confirmedAt: new Date(),
      notes: 'Seeded week confirmation for attendance review demo.',
    },
    { upsert: true, new: true },
  );
  console.log(`Seeded week attendance confirmation for ${demoUser.email} (week ${weekStart}).`);
}

async function seedSalaryTransfers(teamMembers, adminUser) {
  const now = new Date();
  const periodKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const demoUser = teamMembers[1] ?? teamMembers[0];
  if (!demoUser) {
    console.log('Skipped salary transfers: no demo users.');
    return;
  }

  const transfers = [
    {
      userId: demoUser._id,
      periodKey,
      amount: 85000,
      currency: 'INR',
      status: 'paid',
      note: 'Seeded salary transfer — paid',
      paidAt: new Date(now.getFullYear(), now.getMonth(), 1),
      createdBy: adminUser?._id ?? null,
      updatedBy: adminUser?._id ?? null,
    },
    {
      userId: teamMembers[2]?._id ?? demoUser._id,
      periodKey: `${now.getFullYear()}-${String(Math.max(1, now.getMonth())).padStart(2, '0')}`,
      amount: 72000,
      currency: 'INR',
      status: 'pending',
      note: 'Seeded salary transfer — pending',
      createdBy: adminUser?._id ?? null,
      updatedBy: adminUser?._id ?? null,
    },
  ];

  for (const row of transfers) {
    await SalaryTransfer.findOneAndUpdate(
      { userId: row.userId, periodKey: row.periodKey },
      row,
      { upsert: true, new: true },
    );
  }
  console.log(`Seeded ${transfers.length} salary transfer(s) for demo users.`);
}

async function seedLeaveCarryForwardDemo(employee, adminUser) {
  if (!employee) {
    console.log('Skipped leave carry-forward demo: employee missing.');
    return;
  }

  const clType = await LeaveType.findOne({ code: 'CL' });
  if (!clType) {
    console.log('Skipped leave carry-forward demo: CL leave type missing.');
    return;
  }

  const fromYear = getISTYear() - 1;
  const toYear = getISTYear();

  await LeaveCarryForwardEntry.findOneAndUpdate(
    { userId: employee._id, leaveTypeId: clType._id, fromYear },
    {
      userId: employee._id,
      leaveTypeId: clType._id,
      fromYear,
      toYear,
      remaining: 5,
      carried: 3,
      forfeited: 2,
      appliedBy: adminUser?._id ?? employee._id,
    },
    { upsert: true, new: true },
  );
  console.log(
    `Seeded leave carry-forward entry for ${employee.email} (${fromYear} → ${toYear}, CL).`,
  );
}

async function migrateUsers(roleMap) {
  const adminRole = roleMap.get(SYSTEM_ROLE_SLUGS.ADMIN);
  const employeeRole = roleMap.get(SYSTEM_ROLE_SLUGS.EMPLOYEE);

  const users = await User.find({});
  let migrated = 0;

  for (const user of users) {
    let changed = false;

    if (!user.roleId) {
      user.roleId = user.role === 'admin' ? adminRole._id : employeeRole._id;
      changed = true;
    }

    const roleDoc = await Role.findById(user.roleId);
    const expectedLegacyRole = legacyRoleFromSlug(roleDoc?.slug ?? SYSTEM_ROLE_SLUGS.EMPLOYEE);
    if (user.role !== expectedLegacyRole) {
      user.role = expectedLegacyRole;
      changed = true;
    }

    if (changed) {
      await user.save();
      migrated += 1;
    }
  }

  if (migrated > 0) {
    console.log(`Migrated ${migrated} user(s) to RBAC roles.`);
  }
}

export async function seedDatabase({ wipe = false } = {}) {
  await connectDatabase();

  let preservedUsers = [];
  if (wipe) {
    preservedUsers = await backupPreservedUsers();
    await wipeDatabase();
  }

  const roleMap = await upsertSystemRoles();
  const departmentMap = await upsertDepartments();

  const adminEmail = env.adminEmail.toLowerCase();
  const adminRole = roleMap.get(SYSTEM_ROLE_SLUGS.ADMIN);
  const [adminFirstName, ...adminLastNameParts] = env.adminName.trim().split(/\s+/);
  const adminLastName = adminLastNameParts.join(' ') || adminFirstName;
  let admin = await User.findOne({ email: adminEmail });

  if (!admin) {
    admin = await User.findOne({ role: 'admin' });
  }

  // Validate first: a non-4-digit ADMIN_PIN would hash into a credential
  // that can never verify (and the system admin has no PIN API fallback).
  pinSchema.parse(env.adminPin);
  if (!admin) {
    await User.create({
      role: 'admin',
      roleId: adminRole._id,
      firstName: adminFirstName,
      lastName: adminLastName,
      name: env.adminName,
      email: adminEmail,
      mobile: '9999999999',
      designation: 'System Administrator',
      joiningDate: new Date(),
      passwordHash: await bcrypt.hash(env.adminPassword, 12),
      pin4Hash: await bcrypt.hash(env.adminPin, 12),
      isActive: true,
    });
    console.log(`Seeded admin: ${adminEmail}`);
  } else {
    admin.firstName = admin.firstName || adminFirstName;
    admin.lastName = admin.lastName || adminLastName;
    admin.name = env.adminName;
    admin.email = adminEmail;
    admin.passwordHash = await bcrypt.hash(env.adminPassword, 12);
    admin.pin4Hash = await bcrypt.hash(env.adminPin, 12);
    admin.isActive = true;
    admin.role = 'admin';
    admin.roleId = adminRole._id;
    admin.designation = admin.designation ?? 'System Administrator';
    admin.joiningDate = admin.joiningDate ?? new Date();
    await admin.save();
    console.log(`Updated admin: ${adminEmail}`);
  }

  await upsertSampleEmployee(roleMap, departmentMap);

  const sampleEmployee = await User.findOne({ email: 'employee.sample@grubpac.com' });
  const teamLead = await upsertTeamLead(roleMap, departmentMap);
  const teamMembers = await upsertTeamMembers(teamLead, roleMap, departmentMap);

  if (preservedUsers.length > 0) {
    await restorePreservedUsers(preservedUsers, roleMap, departmentMap);
  }

  await migrateUsers(roleMap);

  await seedLeaveTypesAndPolicies();
  await initBalancesForAllUsers(getISTYear());
  // Holiday calendar: published each January by HR — seed empty; admins add via /admin/leave/holidays
  console.log('Leave types/policies seeded. Holiday list empty until HR publishes January calendar.');

  const office = await OfficeSettings.findOne();
  if (!office) {
    await OfficeSettings.create({
      ...env.defaultOffice,
      ...DEFAULT_ATTENDANCE_POLICY,
    });
    console.log('Seeded default office settings.');
  } else {
    office.name = env.defaultOffice.name;
    office.officeStartTime = office.officeStartTime ?? DEFAULT_ATTENDANCE_POLICY.officeStartTime;
    office.officeEndTime = office.officeEndTime ?? DEFAULT_ATTENDANCE_POLICY.officeEndTime;
    office.graceThresholdTime = office.graceThresholdTime ?? DEFAULT_ATTENDANCE_POLICY.graceThresholdTime;
    office.halfDayThresholdTime = office.halfDayThresholdTime ?? DEFAULT_ATTENDANCE_POLICY.halfDayThresholdTime;
    office.warningsPerQuarter = office.warningsPerQuarter ?? DEFAULT_ATTENDANCE_POLICY.warningsPerQuarter;
    await office.save();
    console.log(`Updated office settings: ${env.defaultOffice.name}`);
  }

  const officeDoc = await OfficeSettings.findOne();
  const adminUser = await User.findOne({ email: adminEmail });
  if (sampleEmployee) {
    await seedSampleAttendance(
      teamMembers,
      sampleEmployee,
      teamLead,
      officeDoc ?? env.defaultOffice,
      adminUser,
    );
    await seedDeviceConflictAuditLogs(teamMembers);
    await seedWeekAttendanceConfirmations(teamMembers, teamLead);
    await seedSalaryTransfers(teamMembers, adminUser);
    await seedLeaveCarryForwardDemo(sampleEmployee, adminUser);
  }
}

async function seed() {
  try {
    const wipe = process.argv.includes('--wipe');
    await seedDatabase({ wipe });
    await disconnectDatabase();
    process.exit(0);
  } catch (error) {
  console.error(error);
  process.exit(1);
  }
}

if (process.argv[1]?.endsWith('seed.js')) {
  seed();
}
