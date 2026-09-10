import assert from 'node:assert/strict';
import test from 'node:test';
import { canGrantLeaveException } from './leaveService.js';
import { SYSTEM_ROLE_SLUGS } from '../../../shared/permissions.js';

function userWithRoleSlug(slug) {
  return {
    _id: '507f1f77bcf86cd799439011',
    roleId: { _id: '507f1f77bcf86cd799439099', slug, permissions: [] },
  };
}

test('canGrantLeaveException allows admin role slug', () => {
  assert.equal(canGrantLeaveException(userWithRoleSlug(SYSTEM_ROLE_SLUGS.ADMIN)), true);
});

test('canGrantLeaveException allows HR role slug', () => {
  assert.equal(canGrantLeaveException(userWithRoleSlug(SYSTEM_ROLE_SLUGS.HR)), true);
});

test('canGrantLeaveException denies reporting-manager role slug', () => {
  assert.equal(
    canGrantLeaveException(userWithRoleSlug(SYSTEM_ROLE_SLUGS.REPORTING_MANAGER)),
    false,
  );
});

test('canGrantLeaveException denies employee role slug', () => {
  assert.equal(
    canGrantLeaveException(userWithRoleSlug(SYSTEM_ROLE_SLUGS.EMPLOYEE)),
    false,
  );
});

test('canGrantLeaveException ignores coarse legacy role field', () => {
  // Legacy `user.role` is 'admin' for reporting managers too — the gate must
  // not admit them. Only the role slug counts.
  assert.equal(
    canGrantLeaveException({ _id: 'x', role: 'admin', roleId: { slug: 'reporting-manager' } }),
    false,
  );
  assert.equal(
    canGrantLeaveException({ _id: 'x', role: 'admin', roleId: { slug: 'hr' } }),
    true,
  );
});

test('canGrantLeaveException fails closed on missing/unpopulated role', () => {
  assert.equal(canGrantLeaveException({ _id: 'x', roleId: null }), false);
  assert.equal(canGrantLeaveException({ _id: 'x' }), false);
  assert.equal(
    canGrantLeaveException({ _id: 'x', roleId: '507f1f77bcf86cd799439099' }),
    false,
  );
  assert.equal(canGrantLeaveException(null), false);
  assert.equal(canGrantLeaveException(undefined), false);
});
