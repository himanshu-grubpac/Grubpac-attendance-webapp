import { describe, it, expect } from 'vitest';
import { summarizeAttendanceCells } from '../pages/admin/AdminAttendance.jsx';

const WEEK_DAYS = ['2026-09-14', '2026-09-15', '2026-09-16'];

function row(...kinds) {
  return {
    cells: kinds.map((kind) =>
      kind === 'present:late'
        ? { kind: 'present', warningTag: 'W1', statusTag: null }
        : kind === 'present:hd'
          ? { kind: 'present', warningTag: null, statusTag: 'HD' }
          : { kind },
    ),
  };
}

describe('summarizeAttendanceCells', () => {
  it('counts day-cells across the whole week, skipping non-working kinds', () => {
    const rows = [
      row('present', 'absent', 'present:late'),
      row('leave', 'pending', 'rejected'),
      row('weekend', 'holiday', 'future'),
      row('present:hd', 'absent', 'absent'),
    ];

    // Note: `rejected` counts as a working slot (like the original loop)
    // without incrementing present/absent.
    expect(summarizeAttendanceCells(rows, WEEK_DAYS, null)).toEqual({
      present: 3,
      absent: 3,
      late: 1,
      halfDay: 1,
      workingSlots: 7,
    });
  });

  it('narrows every counter to the selected day', () => {
    const rows = [
      row('present', 'absent', 'present:late'),
      row('present:hd', 'absent', 'absent'),
    ];

    expect(summarizeAttendanceCells(rows, WEEK_DAYS, '2026-09-16')).toEqual({
      present: 1,
      absent: 1,
      late: 1,
      halfDay: 0,
      workingSlots: 2,
    });
  });

  it('returns zeros for a day outside the week', () => {
    const rows = [row('present', 'present', 'present')];

    expect(summarizeAttendanceCells(rows, WEEK_DAYS, '2026-09-20')).toEqual({
      present: 0,
      absent: 0,
      late: 0,
      halfDay: 0,
      workingSlots: 0,
    });
  });
});
