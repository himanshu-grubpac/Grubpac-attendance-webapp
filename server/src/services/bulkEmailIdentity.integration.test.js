/**
 * Bulk upload with email identity (no id/password/PIN columns).
 *
 * Rows whose email matches an existing user UPDATE that user; unknown emails
 * CREATE with a mandatory role, auto emp code (when blank) and an
 * auto-generated Firstname@EmpCode password. Email/mobile/employeeCode are
 * immutable via bulk — mismatches are per-row validation errors that name
 * the employee and block that row's update.
 */
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import '../models/Department.js';
import { Department } from '../models/Department.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';
import {
  buildEmployeeDirectoryWorkbook,
  createEmployeeAndPassword,
  importEmployeesFromRowsUpsert,
  resolveRoleByNameOrSlug,
} from './excelImportService.js';
import { clearTestEmailOutbox, testEmailOutbox } from './emailService.js';
import { PERMISSIONS } from '../../../shared/permissions.js';

let memoryServer;
let sequence = 0;
let roles = {};
let department;
let manager;

const nextEmail = (prefix) => {
  sequence += 1;
  return `${prefix}.${sequence}@bulk.test`;
};
const nextMobile = () => {
  sequence += 1;
  return `9${String(100000000 + sequence)}`;
};

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Promise.all([Role.deleteMany({}), User.deleteMany({}), Department.deleteMany({})]);
  roles = {
    employee: await Role.create({ name: 'Employee', slug: 'employee', permissions: [] }),
    hr: await Role.create({ name: 'HR', slug: 'hr', permissions: [] }),
    rm: await Role.create({ name: 'Reporting Manager', slug: 'reporting-manager', permissions: [] }),
    admin: await Role.create({ name: 'Admin', slug: 'admin', permissions: [] }),
  };
  department = await Department.create({ name: 'Development', code: 'DEV', isActive: true });
  manager = await User.create({
    role: 'employee',
    roleId: roles.rm._id,
    firstName: 'Rita',
    lastName: 'Manager',
    name: 'Rita Manager',
    email: 'rita.manager@bulk.test',
    mobile: nextMobile(),
    passwordHash: 'hash',
    employeeCode: 'TLM900',
    isActive: true,
  });
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

function seedUser(overrides = {}) {
  sequence += 1;
  return User.create({
    role: 'employee',
    roleId: roles.employee._id,
    firstName: 'Seed',
    lastName: 'User',
    name: 'Seed User',
    email: `seed.${sequence}@bulk.test`,
    mobile: `8${String(100000000 + sequence)}`,
    passwordHash: 'hash',
    employeeCode: `TST${String(900 + sequence)}`,
    designation: 'Engineer',
    joiningDate: new Date('2024-06-01'),
    departmentId: department._id,
    reportingManagerId: manager._id,
    isActive: true,
    ...overrides,
  });
}

function row(rowNumber, data) {
  return { rowNumber, data };
}

const baseCreate = (overrides = {}) => ({
  firstName: 'Kenny',
  lastName: 'Henkin',
  email: nextEmail('kenny'),
  mobile: nextMobile(),
  role: 'Employee',
  department: 'Development',
  designation: 'SDE',
  reportingManagerEmail: 'rita.manager@bulk.test',
  joiningDate: '2026-08-27',
  isActive: 'TRUE',
  ...overrides,
});

const createdBy = () => new mongoose.Types.ObjectId();

test('update path is keyed by email and applies mutable changes', async () => {
  const existing = await seedUser({ designation: 'Old Title' });
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', designation: 'New Title', joiningDate: '2024-06-01' })],
    createdBy(),
  );

  assert.equal(results[0].status, 'updated');
  assert.ok(results[0].changedFields.some((change) => change.field === 'designation'));
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.designation, 'New Title');
});



test('unknown email creates with auto code and Firstname@Code password', async () => {
  const { results } = await importEmployeesFromRowsUpsert([row(6, baseCreate())], createdBy());

  assert.equal(results[0].status, 'created');
  assert.match(results[0].employeeCode, /^EMP\d+$/);
  assert.equal(results[0].generatedPassword, `Kenny@${results[0].employeeCode}`);
  const stored = await User.findOne({ email: results[0].email }).lean();
  assert.ok(await bcrypt.compare(results[0].generatedPassword, stored.passwordHash));
  assert.equal(stored.pin4Hash, null);
  assert.equal(stored.roleId.toString(), roles.employee._id.toString());
  assert.equal(stored.isActive, true);
});

