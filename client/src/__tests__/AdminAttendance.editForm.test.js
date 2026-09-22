import { describe, it, expect } from 'vitest';
import {
  buildAttendanceEditFormDefaults,
  shouldIncludeAbsentStatusOption,
} from '../pages/admin/AdminAttendance.jsx';

const POLICY = { officeStartTime: '09:30' };

describe('buildAttendanceEditFormDefaults', () => {
  it('leaves status blank for pending days with no attendance record', () => {
    const form = buildAttendanceEditFormDefaults({ kind: 'pending' }, { policy: POLICY });
    expect(form.statusCode).toBe('');
    expect(form.checkInTime).toBe('09:30');
  });

  it('leaves status blank for past absent days without a check-in record', () => {
    const form = buildAttendanceEditFormDefaults({ kind: 'absent' }, { policy: POLICY });
    expect(form.statusCode).toBe('');
  });

  it('prefills existing present status when editing a check-in record', () => {
    const form = buildAttendanceEditFormDefaults(
      {
        kind: 'present',
        checkInRecord: {
          timestamp: '2026-09-22T03:45:00.000Z',
          attendanceTag: 'HD',
          attendanceMode: 'office',
          lateNote: 'Traffic',
        },
        checkOutRecord: null,
      },
      { policy: POLICY },
    );
    expect(form.statusCode).toBe('HD');
    expect(form.lateNote).toBe('Traffic');
  });

  it('prefills absent status for admin-marked absent records', () => {
    const form = buildAttendanceEditFormDefaults(
      {
        kind: 'absent',
        adminMarkedAbsent: true,
        checkInRecordId: 'rec-1',
        checkInRecord: { attendanceMode: 'wfh', lateNote: '' },
      },
      { policy: POLICY },
    );
    expect(form.statusCode).toBe('A');
    expect(form.checkInTime).toBe('');
  });
});

describe('shouldIncludeAbsentStatusOption', () => {
  it('includes absent for pending create and existing present edits', () => {
    expect(shouldIncludeAbsentStatusOption({ isCreate: true, cellKind: 'pending' })).toBe(true);
    expect(
      shouldIncludeAbsentStatusOption({
        checkInRecordId: 'rec-1',
        adminMarkedAbsent: false,
        cellKind: 'present',
      }),
    ).toBe(true);
  });

  it('does not include absent when no edit target', () => {
    expect(shouldIncludeAbsentStatusOption(null)).toBe(false);
  });
});
