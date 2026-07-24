import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';
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
import { LeaveRequest } from './models/LeaveRequest.js';
import { LeaveType } from './models/LeaveType.js';
import { DEFAULT_ATTENDANCE_POLICY } from './services/attendancePolicyService.js';
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
      passwordHash: await bcrypt.hash(password, 12),
      isActive: true,
    });
    console.log(`Seeded team lead: ${email} / ${password}`);
  } else {
    teamLead.roleId = managerRole._id;
    teamLead.role = 'admin';
    teamLead.isActive = true;
    teamLead.passwordHash = await bcrypt.hash(password, 12);
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

function buildAttendancePayload(user, office, timestamp, type, policyFields = {}) {
  return {
    userId: user._id,
    type,
    timestamp,
    latitude: office.latitude,
    longitude: office.longitude,
    accuracyMeters: 12,
    distanceMeters: 8,
    officeLatitude: office.latitude,
    officeLongitude: office.longitude,
    radiusMeters: office.radiusMeters,
    status: 'allowed',
    rejectionReasons: [],
    attendanceTag: null,
    warningIssued: false,
    quarterWarningIndex: null,
    ...policyFields,
  };
}

async function seedSampleAttendance(teamMembers, sampleEmployee, teamLead, office) {
  const weekStart = getWeekStartDayKey();
  const weekDays = buildWeekDayKeys(weekStart);
  const workingDays = weekDays.filter((dayKey) => {
    const weekday = getISTWeekday(parseDateInputAsISTDay(dayKey));
    return weekday >= 1 && weekday <= 5;
  });

  if (workingDays.length < 5) {
    console.log('Skipped sample attendance: current IST week has fewer than five working days.');
    return;
  }

  const [mon, tue, wed, thu, fri] = workingDays;
  const demoUsers = [...teamMembers, sampleEmployee];
  const demoUserIds = demoUsers.map((user) => user._id);
  const weekStartDate = startOfDayIST(parseDateInputAsISTDay(weekStart));
  const weekEndDate = endOfDayIST(parseDateInputAsISTDay(weekDays[6]));

  const removed = await AttendanceRecord.deleteMany({
    userId: { $in: demoUserIds },
    timestamp: { $gte: weekStartDate, $lte: weekEndDate },
  });
  if (removed.deletedCount > 0) {
    console.log(`Cleared ${removed.deletedCount} demo attendance record(s) for current IST week.`);
  }

  const [aarav, neha, rahul, priya, vikram] = teamMembers;
  const checkInScenarios = [
    {
      user: aarav,
      dayKey: mon,
      hour: 8,
      minute: 55,
      attendanceTag: 'P',
      warningIssued: false,
      quarterWarningIndex: null,
      checkOut: [17, 5],
    },
    {
      user: neha,
      dayKey: tue,
      hour: 9,
      minute: 15,
      attendanceTag: 'P',
      warningIssued: true,
      quarterWarningIndex: 1,
    },
    {
      user: rahul,
      dayKey: wed,
      hour: 9,
      minute: 45,
      attendanceTag: 'P',
      warningIssued: true,
      quarterWarningIndex: 2,
    },
    {
      user: sampleEmployee,
      dayKey: wed,
      hour: 9,
      minute: 30,
      attendanceTag: 'P',
      warningIssued: true,
      quarterWarningIndex: 3,
    },
    {
      user: priya,
      dayKey: thu,
      hour: 10,
      minute: 20,
      attendanceTag: 'HD',
      warningIssued: false,
      quarterWarningIndex: null,
    },
    {
      user: vikram,
      dayKey: fri,
      hour: 8,
      minute: 50,
      attendanceTag: 'P',
      warningIssued: false,
      quarterWarningIndex: null,
      checkOut: [17, 0],
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
      warningIssued,
      quarterWarningIndex,
      checkOut,
    } = scenario;
    const checkInAt = istTimestampForDayAndTime(dayKey, hour, minute);
    await AttendanceRecord.create(
      buildAttendancePayload(user, office, checkInAt, 'check_in', {
        attendanceTag,
        warningIssued,
        quarterWarningIndex,
      }),
    );
    created += 1;

    if (checkOut) {
      const [outHour, outMinute] = checkOut;
      const checkOutAt = istTimestampForDayAndTime(dayKey, outHour, outMinute);
      await AttendanceRecord.create(buildAttendancePayload(user, office, checkOutAt, 'check_out'));
      created += 1;
    }
  }

  await seedSampleLeave(neha, fri, teamLead);

  console.log(
    `Seeded ${created} attendance record(s) for IST week ${weekStart}–${weekDays[6]} ` +
      `(Mon P+checkout, Tue W1, Wed W2/W3, Thu HD, Fri P+checkout; ` +
      `Mon absent for Rahul, Fri leave for Neha, Fri pending/absent for Aarav).`,
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

  if (wipe) {
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
      isActive: true,
    });
    console.log(`Seeded admin: ${adminEmail}`);
  } else {
    admin.firstName = admin.firstName || adminFirstName;
    admin.lastName = admin.lastName || adminLastName;
    admin.name = env.adminName;
    admin.email = adminEmail;
    admin.passwordHash = await bcrypt.hash(env.adminPassword, 12);
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
  if (sampleEmployee) {
    await seedSampleAttendance(teamMembers, sampleEmployee, teamLead, officeDoc ?? env.defaultOffice);
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