test('bulk create flags forced password change and emails credentials', async () => {
  clearTestEmailOutbox();
  const { results, summary } = await importEmployeesFromRowsUpsert([row(6, baseCreate())], createdBy());

  assert.equal(results[0].status, 'created');
  assert.equal(results[0].emailStatus, 'sent');
  assert.equal(summary.emailsSent, 1);
  assert.equal(summary.emailsFailed, 0);
  assert.match(results[0].message, /emailed/);
  const stored = await User.findOne({ email: results[0].email }).lean();
  assert.equal(stored.mustChangePassword, true);
  assert.equal(stored.forcePasswordChange, true, 'new bulk accounts gate via both flags');
  assert.equal(testEmailOutbox.length, 1);
  assert.equal(testEmailOutbox[0].to, results[0].email);
  assert.equal(testEmailOutbox[0].tag, 'welcome-credentials');
  assert.ok(testEmailOutbox[0].subject.includes('Welcome'));
  assert.ok(String(testEmailOutbox[0].text).includes(results[0].generatedPassword));
  assert.ok(String(testEmailOutbox[0].text).includes('/login'));
});

test('dry-run preview computes diffs without writing, emailing, or flagging', async () => {
  clearTestEmailOutbox();
  const existing = await seedUser({ designation: 'Old Title' });
  const newEmail = nextEmail('preview');
  const preview = await importEmployeesFromRowsUpsert(
    [
      row(6, { email: existing.email, lastName: 'User', designation: 'New Title', joiningDate: '2024-06-01' }),
      row(7, baseCreate({ email: newEmail })),
    ],
    createdBy(),
    { dryRun: true },
  );

  assert.equal(preview.preview, true);
  const updateRow = preview.results.find((item) => item.rowNumber === 6);
  const createRow = preview.results.find((item) => item.rowNumber === 7);
  assert.equal(updateRow.status, 'updated');
  assert.ok(updateRow.changedFields.some((change) => change.field === 'designation'));
  assert.equal(createRow.status, 'created');
  assert.equal(createRow.preview, true);
  assert.equal(createRow.generatedPassword, null);
  assert.equal(preview.summary.updated, 1);
  assert.equal(preview.summary.created, 1);
  assert.equal(preview.summary.emailsSent, 0);

  // Nothing persisted: no designation change, no new user, no flag, no email.
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.designation, 'Old Title');
  assert.equal(await User.countDocuments({}), 2);
  assert.equal(await User.countDocuments({ mustChangePassword: true }), 0);
  assert.equal(testEmailOutbox.length, 0);
});

test('bulk update sends no welcome email', async () => {
  clearTestEmailOutbox();
  const existing = await seedUser({ designation: 'Old Title' });
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', designation: 'New Title', joiningDate: '2024-06-01' })],
    createdBy(),
  );

  assert.equal(results[0].status, 'updated');
  assert.equal(results[0].emailStatus, undefined);
  assert.equal(testEmailOutbox.length, 0);
});

test('filled employeeCode is honored and embedded in the password', async () => {
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, baseCreate({ employeeCode: 'TST001' }))],
    createdBy(),
  );

  assert.equal(results[0].status, 'created');
  assert.equal(results[0].employeeCode, 'TST001');
  assert.equal(results[0].generatedPassword, 'Kenny@TST001');
});

test('createEmployeeAndPassword returns employee plus plaintext exactly once', async () => {
  const { employee, generatedPassword } = await createEmployeeAndPassword(baseCreate(), createdBy());
  assert.ok(employee.id);
  assert.match(generatedPassword, /^Kenny@EMP\d+$/);
});

test('role accepts slugs and names, including admin', async () => {
  const hr = await importEmployeesFromRowsUpsert([row(6, baseCreate({ role: 'hr' }))], createdBy());
  assert.equal(hr.results[0].status, 'created');
  const hrStored = await User.findOne({ email: hr.results[0].email }).lean();
  assert.equal(hrStored.roleId.toString(), roles.hr._id.toString());

  const admin = await importEmployeesFromRowsUpsert(
    [row(7, baseCreate({ role: 'Admin' }))],
    createdBy(),
  );
  assert.equal(admin.results[0].status, 'created');
});

