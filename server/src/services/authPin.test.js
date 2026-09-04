import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adminResetPinSchema,
  pinSchema,
  setPinSchema,
} from '../../../shared/validation/auth.js';

test('pinSchema accepts exactly 4 digits', () => {
  assert.equal(pinSchema.safeParse('1234').success, true);
});

test('pinSchema rejects 6-digit PINs (retired)', () => {
  const result = pinSchema.safeParse('123456');
  assert.equal(result.success, false);
  assert.match(result.error.issues[0].message, /exactly 4 digits/);
});

test('pinSchema rejects non-4-digit input', () => {
  for (const value of ['123', '12345', 'abcd', '12a4', '']) {
    assert.equal(pinSchema.safeParse(value).success, false, `should reject ${JSON.stringify(value)}`);
  }
});

test('adminResetPinSchema accepts a matching 4-digit pair', () => {
  const result = adminResetPinSchema.safeParse({ newPin: '4321', confirmPin: '4321' });
  assert.equal(result.success, true);
});

test('adminResetPinSchema rejects 6-digit PINs and mismatches', () => {
  assert.equal(
    adminResetPinSchema.safeParse({ newPin: '123456', confirmPin: '123456' }).success,
    false,
  );
  assert.equal(
    adminResetPinSchema.safeParse({ newPin: '1234', confirmPin: '4321' }).success,
    false,
  );
});

test('setPinSchema accepts a 4-digit PIN with confirmation', () => {
  const result = setPinSchema.safeParse({
    pin: '7890',
    confirmPin: '7890',
    currentPassword: 'SomePass1',
  });
  assert.equal(result.success, true);
});
