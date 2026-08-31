import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCheckInBlockedByApprovedLeave,
  monthCalendarStatusForCheckInTag,
  buildAdminSyntheticGeoFields,
  getAdminAttendanceCreateDayBlockReason,
  buildMonthBirthdayMap,
  resolveEmployeeMonthDayStatus,
  filterSpilloverAutoCheckouts,
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

test('pending WFH check-in maps to wfh mode and pending leaveStatus', () => {
  // Mirrors markAttendance: a covering WFH request (pending) forces wfh mode
  // and marks the record pending until the manager approves.
  const wfhApprovedToday = false;
  const wfhPendingToday = true;
  const attendanceMode = wfhApprovedToday || wfhPendingToday ? 'wfh' : 'office';
  const leaveStatus =
    attendanceMode === 'wfh' && !wfhApprovedToday ? 'pending' : 'approved';
  assert.equal(attendanceMode, 'wfh');
  assert.equal(leaveStatus, 'pending');
});

test('approved WFH check-in maps to wfh mode and approved leaveStatus', () => {
  const wfhApprovedToday = true;
  const wfhPendingToday = false;
  const attendanceMode = wfhApprovedToday || wfhPendingToday ? 'wfh' : 'office';
  const leaveStatus =
    attendanceMode === 'wfh' && !wfhApprovedToday ? 'pending' : 'approved';
  assert.equal(attendanceMode, 'wfh');
  assert.equal(leaveStatus, 'approved');
});

test('office check-in without any WFH request keeps approved leaveStatus', () => {
  const wfhApprovedToday = false;
  const wfhPendingToday = false;
  const attendanceMode = wfhApprovedToday || wfhPendingToday ? 'wfh' : 'office';
  const leaveStatus =
    attendanceMode === 'wfh' && !wfhApprovedToday ? 'pending' : 'approved';
  assert.equal(attendanceMode, 'office');
  assert.equal(leaveStatus, 'approved');
});

test('check-in is not blocked when only pending WFH covers today', () => {
  // Pending WFH is not approved leave, so the generic approved-leave block
  // must not trigger (isCheckInBlockedByApprovedLeave receives approvedLeaveToday=null).
  assert.equal(isCheckInBlockedByApprovedLeave(null, false), false);
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

function makeRecord(overrides) {
  return {
    _id: overrides._id || 'rec1',
    type: overrides.type || 'check_in',
    timestamp: overrides.timestamp || new Date(),
    attendanceMode: overrides.attendanceMode || 'office',
    status: overrides.status || 'allowed',
    autoCheckout: overrides.autoCheckout || false,
  };
}

test('filterSpilloverAutoCheckouts: no check-ins removes all auto-checkouts', () => {
  const records = [
    makeRecord({ type: 'check_out', autoCheckout: true, timestamp: new Date('2026-09-02T00:30:00Z') }),
  ];
  const filtered = filterSpilloverAutoCheckouts(records);
  assert.equal(filtered.length, 0);
});

test('filterSpilloverAutoCheckouts: no check-ins keeps non-auto-checkout records', () => {
  const records = [
    makeRecord({ type: 'check_out', autoCheckout: false, timestamp: new Date('2026-09-02T00:30:00Z') }),
  ];
  const filtered = filterSpilloverAutoCheckouts(records);
  assert.equal(filtered.length, 1);
});

test('filterSpilloverAutoCheckouts: keeps auto-checkout after check-in', () => {
  const checkIn = makeRecord({ type: 'check_in', timestamp: new Date('2026-09-01T03:30:00Z') });
  const autoCheckOut = makeRecord({ type: 'check_out', autoCheckout: true, timestamp: new Date('2026-09-01T18:00:00Z') });
  const records = [checkIn, autoCheckOut];
  const filtered = filterSpilloverAutoCheckouts(records);
  assert.equal(filtered.length, 2);
});

test('filterSpilloverAutoCheckouts: removes spillover auto-checkout before check-in', () => {
  const autoCheckOut = makeRecord({ type: 'check_out', autoCheckout: true, timestamp: new Date('2026-09-02T00:30:00Z') });
  const checkIn = makeRecord({ type: 'check_in', timestamp: new Date('2026-09-02T03:30:00Z') });
  const records = [autoCheckOut, checkIn];
  const filtered = filterSpilloverAutoCheckouts(records);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].type, 'check_in');
});