test('resolveRoleByNameOrSlug matches slug, name and multi-word names', async () => {
  assert.equal((await resolveRoleByNameOrSlug('employee')).slug, 'employee');
  assert.equal((await resolveRoleByNameOrSlug('HR')).slug, 'hr');
  assert.equal((await resolveRoleByNameOrSlug('Reporting Manager')).slug, 'reporting-manager');
  await assert.rejects(() => resolveRoleByNameOrSlug('Nope'), /not found/);
  await assert.rejects(() => resolveRoleByNameOrSlug(''), /required/);
});

test('create without role or email fails validation', async () => {
  const noRole = await importEmployeesFromRowsUpsert(
    [row(6, baseCreate({ role: '' }))],
    createdBy(),
  );
  assert.equal(noRole.results[0].status, 'validation_error');
  assert.match(noRole.results[0].message, /Role/);

  const noEmail = await importEmployeesFromRowsUpsert(
    [row(7, baseCreate({ email: '' }))],
    createdBy(),
  );
  assert.equal(noEmail.results[0].status, 'validation_error');
  assert.match(noEmail.results[0].message, /email/i);
});

test('duplicate email within file discards the second row', async () => {
  const data = baseCreate();
  const { results, summary } = await importEmployeesFromRowsUpsert(
    [row(6, data), row(7, { ...data, firstName: 'Other' })],
    createdBy(),
  );

  assert.equal(summary.created, 1);
  assert.equal(summary.duplicate, 1);
  assert.equal(results[1].status, 'duplicate');
});

test('malformed stored mobile is healed by a valid file replacement', async () => {
  const existing = await seedUser({ mobile: '96218.7158' });
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', mobile: '9876500101' })],
    createdBy(),
  );

  assert.equal(results[0].status, 'updated');
  assert.ok(results[0].changedFields.some((change) => change.field === 'mobile'));
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.mobile, '9876500101');
});

test('malformed stored mobile with a different invalid file value explains how to fix it', async () => {
  const existing = await seedUser({ mobile: '96218.7158' });
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', mobile: '12345' })],
    createdBy(),
  );

  assert.equal(results[0].status, 'validation_error');
  assert.match(results[0].message, /is invalid/);
  assert.match(results[0].message, /valid 10-digit mobile/);
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.mobile, '96218.7158');
});

test('re-upload of the same malformed stored digits is not an error', async () => {
  const existing = await seedUser({ mobile: '96218.7158' });
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', mobile: '962187158' })],
    createdBy(),
  );

  assert.equal(results[0].status, 'unchanged');
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.mobile, '96218.7158');
});

test('healing mobile to a number owned by someone else is rejected', async () => {
  const existing = await seedUser({ mobile: '96218.7158' });
  const other = await seedUser();
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', mobile: other.mobile })],
    createdBy(),
  );

  assert.equal(results[0].status, 'validation_error');
  assert.match(results[0].message, /already in use/);
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.mobile, '96218.7158');
});

test('formatting-only mobile difference is not an error', async () => {
  const existing = await seedUser({ mobile: '98765 43210' });
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', mobile: '9876543210' })],
    createdBy(),
  );

  assert.notEqual(results[0].status, 'validation_error');
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.mobile, '98765 43210');
});

test('mobile change on update is a validation error identifying the employee', async () => {
  const existing = await seedUser();
  const { results, summary } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', mobile: '9000000001' })],
    createdBy(),
  );

  assert.equal(results[0].status, 'validation_error');
  assert.match(results[0].message, /Mobile number cannot be changed via bulk upload/);
  assert.match(results[0].message, new RegExp(existing.email.replace('.', '\\.')));
  assert.equal(summary.validation_error, 1);
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.mobile, existing.mobile);
  assert.equal(refreshed.lastName, existing.lastName);
});

test('employeeCode change on update is applied when code is unique', async () => {
  const existing = await seedUser();
  const newCode = `TST${String(900 + sequence + 100)}`; // guaranteed unique
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', employeeCode: newCode })],
    createdBy(),
  );

  assert.equal(results[0].status, 'updated');
  assert.ok(results[0].changedFields.some((change) => change.field === 'employeeCode'));
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.employeeCode, newCode);
  assert.equal(refreshed.lastName, 'User');
});

test('employeeCode change on update fails when code is taken by another employee', async () => {
  const existing = await seedUser();
  const taken = await seedUser();
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', employeeCode: taken.employeeCode })],
    createdBy(),
  );

  assert.equal(results[0].status, 'validation_error');
  assert.match(results[0].message, /already used by another employee/);
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.employeeCode, existing.employeeCode);
  assert.equal(refreshed.lastName, existing.lastName);
});

