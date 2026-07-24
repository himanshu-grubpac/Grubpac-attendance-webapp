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
import { getISTYear } from './utils/istDate.js';

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

  await migrateUsers(roleMap);

  await seedLeaveTypesAndPolicies();
  await initBalancesForAllUsers(getISTYear());
  // Holiday calendar: published each January by HR — seed empty; admins add via /admin/leave/holidays
  console.log('Leave types/policies seeded. Holiday list empty until HR publishes January calendar.');

  const office = await OfficeSettings.findOne();
  if (!office) {
    await OfficeSettings.create(env.defaultOffice);
    console.log('Seeded default office settings.');
  } else {
    office.name = env.defaultOffice.name;
    await office.save();
    console.log(`Updated office settings: ${env.defaultOffice.name}`);
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
