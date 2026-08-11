import assert from 'node:assert/strict';
import test from 'node:test';
import {
  derivePolicyFromSettings,
  isExhaustionRelatedLv,
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

test('isExhaustionRelatedLv matches late window used by evaluateCheckInPolicy for LV', () => {
  assert.equal(isExhaustionRelatedLv(istTime(9, 20), policy), true);
  assert.equal(isExhaustionRelatedLv(istTime(9, 1), policy), true);
  assert.equal(isExhaustionRelatedLv(istTime(9, 0), policy), false);
  assert.equal(isExhaustionRelatedLv(istTime(10, 0), policy), false);
  assert.equal(isExhaustionRelatedLv(istTime(10, 15), policy), false);
});

test('isExhaustionRelatedLv ignores weekend check-ins', () => {
  // 2026-07-25 is Saturday in IST
  const saturdayLate = new Date('2026-07-25T09:20:00+05:30');
  assert.equal(isExhaustionRelatedLv(saturdayLate, policy, [0, 6]), false);
});

test('reset semantics: warning fields clear leaves P tag; exhaustion LV is reclassifiable to P', () => {
  const warningRecord = {
    attendanceTag: 'P',
    warningIssued: true,
    quarterWarningIndex: 2,
  };
  const cleared = {
    ...warningRecord,
    warningIssued: false,
    quarterWarningIndex: null,
  };
  assert.equal(statusCodeFromRecord(cleared), 'P');

  const exhaustionLv = {
    attendanceTag: 'LV',
    warningIssued: false,
    quarterWarningIndex: null,
    timestamp: istTime(9, 25),
  };
  assert.equal(isExhaustionRelatedLv(exhaustionLv.timestamp, policy), true);
  assert.equal(
    statusCodeFromRecord({
      attendanceTag: 'P',
      warningIssued: false,
      quarterWarningIndex: null,
    }),
    'P',
  );

  const adminLvOutsideWindow = {
    attendanceTag: 'LV',
    warningIssued: false,
    quarterWarningIndex: null,
    timestamp: istTime(8, 30),
  };
  assert.equal(isExhaustionRelatedLv(adminLvOutsideWindow.timestamp, policy), false);
});