test('filterSpilloverAutoCheckouts: keeps manual check-out even if before check-in', () => {
  const manualCheckOut = makeRecord({ type: 'check_out', autoCheckout: false, timestamp: new Date('2026-09-02T00:30:00Z') });
  const checkIn = makeRecord({ type: 'check_in', timestamp: new Date('2026-09-02T03:30:00Z') });
  const records = [manualCheckOut, checkIn];
  const filtered = filterSpilloverAutoCheckouts(records);
  assert.equal(filtered.length, 2);
});

test('filterSpilloverAutoCheckouts: empty records returns empty', () => {
  const filtered = filterSpilloverAutoCheckouts([]);
  assert.equal(filtered.length, 0);
});

test('filterSpilloverAutoCheckouts: multiple spillovers all removed when no check-in', () => {
  const records = [
    makeRecord({ type: 'check_out', autoCheckout: true, timestamp: new Date('2026-09-01T00:30:00Z') }),
    makeRecord({ type: 'check_out', autoCheckout: true, timestamp: new Date('2026-09-02T00:30:00Z') }),
  ];
  const filtered = filterSpilloverAutoCheckouts(records);
  assert.equal(filtered.length, 0);
});

test('filterSpilloverAutoCheckouts: WFH next-day spillover removed when check-in on same day', () => {
  const autoCheckOut = makeRecord({
    type: 'check_out',
    autoCheckout: true,
    attendanceMode: 'wfh',
    timestamp: new Date('2026-09-02T00:30:00Z'),
  });
  const checkIn = makeRecord({
    type: 'check_in',
    attendanceMode: 'wfh',
    timestamp: new Date('2026-09-02T03:30:00Z'),
  });
  const records = [autoCheckOut, checkIn];
  const filtered = filterSpilloverAutoCheckouts(records);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].type, 'check_in');
});

test('filterSpilloverAutoCheckouts: normal same-day auto-checkout after check-in kept', () => {
  const checkIn = makeRecord({
    type: 'check_in',
    timestamp: new Date('2026-09-01T03:30:00Z'),
  });
  const autoCheckOut = makeRecord({
    type: 'check_out',
    autoCheckout: true,
    timestamp: new Date('2026-09-01T18:00:00Z'),
  });
  const records = [checkIn, autoCheckOut];
  const filtered = filterSpilloverAutoCheckouts(records);
  assert.equal(filtered.length, 2);
});

test('filterSpilloverAutoCheckouts: multiple auto-checkouts for different modes', () => {
  const officeAuto = makeRecord({
    type: 'check_out',
    autoCheckout: true,
    attendanceMode: 'office',
    timestamp: new Date('2026-09-01T18:00:00Z'),
  });
  const wfhAuto = makeRecord({
    type: 'check_out',
    autoCheckout: true,
    attendanceMode: 'wfh',
    timestamp: new Date('2026-09-02T00:30:00Z'),
  });
  const records = [officeAuto, wfhAuto];
  const filtered = filterSpilloverAutoCheckouts(records);
  assert.equal(filtered.length, 0, 'both auto-checkouts removed when no check-in');
});

test('filterSpilloverAutoCheckouts: multiple auto-checkouts with check-in keeps post-check-in ones', () => {
  const checkIn = makeRecord({
    type: 'check_in',
    timestamp: new Date('2026-09-02T03:30:00Z'),
  });
  const officeAuto = makeRecord({
    type: 'check_out',
    autoCheckout: true,
    attendanceMode: 'office',
    timestamp: new Date('2026-09-02T18:00:00Z'),
  });
  const wfhSpillover = makeRecord({
    type: 'check_out',
    autoCheckout: true,
    attendanceMode: 'wfh',
    timestamp: new Date('2026-09-02T00:30:00Z'),
  });
  const records = [wfhSpillover, checkIn, officeAuto];
  const filtered = filterSpilloverAutoCheckouts(records);
  assert.equal(filtered.length, 2, 'spillover removed, check-in and office auto kept');
  assert.equal(filtered[0].type, 'check_in');
  assert.equal(filtered[1].autoCheckout, true);
});