test('role change on update is applied (only role is mutable)', async () => {
  const existing = await seedUser();
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', role: 'HR' })],
    createdBy(),
  );

  assert.equal(results[0].status, 'updated');
  assert.ok(results[0].changedFields.some((change) => change.field === 'role'));
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.roleId.toString(), roles.hr._id.toString());
});

test('update to reporting-manager role succeeds without managed departments', async () => {
  const existing = await seedUser();
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', role: 'Reporting Manager' })],
    createdBy(),
  );

  assert.equal(results[0].status, 'updated');
  assert.ok(results[0].changedFields.some((change) => change.field === 'role'));
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.roleId.toString(), roles.rm._id.toString());
  assert.equal(refreshed.role, 'admin');
});

test('update to employee role without a manager is rejected', async () => {
  const existing = await seedUser({ roleId: roles.hr._id, role: 'admin', reportingManagerId: null });
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: existing.email, lastName: 'User', role: 'Employee' })],
    createdBy(),
  );

  assert.equal(results[0].status, 'validation_error');
  assert.match(results[0].message, /Reporting manager is required/);
});

test('update to employee role with a manager in the same row succeeds', async () => {
  const existing = await seedUser({ roleId: roles.hr._id, role: 'admin', reportingManagerId: null });
  const { results } = await importEmployeesFromRowsUpsert(
    [
      row(6, {
        email: existing.email,
        lastName: 'User',
        role: 'Employee',
        reportingManagerEmail: 'rita.manager@bulk.test',
      }),
    ],
    createdBy(),
  );

  assert.equal(results[0].status, 'updated');
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.roleId.toString(), roles.employee._id.toString());
  assert.equal(refreshed.reportingManagerId.toString(), manager._id.toString());
});

test('admin matched by email stays blocked from bulk modification', async () => {
  const admin = await seedUser({ role: 'admin', roleId: roles.admin._id });
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: admin.email, designation: 'Hacker' })],
    createdBy(),
  );

  assert.equal(results[0].status, 'validation_error');
  assert.match(results[0].message, /cannot be modified via bulk import/);
});

test('new email with an already-used mobile is matched to existing and blocks email change', async () => {
  const existing = await seedUser();
  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, baseCreate({ mobile: existing.mobile }))],
    createdBy(),
  );

  assert.equal(results[0].status, 'validation_error');
  assert.match(results[0].message, /Email cannot be changed via bulk upload/);
  const refreshed = await User.findById(existing._id).lean();
  assert.equal(refreshed.email, existing.email);
});

test('directory export has the new 14-column layout with role and no secrets', async () => {
  await seedUser({ email: 'exported@bulk.test', roleId: roles.hr._id, role: 'employee' });
  await seedUser({ email: 'hidden.admin@bulk.test', role: 'admin', roleId: roles.admin._id });

  const buffer = await buildEmployeeDirectoryWorkbook();
  assert.ok(Buffer.isBuffer(buffer));
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('Employees');
  const headers = sheet.getRow(5).values.slice(1);

  assert.deepEqual(headers, [
    'firstName',
    'lastName',
    'email',
    'mobile',
    'employeeCode',
    'role',
    'department',
    'designation',
    'reportingManagerEmail',
    'reportingManagerCode',
    'joiningDate',
    'dateOfBirth',
    'endingDate',
    'isActive',
  ]);
  assert.ok(!headers.includes('id'));
  assert.ok(!headers.includes('password'));
  assert.ok(!headers.some((header) => /pin/i.test(header)));

  const emails = [];
  sheet.eachRow((rowValues, rowNumber) => {
    if (rowNumber >= 6) emails.push(rowValues.values[3]);
  });
  assert.ok(emails.includes('exported@bulk.test'));
  assert.ok(!emails.includes('hidden.admin@bulk.test'));

  const validations = sheet.dataValidations?.model ?? {};
  const hasRoleList = Object.values(validations).some((entry) =>
    String(entry.formulae?.[0] ?? '').includes('Employee'),
  );
  assert.ok(hasRoleList, 'role column should carry the dropdown validation list');
});

