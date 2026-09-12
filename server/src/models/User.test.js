import assert from 'node:assert/strict';
import test from 'node:test';
import { canViewSalaryFields } from '../../../shared/permissions.js';
import { User } from './User.js';

function buildUserDoc() {
  return new User({
    email: 'salary.test@grubpac.com',
    passwordHash: 'x',
    role: 'employee',
    isActive: true,
    firstName: 'Salary',
    name: 'Salary Test',
    mobile: '9000000001',
    employeeCode: 'SAL001',
    monthlySalary: 85000,
    salaryEffectiveFrom: new Date('2026-04-01T00:00:00.000Z'),
  });
}

test('toSafeJSON strips salary fields by default (secure)', () => {
  const json = buildUserDoc().toSafeJSON();
  assert.equal('monthlySalary' in json, false);
  assert.equal('salaryEffectiveFrom' in json, false);
  assert.equal('salaryCurrency' in json, false);
  // Non-salary fields are unaffected.
  assert.equal(json.email, 'salary.test@grubpac.com');
  assert.equal(json.employeeCode, 'SAL001');
});

test('toSafeJSON keeps salary fields when canViewSalary is true', () => {
  const json = buildUserDoc().toSafeJSON({ canViewSalary: true });
  assert.equal(json.monthlySalary, 85000);
  assert.ok(json.salaryEffectiveFrom);
  assert.equal(json.salaryCurrency, 'INR');
});

test('canViewSalaryFields mirrors the salary column rule', () => {
  assert.equal(canViewSalaryFields(['salary.read']), true);
  assert.equal(canViewSalaryFields(['salary.read_team']), true);
  assert.equal(canViewSalaryFields(['users.read']), false);
  assert.equal(canViewSalaryFields([]), false);
  assert.equal(canViewSalaryFields(undefined), false);
});
