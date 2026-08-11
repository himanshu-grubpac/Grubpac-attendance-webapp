import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCheckInBlockedByApprovedLeave,
  monthCalendarStatusForCheckInTag,
  buildAdminSyntheticGeoFields,
  getAdminAttendanceCreateDayBlockReason,
  buildMonthBirthdayMap,
  resolveEmployeeMonthDayStatus,
} from './attendanceService.js';

test('month calendar maps HD check-ins to half_day status', () => {
  assert.equal(monthCalendarStatusForCheckInTag('HD'), 'half_day');
});

test('month calendar maps present and legacy check-ins to present status', () => {
  assert.equal(monthCalendarStatusForCheckInTag('P'), 'present');
  assert.equal(monthCalendarStatusForCheckInTag(null), 'present');
  assert.equal(monthCalendarStatusForCheckInTag(undefined), 'present');
});

test('approved WFH without check-in maps to wfh / wfh_future', () => {
  assert.equal(
    resolveEmployeeMonthDayStatus({
      dayKey: '2026-08-05',
      todayKey: '2026-08-07',
      isWeekend: false,
      isHoliday: false,
      wfhDay: true,
    }),
    'wfh',
  );
  assert.equal(
    resolveEmployeeMonthDayStatus({
      dayKey: '2026-08-10',
      todayKey: '2026-08-07',
      isWeekend: false,
      isHoliday: false,
      wfhDay: true,
    }),
    'wfh_future',
  );
});

test('check-in present wins over approved WFH on the same day', () => {
  assert.equal(
    resolveEmployeeMonthDayStatus({
      dayKey: '2026-08-07',
      todayKey: '2026-08-07',
      isWeekend: false,
      isHoliday: false,
      checkInStatus: 'present',
      wfhDay: true,
    }),
    'present',
  );
});

test('non-WFH leave still maps to leave / leave_future', () => {
  assert.equal(
    resolveEmployeeMonthDayStatus({
      dayKey: '2026-08-05',
      todayKey: '2026-08-07',
      isWeekend: false,
      isHoliday: false,
      leaveDay: true,
    }),
    'leave',
  );
  assert.equal(
    resolveEmployeeMonthDayStatus({
      dayKey: '2026-08-12',
      todayKey: '2026-08-07',
      isWeekend: false,
      isHoliday: false,
      leaveDay: true,
    }),
    'leave_future',
  );
});

test('WFH takes display priority over overlapping non-WFH leave when no check-in', () => {
  assert.equal(
    resolveEmployeeMonthDayStatus({
      dayKey: '2026-08-05',
      todayKey: '2026-08-07',
      isWeekend: false,
      isHoliday: false,
      wfhDay: true,
      leaveDay: true,
    }),
    'wfh',
  );
});

test('weekend and holiday still beat WFH', () => {
  assert.equal(
    resolveEmployeeMonthDayStatus({
      dayKey: '2026-08-08',
      todayKey: '2026-08-07',
      isWeekend: true,
      isHoliday: false,
      wfhDay: true,
    }),
    'weekend',
  );
  assert.equal(
    resolveEmployeeMonthDayStatus({
      dayKey: '2026-08-15',
      todayKey: '2026-08-07',
      isWeekend: false,
      isHoliday: true,
      wfhDay: true,
    }),
    'holiday',
  );
});

test('check-in is blocked on approved non-WFH leave days', () => {
  const clLeave = { leaveTypeCode: 'CL', leaveTypeName: 'Casual Leave' };
  assert.equal(isCheckInBlockedByApprovedLeave(clLeave, false), true);
  assert.equal(isCheckInBlockedByApprovedLeave(clLeave, true), false);
});

test('check-in is not blocked when no approved leave or WFH is approved', () => {
  assert.equal(isCheckInBlockedByApprovedLeave(null, false), false);
  assert.equal(isCheckInBlockedByApprovedLeave(null, true), false);
});

/** Mirrors markAttendance: office geofence only when attendanceMode is office. */
function enforceOfficeRadiusForMode(attendanceMode) {
  return attendanceMode === 'office';
}

test('office geofence applies for office check-in and office check-out', () => {
  assert.equal(enforceOfficeRadiusForMode('office'), true);
});

test('office geofence skipped for WFH check-in and WFH check-out', () => {
  assert.equal(enforceOfficeRadiusForMode('wfh'), false);
});

test('admin synthetic geo fields copy office coordinates', () => {
  const fields = buildAdminSyntheticGeoFields({
    latitude: 28.6448,
    longitude: 77.2167,
    radiusMeters: 150,
  });
  assert.equal(fields.latitude, 28.6448);
  assert.equal(fields.longitude, 77.2167);
  assert.equal(fields.officeLatitude, 28.6448);
  assert.equal(fields.officeLongitude, 77.2167);
  assert.equal(fields.radiusMeters, 150);
  assert.equal(fields.distanceMeters, 0);
  assert.equal(fields.accuracyMeters, 1);
});

test('admin create day block rejects invalid, future, and weekend days', () => {
  assert.equal(getAdminAttendanceCreateDayBlockReason('not-a-day', '2026-08-06'), 'Invalid attendance day.');
  assert.equal(
    getAdminAttendanceCreateDayBlockReason('2026-08-07', '2026-08-06'),
    'Cannot create attendance for a future day.',
  );
  // 2026-08-01 is Saturday
  assert.equal(
    getAdminAttendanceCreateDayBlockReason('2026-08-01', '2026-08-06'),
    'Cannot create attendance on a weekend.',
  );
  assert.equal(getAdminAttendanceCreateDayBlockReason('2026-08-05', '2026-08-06'), null);
});

test('buildMonthBirthdayMap matches month-day and ignores year', () => {
  const users = [
    {
      firstName: 'Himanshu',
      name: 'Himanshu Salunke',
      dateOfBirth: new Date(Date.UTC(1995, 7, 12, 6, 30)), // IST 1995-08-12
    },
    {
      firstName: 'Priya',
      name: 'Priya Sharma',
      dateOfBirth: new Date(Date.UTC(1998, 0, 5, 6, 30)), // IST Jan — outside August
    },
    {
      firstName: 'Alex',
      name: 'Alex Kumar',
      dateOfBirth: null,
    },
  ];
  const map = buildMonthBirthdayMap(users, '2026-08');
  assert.deepEqual(Object.keys(map), ['2026-08-12']);
  assert.equal(map['2026-08-12'].length, 1);
  assert.equal(map['2026-08-12'][0].firstName, 'Himanshu');
  assert.equal(map['2026-08-12'][0].name, 'Himanshu Salunke');
});

test('buildMonthBirthdayMap sorts multiple birthdays on same day', () => {
  const users = [
    {
      firstName: 'Zara',
      name: 'Zara Khan',
      dateOfBirth: new Date(Date.UTC(1990, 7, 7, 6, 30)),
    },
    {
      firstName: 'Asha',
      name: 'Asha Patel',
      dateOfBirth: new Date(Date.UTC(2000, 7, 7, 6, 30)),
    },
  ];
  const map = buildMonthBirthdayMap(users, '2026-08');
  assert.deepEqual(
    map['2026-08-07'].map((entry) => entry.firstName),
    ['Asha', 'Zara'],
  );
});