test('bulk create stores a resolvable department ref (no blank department downstream)', async () => {
  const { results } = await importEmployeesFromRowsUpsert([row(6, baseCreate())], createdBy());
  assert.equal(results[0].status, 'created');

  // Ref-only by design (legacy text is not stored); the UI resolves the
  // name from the Department master, so assert that exact read path.
  const stored = await User.findOne({ email: results[0].email })
    .populate('departmentId', 'name code')
    .lean();
  assert.equal(String(stored.departmentId?._id ?? stored.departmentId), department._id.toString());
  assert.equal(stored.departmentId?.name ?? stored.department ?? null, 'Development');
});

test('bulk update switching department keeps the ref resolvable', async () => {
  const { results: created } = await importEmployeesFromRowsUpsert([row(6, baseCreate())], createdBy());
  assert.equal(created[0].status, 'created');
  const UiUx = await Department.create({ name: 'UI/UX Designing', code: 'DES', isActive: true });

  const { results } = await importEmployeesFromRowsUpsert(
    [row(7, { email: created[0].email, department: 'UI/UX Designing' })],
    createdBy(),
  );
  assert.equal(results[0].status, 'updated');
  assert.ok(results[0].changedFields.some((change) => change.field === 'department'));

  const stored = await User.findOne({ email: created[0].email })
    .populate('departmentId', 'name code')
    .lean();
  assert.equal(String(stored.departmentId?._id ?? stored.departmentId), UiUx._id.toString());
  assert.equal(stored.departmentId?.name ?? stored.department ?? null, 'UI/UX Designing');
});

async function createScopedActor() {
  sequence += 1;
  return User.create({
    role: 'employee',
    roleId: roles.rm._id,
    firstName: 'Scope',
    lastName: 'Actor',
    name: 'Scope Actor',
    email: `scope.actor.${sequence}@bulk.test`,
    mobile: nextMobile(),
    passwordHash: 'hash',
    employeeCode: `SCP${String(800 + sequence)}`,
    departmentId: department._id,
    managedDepartmentIds: [department._id],
    reportingManagerId: manager._id,
    isActive: true,
  });
}

const SCOPED_PERMS = [PERMISSIONS.USERS_WRITE];

test('scoped uploader creates in-scope rows and rejects out-of-scope rows', async () => {
  const actor = await createScopedActor();
  const design = await Department.create({ name: 'Design', code: `DSG${sequence}`, isActive: true });
  const actorOpts = { actorId: actor._id.toString(), actorPermissions: SCOPED_PERMS };

  const { results } = await importEmployeesFromRowsUpsert(
    [
      row(6, baseCreate()),
      row(7, baseCreate({ department: 'Design' })),
    ],
    createdBy(),
    actorOpts,
  );

  assert.equal(results[0].status, 'created');
  const rejected = results.find((item) => item.rowNumber === 7);
  assert.equal(rejected.status, 'validation_error');
  assert.match(rejected.message, /outside your assigned scope/);
  assert.equal(await User.countDocuments({ departmentId: design._id }), 0);
});

test('scoped uploader cannot touch employees outside their scope', async () => {
  const actor = await createScopedActor();
  const design = await Department.create({ name: 'Design', code: `DSN${sequence}`, isActive: true });
  const outsider = await seedUser({ departmentId: design._id });

  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, { email: outsider.email, designation: 'New Title' })],
    createdBy(),
    { actorId: actor._id.toString(), actorPermissions: SCOPED_PERMS },
  );

  assert.equal(results[0].status, 'validation_error');
  assert.match(results[0].message, /outside your assigned scope/);
});

test('dry-run preview enforces scope exactly like sync', async () => {
  const actor = await createScopedActor();
  await Department.create({ name: 'Design', code: `DSP${sequence}`, isActive: true });

  const preview = await importEmployeesFromRowsUpsert(
    [row(6, baseCreate({ department: 'Design' }))],
    createdBy(),
    { dryRun: true, actorId: actor._id.toString(), actorPermissions: SCOPED_PERMS },
  );

  const previewRow = preview.results.find((item) => item.rowNumber === 6);
  assert.equal(previewRow.status, 'validation_error');
  assert.match(previewRow.message, /outside your assigned scope/);
});

test('read-all actor bypasses department scope', async () => {
  const actor = await createScopedActor();
  await Department.create({ name: 'Design', code: `DSB${sequence}`, isActive: true });

  const { results } = await importEmployeesFromRowsUpsert(
    [row(6, baseCreate({ department: 'Design' }))],
    createdBy(),
    { actorId: actor._id.toString(), actorPermissions: [PERMISSIONS.ATTENDANCE_READ_ALL] },
  );

  assert.equal(results[0].status, 'created');
});
