import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { Department } from '../models/Department.js';
import { prepareEmployeeReferences } from './userOrgService.js';

let memoryServer;
let sequence = 0;

before(async () => {
  memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await memoryServer.waitUntilRunning();
  await mongoose.connect(memoryServer.getUri(), { maxPoolSize: 1 });
});

beforeEach(async () => {
  await Department.deleteMany({});
});

after(async () => {
  await mongoose.disconnect();
  await memoryServer.stop();
});

async function createDepartment(name = 'Development') {
  sequence += 1;
  return Department.create({ name, code: `TST${sequence}`, isActive: true });
}

test('reporting manager with own department but no managed list gets own department', async () => {
  const dept = await createDepartment();
  const prepared = await prepareEmployeeReferences(
    { department: 'Development' },
    { roleSlug: 'reporting-manager', hasDepartments: true },
  );
  assert.equal(prepared.departmentId, dept._id.toString());
  assert.deepEqual(prepared.managedDepartmentIds, [dept._id.toString()]);
});

test('non-manager role never gets an implicit managed list', async () => {
  await createDepartment();
  const prepared = await prepareEmployeeReferences(
    { department: 'Development' },
    { roleSlug: 'employee', hasDepartments: true },
  );
  assert.equal(prepared.departmentId !== undefined, true);
  assert.equal(prepared.managedDepartmentIds ?? null, null);
});

test('explicit managed list is left untouched', async () => {
  const dept = await createDepartment();
  const other = await createDepartment('Quality');
  const prepared = await prepareEmployeeReferences(
    { department: 'Development', managedDepartmentIds: [other._id.toString()] },
    { roleSlug: 'reporting-manager', hasDepartments: true },
  );
  assert.deepEqual(prepared.managedDepartmentIds, [other._id.toString()]);
  assert.equal(prepared.departmentId, dept._id.toString());
});

test('reporting manager with neither department nor managed list stays empty (validation still rejects)', async () => {
  const prepared = await prepareEmployeeReferences(
    {},
    { roleSlug: 'reporting-manager', hasDepartments: true },
  );
  assert.equal(prepared.managedDepartmentIds ?? null, null);
});
