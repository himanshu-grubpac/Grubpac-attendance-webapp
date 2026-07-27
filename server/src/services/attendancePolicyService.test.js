import assert from 'node:assert/strict';
import test from 'node:test';
import {
  derivePolicyFromSettings,
  parseStatusCodeToPolicyFields,
  statusCodeFromRecord,
} from './attendancePolicyService.js';

const policy = {
  graceThresholdTime: '09:00',
  halfDayThresholdTime: '10:00',
  warningsPerQuarter: 3,
};

function istTime(hour, minute) {
  return new Date(`2026-07-24T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`);
}

test('late check-in with warnings remaining receives the next quarterly warning and full-day credit', () => {
  assert.deepEqual(derivePolicyFromSettings(istTime(9, 20), policy, 0), {
    statusTag: 'P',
    warningTag: 'W1',
  });
});

test('check-in at the half-day threshold is Half Day', () => {
  assert.deepEqual(derivePolicyFromSettings(istTime(10, 0), policy, 0), {
    statusTag: 'HD',
    warningTag: null,
  });
});

test('late check-in after all quarterly warnings are used is Leave Violation (LV)', () => {
  assert.deepEqual(derivePolicyFromSettings(istTime(9, 20), policy, 3), {
    statusTag: 'LV',
    warningTag: null,
  });
});

test('parseStatusCodeToPolicyFields maps warning codes to stored policy fields', () => {
  assert.deepEqual(parseStatusCodeToPolicyFields('W2'), {
    attendanceTag: 'P',
    warningIssued: true,
    quarterWarningIndex: 2,
  });
  assert.deepEqual(parseStatusCodeToPolicyFields('HD'), {
    attendanceTag: 'HD',
    warningIssued: false,
    quarterWarningIndex: null,
  });
});

test('statusCodeFromRecord reconstructs admin edit status codes', () => {
  assert.equal(
    statusCodeFromRecord({ attendanceTag: 'P', warningIssued: true, quarterWarningIndex: 3 }),
    'W3',
  );
  assert.equal(statusCodeFromRecord({ attendanceTag: 'LV', warningIssued: false }), 'LV');
});
